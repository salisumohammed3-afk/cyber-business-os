import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Emergency stop: cancels all running/pending/proposed tasks for a company.
// The runner checks task status and exits when it sees "cancelled".
// The worker skips tasks that aren't in pending status when claiming.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl =
    process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey)
    return res.status(500).json({ error: "Supabase not configured" });

  const { company_id, conversation_id, include_proposed = true } = req.body || {};
  if (!company_id)
    return res.status(400).json({ error: "company_id is required" });

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Target statuses to cancel
  const cancelStatuses = ["running", "pending"];
  if (include_proposed) cancelStatuses.push("proposed");

  try {
    // Fetch matching tasks first so we can report what was cancelled
    const { data: toCancel, error: fetchErr } = await supabase
      .from("tasks")
      .select("id, title, status")
      .eq("company_id", company_id)
      .in("status", cancelStatuses);

    if (fetchErr) {
      return res.status(500).json({ error: fetchErr.message });
    }

    if (!toCancel?.length) {
      return res.status(200).json({
        cancelled: 0,
        message: "No active tasks to cancel",
      });
    }

    // Bulk update to cancelled
    const nowIso = new Date().toISOString();
    const { error: updateErr } = await supabase
      .from("tasks")
      .update({
        status: "cancelled",
        completed_at: nowIso,
        error_message: "Cancelled by user (emergency stop)",
      })
      .eq("company_id", company_id)
      .in("status", cancelStatuses);

    if (updateErr) {
      return res.status(500).json({ error: updateErr.message });
    }

    // Log the stop event for each task
    const logs = toCancel.map(t => ({
      task_id: t.id,
      message: `Task cancelled by emergency stop (was ${t.status})`,
      source: "cancel-all",
      log_type: "task_cancelled",
      company_id,
    }));
    if (logs.length) {
      await supabase.from("terminal_logs").insert(logs);
    }

    // Post a chat message so the user can talk to the system about next steps
    let convId = conversation_id;
    if (!convId) {
      const { data: conv } = await supabase
        .from("conversations")
        .select("id")
        .eq("company_id", company_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      convId = conv?.id;
    }

    if (convId) {
      const taskList = toCancel
        .slice(0, 10)
        .map(t => `\u2022 ${t.title} (was ${t.status})`)
        .join("\n");
      const more = toCancel.length > 10 ? `\n\n...and ${toCancel.length - 10} more` : "";

      await supabase.from("chat_messages").insert({
        conversation_id: convId,
        role: "system",
        kind: "work_order_status",
        content: `\uD83D\uDED1 **All work halted.** Cancelled ${toCancel.length} task(s):\n\n${taskList}${more}\n\nTell me what to do next — I'll wait for your instructions.`,
        timestamp: nowIso,
        metadata: {
          kind: "work_order_status",
          status: "cancelled",
          source: "emergency_stop",
          cancelled_count: toCancel.length,
        },
      });
    }

    return res.status(200).json({
      cancelled: toCancel.length,
      tasks: toCancel.map(t => ({ id: t.id, title: t.title, was_status: t.status })),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("cancel-all error:", msg);
    return res.status(500).json({ error: msg });
  }
}
