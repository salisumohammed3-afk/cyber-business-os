import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { validateCadence, computeNextRun, describeCadence } from "./lib/schedule.mjs";

// Schedules: recurring policies the user has approved. Each row clones its
// work_order_template into a fresh tasks row when next_run_at <= now (worker poll).
//
// Routes:
//   GET    /api/schedules?company_id=...      list schedules
//   POST   /api/schedules                      create from approved proposal
//   PATCH  /api/schedules?id=...               toggle is_active, edit name/cadence
//   DELETE /api/schedules?id=...               remove
//   POST   /api/schedules?id=X&action=run-now  fire immediately (test button)

interface CreatePayload {
  company_id: string;
  conversation_id?: string;
  name: string;
  description?: string;
  cadence_type: string;
  cadence_spec: Record<string, unknown>;
  work_order_template: Record<string, unknown>;
}

const VALID_WORK_ORDER_TYPES = [
  "research",
  "build_static_site",
  "edit_project",
  "send_outreach",
  "design_mockup",
  "meeting_admin",
  "summary",
];

function validateWorkOrderTemplate(t: Record<string, unknown>): string | null {
  if (!t || typeof t !== "object") return "work_order_template must be an object";
  if (typeof t.type !== "string" || !VALID_WORK_ORDER_TYPES.includes(t.type)) {
    return `work_order_template.type must be one of: ${VALID_WORK_ORDER_TYPES.join(", ")}`;
  }
  if (typeof t.title !== "string" || !t.title.trim()) return "work_order_template.title is required";
  if (typeof t.description !== "string" || !t.description.trim())
    return "work_order_template.description is required";
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey)
    return res.status(500).json({ error: "Supabase not configured" });
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // ── List ────────────────────────────────────────────────────────────────
    if (req.method === "GET") {
      const company_id = String(req.query.company_id || "");
      if (!company_id) return res.status(400).json({ error: "company_id is required" });
      const { data, error } = await supabase
        .from("scheduled_tasks")
        .select("*")
        .eq("company_id", company_id)
        .order("created_at", { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      const enriched = (data || []).map((row: Record<string, unknown>) => ({
        ...row,
        cadence_human: describeCadence(row.cadence_type as string, row.cadence_spec as Record<string, unknown>),
      }));
      return res.status(200).json({ schedules: enriched });
    }

    // ── Run-now ─────────────────────────────────────────────────────────────
    if (req.method === "POST" && req.query.action === "run-now") {
      const id = String(req.query.id || "");
      if (!id) return res.status(400).json({ error: "id is required" });
      const { data: row, error } = await supabase
        .from("scheduled_tasks")
        .select("*")
        .eq("id", id)
        .single();
      if (error || !row) return res.status(404).json({ error: "Schedule not found" });

      // Pull agent_definition_id for the work_order_template's agent
      const tmpl = row.work_order_template as Record<string, unknown>;
      const agentSlug = (tmpl.agent as string) || agentForType(tmpl.type as string);
      const { data: agentDef } = await supabase
        .from("agent_definitions")
        .select("id")
        .eq("slug", agentSlug)
        .eq("company_id", row.company_id)
        .maybeSingle();

      const { data: taskRow, error: insErr } = await supabase
        .from("tasks")
        .insert({
          company_id: row.company_id,
          agent_definition_id: agentDef?.id || null,
          status: "pending",
          title: tmpl.title,
          description: tmpl.description,
          source: "scheduled",
          input_data: { instruction: tmpl.description, context: `Manual run-now of schedule "${row.name}"` },
          metadata: {
            work_order: {
              type: tmpl.type,
              agent: agentSlug,
              estimated_cost_usd: defaultCostCap(tmpl.type as string),
              estimated_minutes: defaultTimeCap(tmpl.type as string),
              output_target: defaultOutputTarget(tmpl.type as string),
              preflight: [],
            },
            scheduled_task_id: id,
            run_kind: "manual",
          },
        })
        .select("id")
        .single();
      if (insErr) return res.status(500).json({ error: insErr.message });

      await supabase
        .from("scheduled_tasks")
        .update({ last_run_at: new Date().toISOString(), last_run_task_id: taskRow.id, total_fires: row.total_fires + 1 })
        .eq("id", id);

      return res.status(200).json({ ok: true, task_id: taskRow.id });
    }

    // ── Create ──────────────────────────────────────────────────────────────
    if (req.method === "POST") {
      const body = (req.body || {}) as Partial<CreatePayload>;
      const { company_id, name, cadence_type, cadence_spec, work_order_template } = body;
      if (!company_id) return res.status(400).json({ error: "company_id is required" });
      if (!name) return res.status(400).json({ error: "name is required" });
      if (!cadence_type || !cadence_spec)
        return res.status(400).json({ error: "cadence_type and cadence_spec are required" });
      if (!work_order_template)
        return res.status(400).json({ error: "work_order_template is required" });

      const cadErr = validateCadence(cadence_type, cadence_spec);
      if (cadErr) return res.status(400).json({ error: `Invalid cadence: ${cadErr}` });
      const woErr = validateWorkOrderTemplate(work_order_template);
      if (woErr) return res.status(400).json({ error: woErr });

      let nextRun: Date;
      try {
        nextRun = computeNextRun(cadence_type, cadence_spec, new Date());
      } catch (e: unknown) {
        const m = e instanceof Error ? e.message : String(e);
        return res.status(400).json({ error: `Cadence cannot compute next run: ${m}` });
      }

      const { data, error } = await supabase
        .from("scheduled_tasks")
        .insert({
          company_id,
          name: String(name).slice(0, 100),
          description: body.description ? String(body.description).slice(0, 500) : null,
          cadence_type,
          cadence_spec,
          work_order_template,
          is_active: true,
          next_run_at: nextRun.toISOString(),
          created_by_conversation_id: body.conversation_id || null,
        })
        .select("*")
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({
        schedule: {
          ...data,
          cadence_human: describeCadence(cadence_type, cadence_spec),
        },
      });
    }

    // ── Update (pause/resume/rename) ────────────────────────────────────────
    if (req.method === "PATCH") {
      const id = String(req.query.id || "");
      if (!id) return res.status(400).json({ error: "id is required" });
      const updates: Record<string, unknown> = {};
      const body = (req.body || {}) as Record<string, unknown>;
      if (typeof body.is_active === "boolean") updates.is_active = body.is_active;
      if (typeof body.name === "string") updates.name = body.name.slice(0, 100);
      if (typeof body.description === "string") updates.description = body.description.slice(0, 500);
      if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Nothing to update" });
      const { data, error } = await supabase
        .from("scheduled_tasks")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ schedule: data });
    }

    // ── Delete ──────────────────────────────────────────────────────────────
    if (req.method === "DELETE") {
      const id = String(req.query.id || "");
      if (!id) return res.status(400).json({ error: "id is required" });
      const { error } = await supabase.from("scheduled_tasks").delete().eq("id", id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("schedules error:", msg);
    return res.status(500).json({ error: msg });
  }
}

// ── Helpers shared with quick-reply (kept duplicated to avoid import cycles) ─

function agentForType(t: string): string {
  switch (t) {
    case "research": return "research";
    case "build_static_site":
    case "edit_project": return "engineering";
    case "send_outreach": return "growth";
    case "design_mockup": return "designer";
    case "meeting_admin": return "executive-assistant";
    case "summary": return "orchestrator";
    default: return "orchestrator";
  }
}

function defaultCostCap(t: string): number {
  return ({ research: 0.5, build_static_site: 2.0, edit_project: 1.5, send_outreach: 0.5, design_mockup: 1.0, meeting_admin: 0.3, summary: 0.2 } as Record<string, number>)[t] || 0.5;
}

function defaultTimeCap(t: string): number {
  return ({ research: 5, build_static_site: 15, edit_project: 10, send_outreach: 5, design_mockup: 10, meeting_admin: 5, summary: 3 } as Record<string, number>)[t] || 5;
}

function defaultOutputTarget(t: string): string {
  return ({ research: "memo", build_static_site: "project", edit_project: "project", send_outreach: "email_draft", design_mockup: "mockup_file", meeting_admin: "calendar_event", summary: "memo" } as Record<string, string>)[t] || "memo";
}
