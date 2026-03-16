import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: "Supabase credentials not configured" });
  }
  if (!anthropicKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { task_id, conversation_id } = req.body;
    if (!task_id || !conversation_id) {
      return res.status(400).json({ error: "task_id and conversation_id are required" });
    }

    // 1. Read the task
    const { data: task, error: taskErr } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", task_id)
      .single();
    if (taskErr) return res.status(404).json({ error: `Task not found: ${taskErr.message}` });

    // Mark task as running
    await supabase
      .from("tasks")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", task_id);

    // 2. Read agent definition for system prompt and model
    let systemPrompt =
      "You are the Orchestrator of a Cyber Business Operating System — the CEO's right-hand AI. " +
      "Be direct and concise. Use bullet points for lists. Lead with the headline. Default to action over analysis.";
    let model = "claude-sonnet-4-20250514";

    if (task.agent_definition_id) {
      const { data: agentDef } = await supabase
        .from("agent_definitions")
        .select("*")
        .eq("id", task.agent_definition_id)
        .single();
      if (agentDef) {
        systemPrompt = agentDef.system_prompt || systemPrompt;
        model = agentDef.model || model;
      }
    }

    // 3. Read conversation history
    const { data: history } = await supabase
      .from("chat_messages")
      .select("role, content")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: true });

    const messages = (history ?? []).map((m: { role: string; content: string }) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content || "",
    }));

    // 4. Call Anthropic
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 4096, system: systemPrompt, messages }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      await supabase
        .from("tasks")
        .update({
          status: "failed",
          error_message: errBody,
          completed_at: new Date().toISOString(),
        })
        .eq("id", task_id);
      return res.status(502).json({ error: `Anthropic API error: ${errBody}` });
    }

    const anthropicData = await anthropicRes.json();
    const assistantContent =
      anthropicData.content
        ?.filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("") || "I received your message but had no response.";

    // 5. Insert assistant reply
    const { error: insertErr } = await supabase.from("chat_messages").insert({
      conversation_id,
      role: "orchestrator",
      content: assistantContent,
      timestamp: new Date().toISOString(),
      metadata: {
        model,
        usage: anthropicData.usage,
        stop_reason: anthropicData.stop_reason,
      },
    });

    if (insertErr) {
      await supabase
        .from("tasks")
        .update({
          status: "failed",
          error_message: insertErr.message,
          completed_at: new Date().toISOString(),
        })
        .eq("id", task_id);
      return res.status(500).json({ error: `Failed to save reply: ${insertErr.message}` });
    }

    // 6. Mark task completed
    await supabase
      .from("tasks")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", task_id);

    return res.status(200).json({ ok: true, content: assistantContent });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Internal server error";
    return res.status(500).json({ error: message });
  }
}
