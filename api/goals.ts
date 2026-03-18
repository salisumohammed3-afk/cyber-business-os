import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

function getSupabase() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

  if (req.method === "GET") {
    const companyId = req.query.company_id as string;
    if (!companyId) return res.status(400).json({ error: "company_id query param required" });

    const { data, error } = await supabase
      .from("company_goals")
      .select("*")
      .eq("company_id", companyId)
      .order("priority", { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === "POST") {
    const { company_id, title, description, target_metric, target_value, current_value, timeframe, priority } = req.body || {};
    if (!company_id || !title) return res.status(400).json({ error: "company_id and title required" });

    const { data, error } = await supabase
      .from("company_goals")
      .insert({ company_id, title, description, target_metric, target_value, current_value: current_value || 0, timeframe, priority: priority || 5 })
      .select("*")
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  if (req.method === "PATCH") {
    const { id, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });

    fields.updated_at = new Date().toISOString();
    const { data, error } = await supabase
      .from("company_goals")
      .update(fields)
      .eq("id", id)
      .select("*")
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });

    const { error } = await supabase.from("company_goals").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
