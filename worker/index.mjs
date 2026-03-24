// worker/index.mjs — Railway task queue worker
// Polls Supabase for pending tasks and executes them via runner.mjs
import { fork } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const RUNNER_PATH = join(__dirname, "..", "api", "agent-scripts", "runner.mjs");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "5000", 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "2", 10);
const STUCK_TIMEOUT_MIN = parseInt(process.env.STUCK_TIMEOUT_MIN || "65", 10);
const TASK_WORKDIR_ROOT = process.env.TASK_WORKDIR || "/tmp/agent-tasks";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_KEY are required");
  process.exit(1);
}

const activeTasks = new Map(); // taskId -> child process

// ── Supabase helpers ────────────────────────────────────────────────────────

async function sbFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...opts.headers,
  };
  const resp = await fetch(url, { ...opts, headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Supabase ${resp.status}: ${body.slice(0, 200)}`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

async function sbSelect(table, filters = {}, extra = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) params.set(k, v);
  if (extra.select) params.set("select", extra.select);
  if (extra.order) params.set("order", extra.order);
  if (extra.limit) params.set("limit", String(extra.limit));
  return sbFetch(`${table}?${params}`, { method: "GET" });
}

async function sbUpdate(table, data, filters = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) params.set(k, v);
  return sbFetch(`${table}?${params}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    headers: { Prefer: "return=representation" },
  });
}

async function sbInsert(table, data) {
  return sbFetch(table, {
    method: "POST",
    body: JSON.stringify(data),
    headers: { Prefer: "return=representation" },
  });
}

async function termLog(message, opts = {}) {
  try {
    await sbInsert("terminal_logs", {
      message,
      source: "railway-worker",
      task_id: opts.taskId || null,
      log_type: opts.logType || "info",
      company_id: opts.companyId || null,
    });
  } catch {}
  console.log(`[${opts.logType || "info"}] ${message}`);
}

// ── Stuck task recovery ─────────────────────────────────────────────────────

async function recoverStuckTasks() {
  const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MIN * 60 * 1000).toISOString();
  try {
    const stuck = await sbSelect("tasks", {
      status: "eq.running",
      "started_at": `lt.${cutoff}`,
    }, { select: "id,metadata", limit: 20 });

    if (!stuck?.length) return;

    for (const task of stuck) {
      if (activeTasks.has(task.id)) continue; // still running locally

      const meta = task.metadata || {};
      const retries = meta.retry_count || 0;
      const hasCheckpoint = !!meta.checkpoint;

      if (hasCheckpoint && retries < 2) {
        await sbUpdate("tasks", {
          status: "pending",
          started_at: null,
          error_message: null,
          metadata: { ...meta, retry_count: retries + 1 },
        }, { id: `eq.${task.id}` });
        await termLog(`Auto-retrying stuck task ${task.id.slice(0, 8)} (retry ${retries + 1}/2)`, {
          taskId: task.id, logType: "auto_retry",
        });
      } else {
        await sbUpdate("tasks", {
          status: "failed",
          error_message: "Timed out" + (retries > 0 ? ` after ${retries} retries` : ""),
          completed_at: new Date().toISOString(),
        }, { id: `eq.${task.id}` });
        await termLog(`Marked stuck task ${task.id.slice(0, 8)} as failed`, {
          taskId: task.id, logType: "stuck_failed",
        });
      }
    }
  } catch (e) {
    console.error("Stuck recovery error:", e.message);
  }
}

// ── Claim and run a task ────────────────────────────────────────────────────

async function claimTask() {
  // Atomically claim one pending task
  const pending = await sbSelect("tasks", {
    status: "eq.pending",
  }, { select: "id,conversation_id", order: "priority.desc,created_at.asc", limit: 1 });

  if (!pending?.length) return null;

  const task = pending[0];

  // Ensure a conversation exists
  let conversationId = task.conversation_id;
  if (!conversationId) {
    const conv = await sbInsert("conversations", {
      title: task.id.slice(0, 8) + " task",
    });
    if (conv?.[0]?.id) {
      conversationId = conv[0].id;
      await sbUpdate("tasks", { conversation_id: conversationId }, { id: `eq.${task.id}` });
    }
  }

  // Try to claim it (CAS: only update if still pending)
  const claimed = await sbUpdate("tasks", {
    status: "running",
    started_at: new Date().toISOString(),
  }, { id: `eq.${task.id}`, status: "eq.pending" });

  if (!claimed?.length) return null; // someone else claimed it

  return { taskId: task.id, conversationId };
}

function runTask(taskId, conversationId) {
  const workdir = join(TASK_WORKDIR_ROOT, taskId);
  if (!existsSync(workdir)) mkdirSync(workdir, { recursive: true });

  const env = {
    ...process.env,
    TASK_ID: taskId,
    CONVERSATION_ID: conversationId,
    TASK_WORKDIR: workdir,
  };

  const child = fork(RUNNER_PATH, [], {
    cwd: workdir,
    env,
    stdio: "pipe",
  });

  activeTasks.set(taskId, child);

  child.stdout?.on("data", (d) => process.stdout.write(`[${taskId.slice(0, 8)}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[${taskId.slice(0, 8)}] ${d}`));

  child.on("exit", (code) => {
    activeTasks.delete(taskId);
    // Clean up workdir
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
    console.log(`[${taskId.slice(0, 8)}] exited with code ${code}`);
  });

  child.on("error", (err) => {
    activeTasks.delete(taskId);
    console.error(`[${taskId.slice(0, 8)}] process error:`, err.message);
  });

  return child;
}

// ── Main poll loop ──────────────────────────────────────────────────────────

let running = true;
let pollCount = 0;

async function poll() {
  // Recover stuck tasks every 10th poll
  if (pollCount % 10 === 0) {
    await recoverStuckTasks();
  }
  pollCount++;

  if (activeTasks.size >= MAX_CONCURRENT) return;

  const slots = MAX_CONCURRENT - activeTasks.size;
  for (let i = 0; i < slots; i++) {
    try {
      const claimed = await claimTask();
      if (!claimed) break; // no more pending tasks
      await termLog(`Claimed task ${claimed.taskId.slice(0, 8)}, starting runner`, {
        taskId: claimed.taskId, logType: "worker_claimed",
      });
      runTask(claimed.taskId, claimed.conversationId);
    } catch (e) {
      console.error("Poll error:", e.message);
      break;
    }
  }
}

async function main() {
  console.log("Railway worker starting...");
  console.log(`  Poll interval: ${POLL_INTERVAL}ms`);
  console.log(`  Max concurrent: ${MAX_CONCURRENT}`);
  console.log(`  Stuck timeout: ${STUCK_TIMEOUT_MIN}min`);
  console.log(`  Runner: ${RUNNER_PATH}`);

  if (!existsSync(TASK_WORKDIR_ROOT)) mkdirSync(TASK_WORKDIR_ROOT, { recursive: true });

  await termLog("Railway worker started", { logType: "worker_start" });

  while (running) {
    try {
      await poll();
    } catch (e) {
      console.error("Poll loop error:", e.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down...");
  running = false;
  await termLog("Railway worker shutting down (SIGTERM)", { logType: "worker_stop" });
  // Give running tasks 30s to finish
  if (activeTasks.size > 0) {
    console.log(`Waiting for ${activeTasks.size} active task(s)...`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
  process.exit(0);
});

process.on("SIGINT", () => {
  running = false;
  process.exit(0);
});

main().catch((e) => {
  console.error("Worker fatal:", e);
  process.exit(1);
});
