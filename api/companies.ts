import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const OWNER_ID = "00000000-0000-0000-0000-000000000000";

function getSupabase() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mirrorAgents(supabase: any, companyId: string) {
  const { data: templates } = await supabase
    .from("base_agent_definitions")
    .select("*");

  if (!templates?.length) return [];

  const createdAgents: Array<{ id: string; slug: string }> = [];

  for (const tpl of templates) {
    const { data: agent, error } = await supabase
      .from("agent_definitions")
      .insert({
        company_id: companyId,
        name: tpl.name,
        slug: tpl.slug,
        description: tpl.description,
        system_prompt: tpl.system_prompt,
        model: tpl.model,
        allowed_tools: tpl.allowed_tools,
        is_orchestrator: tpl.is_orchestrator,
        max_turns: tpl.max_turns,
        temperature: tpl.temperature,
      })
      .select("id, slug")
      .single();

    if (error || !agent) continue;
    createdAgents.push(agent);

    // Clone default tools from the QTA company's matching agent as reference
    const { data: sourceAgent } = await supabase
      .from("agent_definitions")
      .select("id")
      .eq("slug", tpl.slug)
      .neq("company_id", companyId)
      .limit(1)
      .single();

    if (sourceAgent) {
      const { data: sourceTools } = await supabase
        .from("agent_tools")
        .select("tool_name, tool_type, connection_source, composio_action_id, tool_schema, config, is_enabled")
        .eq("agent_id", sourceAgent.id)
        .eq("is_enabled", true);

      if (sourceTools?.length) {
        const toolRows = sourceTools.map((t) => ({
          agent_id: agent.id,
          tool_name: t.tool_name,
          tool_type: t.tool_type,
          connection_source: t.connection_source,
          composio_action_id: t.composio_action_id,
          tool_schema: t.tool_schema,
          config: t.config,
          is_enabled: t.is_enabled,
        }));
        await supabase.from("agent_tools").insert(toolRows);
      }
    }
  }

  return createdAgents;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

  // Route: GET /api/companies
  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("companies")
      .select("*")
      .eq("is_active", true)
      .order("name");

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  // Route: POST /api/companies
  if (req.method === "POST") {
    const { name, brief, goals } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });

    const slug = slugify(name);

    const { data: company, error: companyErr } = await supabase
      .from("companies")
      .insert({ owner_id: OWNER_ID, name, slug, brief: brief || {} })
      .select("*")
      .single();

    if (companyErr) return res.status(500).json({ error: companyErr.message });

    const agents = await mirrorAgents(supabase, company.id);

    // Create initial goals if provided
    if (goals?.length) {
      for (const g of goals) {
        await supabase.from("company_goals").insert({
          company_id: company.id,
          title: g.title,
          description: g.description,
          target_metric: g.target_metric,
          target_value: g.target_value,
          current_value: g.current_value || 0,
          timeframe: g.timeframe,
          priority: g.priority || 5,
        });
      }
    }

    return res.status(201).json({ company, agents });
  }

  // Route: PATCH /api/companies (body: { id, ...fields })
  if (req.method === "PATCH") {
    const { id, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ error: "id is required" });

    const { data, error } = await supabase
      .from("companies")
      .update(fields)
      .eq("id", id)
      .select("*")
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  // Route: DELETE /api/companies (body: { id })
  if (req.method === "DELETE") {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "id is required" });

    const { error } = await supabase
      .from("companies")
      .update({ is_active: false })
      .eq("id", id);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
