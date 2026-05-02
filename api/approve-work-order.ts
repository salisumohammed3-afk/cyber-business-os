import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Approve a proposed work order. Flips the task from 'proposed' to 'pending'
// and posts a status chat message so the user sees what's happening.
// The Railway worker picks up pending tasks; the runner reads
// metadata.work_order.type to lock its tool set (Stage 3).

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

  const { task_id, action } = req.body || {};
  if (!task_id || !action)
    return res.status(400).json({ error: "task_id and action are required" });
  if (action !== "approve" && action !== "cancel")
    return res.status(400).json({ error: "action must be 'approve' or 'cancel'" });

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { data: task, error: fetchErr } = await supabase
      .from("tasks")
      .select("id, status, title, conversation_id, company_id, metadata")
      .eq("id", task_id)
      .maybeSingle();

    if (fetchErr || !task) {
      return res.status(404).json({ error: "Task not found" });
    }

    if (task.status !== "proposed") {
      return res.status(409).json({
        error: `Cannot ${action} a task in status '${task.status}'. Only proposed tasks can be approved or cancelled here.`,
      });
    }

    // Preflight gate: if any required integration is missing, refuse approval.
    if (action === "approve") {
      const meta = (task.metadata || {}) as Record<string, unknown>;
      const wo = (meta.work_order || {}) as Record<string, unknown>;
      const preflight = (wo.preflight || []) as Array<{ tool: string; status: string }>;
      const missing = preflight.filter(p => p.status === "missing").map(p => p.tool);
      if (missing.length > 0) {
        return res.status(412).json({
          error: `Missing integrations: ${missing.join(", ")}. Connect them in Integrations and try again.`,
          missing,
        });
      }
    }

    const nowIso = new Date().toISOString();

    if (action === "approve") {
      const { error: updateErr } = await supabase
        .from("tasks")
        .update({
          status: "pending",
          started_at: null,
          error_message: null,
        })
        .eq("id", task_id)
        .eq("status", "proposed"); // CAS: only flip if still proposed
      if (updateErr) return res.status(500).json({ error: updateErr.message });

      if (task.conversation_id) {
        await supabase.from("chat_messages").insert({
          conversation_id: task.conversation_id,
          role: "system",
          content: `▶ Approved: "${task.title}". Running now.`,
          timestamp: nowIso,
          metadata: {
            kind: "work_order_status",
            status: "approved",
            task_id,
          },
        });
      }

      return res.status(200).json({ ok: true, status: "pending" });
    }

    // action === "cancel"
    const { error: cancelErr } = await supabase
      .from("tasks")
      .update({
        status: "cancelled",
        completed_at: nowIso,
        error_message: "Cancelled by user before approval",
      })
      .eq("id", task_id)
      .eq("status", "proposed");
    if (cancelErr) return res.status(500).json({ error: cancelErr.message });

    if (task.conversation_id) {
      await supabase.from("chat_messages").insert({
        conversation_id: task.conversation_id,
        role: "system",
        content: `Cancelled: "${task.title}".`,
        timestamp: nowIso,
        metadata: {
          kind: "work_order_status",
          status: "cancelled",
          task_id,
        },
      });
    }

    return res.status(200).json({ ok: true, status: "cancelled" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("approve-work-order error:", msg);
    return res.status(500).json({ error: msg });
  }
}
