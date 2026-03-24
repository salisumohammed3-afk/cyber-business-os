import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Thin trigger: validates the task and sets it to pending.
// The Railway worker polls for pending tasks and executes them.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: "Supabase not configured" });

  const { task_id, conversation_id: bodyConvId } = req.body || {};
  if (!task_id) return res.status(400).json({ error: "task_id is required" });

  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data: task, error: taskErr } = await supabase
    .from("tasks")
    .select("id, conversation_id, status")
    .eq("id", task_id)
    .single();

  if (taskErr || !task) return res.status(404).json({ error: `Task not found: ${taskErr?.message}` });

  // Ensure a conversation exists
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

  // Set to pending if not already runnable — the Railway worker picks it up
  if (task.status === "proposed" || task.status === "failed") {
    await supabase.from("tasks").update({
      status: "pending",
      started_at: null,
      error_message: null,
    }).eq("id", task_id);
  }

  return res.status(202).json({ ok: true, status: "queued", task_id });
}
