import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { Sandbox } from "@vercel/sandbox";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const maxDuration = 120;

let _runnerScript: string | null = null;

function resolveRunnerPath(): string {
  // Vercel bundles functions with @vercel/nft — try common locations
  const tries: string[] = [];

  // In Vercel's lambda: files are relative to the function directory
  // The function is api/run-agent.js, so agent-scripts/ is a sibling
  try {
    const { dirname } = require("node:path") as typeof import("node:path");
    const { fileURLToPath } = require("node:url") as typeof import("node:url");
    const dir = dirname(fileURLToPath(import.meta.url));
    tries.push(join(dir, "agent-scripts", "runner.mjs"));
  } catch { /* ESM resolution not available */ }

  tries.push(
    join(process.cwd(), "api", "agent-scripts", "runner.mjs"),
    "/var/task/api/agent-scripts/runner.mjs",
    "/vercel/path0/api/agent-scripts/runner.mjs",
  );

  for (const p of tries) {
    try { if (existsSync(p)) return p; } catch { /* skip */ }
  }

  throw new Error("runner.mjs not found. Tried: " + tries.join(", "));
}

function getRunnerScript(): string {
  if (_runnerScript) return _runnerScript;
  const path = resolveRunnerPath();
  _runnerScript = readFileSync(path, "utf-8");
  return _runnerScript;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>;

async function termLog(
  supabase: AnySupabase,
  message: string,
  opts: { taskId?: string; logType?: string; companyId?: string } = {},
) {
  try {
    await supabase.from("terminal_logs").insert({
      message,
      source: "run-agent-handler",
      task_id: opts.taskId || null,
      log_type: opts.logType || "info",
      company_id: opts.companyId || null,
    });
  } catch {}
}

async function startSandbox(
  taskId: string,
  conversationId: string,
  supabase: AnySupabase,
) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || "";
  const selfUrl = "https://cyber-business-os.vercel.app";

  try {
    await termLog(supabase, `Creating sandbox for task ${taskId.slice(0, 8)}...`, { taskId, logType: "sandbox_create" });

    const sandbox = await Sandbox.create({
      runtime: "node22",
      timeout: 600_000,
    });

    await termLog(supabase, `Sandbox ${sandbox.sandboxId} created. Writing runner script...`, { taskId, logType: "sandbox_ready" });

    await sandbox.writeFiles([
      { path: "runner.mjs", content: Buffer.from(getRunnerScript()) },
    ]);

    const env: Record<string, string> = {
      TASK_ID: taskId,
      CONVERSATION_ID: conversationId,
      SUPABASE_URL: supabaseUrl,
      SUPABASE_KEY: supabaseKey,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
      SERPER_API_KEY: process.env.SERPER_API_KEY || "",
      COMPOSIO_API_KEY: process.env.COMPOSIO_API_KEY || "",
      PROJECTS_SUPABASE_URL: process.env.PROJECTS_SUPABASE_URL || "",
      PROJECTS_SUPABASE_KEY: process.env.PROJECTS_SUPABASE_SERVICE_KEY || "",
      SELF_URL: selfUrl,
    };

    await sandbox.runCommand({
      cmd: "node",
      args: ["runner.mjs"],
      env,
      detached: true,
    });

    await termLog(supabase, `Runner started in sandbox ${sandbox.sandboxId} (detached)`, { taskId, logType: "sandbox_started" });

    await supabase.from("tasks").update({
      metadata: { sandbox_id: sandbox.sandboxId },
    }).eq("id", taskId);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await termLog(supabase, `Sandbox failed: ${msg}`, { taskId, logType: "error" });

    await supabase.from("tasks").update({
      status: "failed",
      error_message: `Sandbox creation failed: ${msg.slice(0, 400)}`,
      completed_at: new Date().toISOString(),
    }).eq("id", taskId);

    await supabase.from("chat_messages").insert({
      conversation_id: conversationId,
      role: "orchestrator",
      content: "Something went wrong starting the agent. Please try again.",
      timestamp: new Date().toISOString(),
      metadata: { error: true, original_error: msg.slice(0, 400) },
    });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: "Supabase not configured" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { task_id, conversation_id: bodyConvId } = req.body || {};
  if (!task_id) return res.status(400).json({ error: "task_id is required" });

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Recover stuck tasks older than 12 minutes
  const stuckCutoff = new Date(Date.now() - 12 * 60 * 1000).toISOString();
  await supabase
    .from("tasks")
    .update({ status: "failed", error_message: "Timed out", completed_at: new Date().toISOString() })
    .eq("status", "running")
    .lt("started_at", stuckCutoff);

  const { data: task, error: taskErr } = await supabase
    .from("tasks")
    .select("id, conversation_id, status")
    .eq("id", task_id)
    .single();

  if (taskErr || !task) return res.status(404).json({ error: `Task not found: ${taskErr?.message}` });

  let conversation_id = bodyConvId || task.conversation_id;
  if (!conversation_id) {
    const { data: conv } = await supabase
      .from("conversations")
      .insert({ title: task_id.slice(0, 8) + " task" })
      .select("id")
      .single();
    if (!conv?.id) return res.status(500).json({ error: "Failed to create conversation" });
    conversation_id = conv.id;
    await supabase.from("tasks").update({ conversation_id }).eq("id", task_id);
  }

  const { data: updated } = await supabase
    .from("tasks")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", task_id)
    .in("status", ["pending"])
    .select("id");

  if (!updated?.length) {
    return res.status(409).json({ error: `Task not runnable (current: ${task.status})` });
  }

  res.status(202).json({ ok: true, status: "running", task_id });

  waitUntil(startSandbox(task_id, conversation_id, supabase));
}
