import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const WORKER_KEY = "railway_worker";
/** Consider worker healthy if heartbeat newer than this */
const STALE_AFTER_MS = 3 * 60 * 1000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(200).json({
      ok: true,
      supabase: "not_configured",
      worker: { alive: false, last_seen_at: null, age_seconds: null },
    });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await supabase
    .from("system_heartbeats")
    .select("last_seen_at, metadata")
    .eq("service_key", WORKER_KEY)
    .maybeSingle();

  if (error) {
    return res.status(200).json({
      ok: true,
      worker: { alive: false, last_seen_at: null, age_seconds: null, error: error.message },
    });
  }

  const lastStr = data?.last_seen_at as string | undefined;
  const last = lastStr ? new Date(lastStr).getTime() : 0;
  const ageMs = last > 0 ? Date.now() - last : null;
  const alive = ageMs !== null && ageMs < STALE_AFTER_MS;

  return res.status(200).json({
    ok: true,
    worker: {
      alive,
      last_seen_at: lastStr ?? null,
      age_seconds: ageMs !== null ? Math.round(ageMs / 1000) : null,
      metadata: data?.metadata ?? null,
    },
  });
}
