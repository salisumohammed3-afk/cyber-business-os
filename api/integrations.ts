import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  encryptCredentials,
  decryptCredentials,
  maskCredential,
  type EncryptedBlob,
} from "./lib/crypto";
import { getVendor, listVendors } from "./lib/vendor-registry";

// API Center backend.
//
// Routes:
//   GET    /api/integrations?company_id=...           list integrations for a company
//   GET    /api/integrations?vendors=1                list known vendors (registry)
//   POST   /api/integrations                          create OR upsert by (company_id, vendor)
//   PATCH  /api/integrations?id=...                   update credentials/config (re-encrypts)
//   DELETE /api/integrations?id=...                   remove integration
//   POST   /api/integrations?id=...&action=test       probe the credentials
//
// Credentials are encrypted at write time via api/lib/crypto. The frontend
// receives masked previews on read. The orchestrator's call_integration tool
// reads decrypted creds server-side only (Phase 3).

interface IntegrationRow {
  id: string;
  company_id: string;
  vendor: string;
  display_name: string;
  kind: string;
  auth_type: string;
  encrypted_credentials: EncryptedBlob | null;
  credential_preview: string | null;
  config: Record<string, unknown>;
  actions: unknown[];
  status: string;
  last_tested_at: string | null;
  last_test_error: string | null;
  created_at: string;
  updated_at: string;
}

function publicShape(row: IntegrationRow) {
  // Strip encrypted blob from anything we hand back to the frontend.
  return {
    id: row.id,
    company_id: row.company_id,
    vendor: row.vendor,
    display_name: row.display_name,
    kind: row.kind,
    auth_type: row.auth_type,
    credential_preview: row.credential_preview,
    config: row.config,
    actions: row.actions,
    status: row.status,
    last_tested_at: row.last_tested_at,
    last_test_error: row.last_test_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Build the headers an outbound request to the vendor needs, given a stored
// integration's auth_type + credentials and the registry's auth_header config.
async function buildAuthHeaders(row: IntegrationRow): Promise<Record<string, string>> {
  if (!row.encrypted_credentials) return {};
  const def = getVendor(row.vendor);
  if (!def) return {};
  const creds = decryptCredentials(row.encrypted_credentials);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (def.auth_header_name && def.auth_header_template) {
    let value = def.auth_header_template;
    for (const [k, v] of Object.entries(creds)) {
      value = value.replaceAll(`{{${k}}}`, String(v));
    }
    headers[def.auth_header_name] = value;
  }
  return headers;
}

async function probeIntegration(row: IntegrationRow): Promise<{
  ok: boolean;
  status: number;
  message: string;
}> {
  const def = getVendor(row.vendor);
  if (!def) {
    return { ok: false, status: 0, message: `Unknown vendor: ${row.vendor}` };
  }
  const baseUrl = (row.config?.base_url as string) || def.base_url;
  const url = baseUrl.replace(/\/$/, "") + def.test.path;
  let headers: Record<string, string>;
  try {
    headers = await buildAuthHeaders(row);
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, message: `Could not decrypt credentials: ${m}` };
  }
  try {
    const r = await fetch(url, {
      method: def.test.method,
      headers,
      // For POST probes, send empty body; vendors typically reply 400 (auth ok)
      body: def.test.method === "POST" ? "{}" : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const expected = def.test.expect_status ?? 200;
    if (r.status === expected || (expected === 200 && r.ok)) {
      return { ok: true, status: r.status, message: "Connection verified" };
    }
    if (r.status === 400 && def.test.expect_status === 400) {
      // Anthropic-style probes treat 400 as "auth ok"
      return { ok: true, status: 400, message: "Connection verified (probe returned expected 400)" };
    }
    if (r.status === 401 || r.status === 403) {
      const body = await r.text().catch(() => "");
      return {
        ok: false,
        status: r.status,
        message: `Authentication failed (${r.status}): ${body.slice(0, 200)}`,
      };
    }
    if (r.status === 429) {
      return { ok: false, status: 429, message: "Rate limited (429) — try again in a moment" };
    }
    const body = await r.text().catch(() => "");
    return { ok: false, status: r.status, message: `Unexpected status ${r.status}: ${body.slice(0, 200)}` };
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, message: `Could not reach vendor: ${m}` };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Vendor registry passthrough — used by the API Center to populate dropdowns.
  if (req.method === "GET" && (req.query.vendors === "1" || req.query.vendors === "true")) {
    return res.status(200).json({ vendors: listVendors() });
  }

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
        .from("integrations")
        .select("*")
        .eq("company_id", company_id)
        .order("created_at", { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({
        integrations: (data || []).map((r: IntegrationRow) => publicShape(r)),
      });
    }

    // ── Probe (test connection) ─────────────────────────────────────────────
    if (req.method === "POST" && req.query.action === "test") {
      const id = String(req.query.id || "");
      if (!id) return res.status(400).json({ error: "id is required" });
      const { data: row, error } = await supabase
        .from("integrations")
        .select("*")
        .eq("id", id)
        .single();
      if (error || !row) return res.status(404).json({ error: "Integration not found" });
      const probe = await probeIntegration(row as IntegrationRow);
      const newStatus = probe.ok ? "active" : "broken";
      await supabase
        .from("integrations")
        .update({
          status: newStatus,
          last_tested_at: new Date().toISOString(),
          last_test_error: probe.ok ? null : probe.message,
        })
        .eq("id", id);
      return res.status(200).json({
        ok: probe.ok,
        status: probe.status,
        message: probe.message,
        new_status: newStatus,
      });
    }

    // ── Create / upsert ─────────────────────────────────────────────────────
    if (req.method === "POST") {
      const body = req.body || {};
      const { company_id, vendor, credentials, config, display_name } = body;
      if (!company_id || !vendor)
        return res.status(400).json({ error: "company_id and vendor are required" });
      const def = getVendor(vendor);
      if (!def) return res.status(400).json({ error: `Unknown vendor: ${vendor}` });

      // Validate required credential fields
      const creds = (credentials && typeof credentials === "object") ? credentials : {};
      for (const f of def.credentials) {
        if (f.required && !creds[f.name])
          return res.status(400).json({ error: `Missing required credential: ${f.label}` });
      }

      const encrypted = encryptCredentials(creds);
      const previewSrc = String(creds.key || creds.token || creds.password || "");
      const preview = previewSrc ? maskCredential(previewSrc) : null;

      // Upsert by (company_id, vendor).
      // Persist auth_header_name + auth_header_template into config so the
      // runner can build outbound request headers without re-reading the
      // TypeScript vendor registry. This makes integration rows self-describing.
      const upsertRow = {
        company_id,
        vendor,
        display_name: display_name || def.display_name,
        kind: def.kind === "oauth" ? "oauth" : "rest_api",
        auth_type: def.auth_type,
        encrypted_credentials: encrypted,
        credential_preview: preview,
        config: {
          base_url: def.base_url,
          auth_header_name: def.auth_header_name,
          auth_header_template: def.auth_header_template,
          ...(config || {}),
        },
        actions: def.actions,
        status: "unverified" as const,
      };

      const { data, error } = await supabase
        .from("integrations")
        .upsert(upsertRow, { onConflict: "company_id,vendor" })
        .select("*")
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ integration: publicShape(data as IntegrationRow) });
    }

    // ── Update (re-encrypt creds if provided, otherwise just config) ────────
    if (req.method === "PATCH") {
      const id = String(req.query.id || "");
      if (!id) return res.status(400).json({ error: "id is required" });
      const body = req.body || {};
      const updates: Record<string, unknown> = {};
      if (body.config) updates.config = body.config;
      if (body.display_name) updates.display_name = body.display_name;
      if (body.credentials && typeof body.credentials === "object") {
        const encrypted = encryptCredentials(body.credentials);
        updates.encrypted_credentials = encrypted;
        const previewSrc = String(
          body.credentials.key || body.credentials.token || body.credentials.password || ""
        );
        if (previewSrc) updates.credential_preview = maskCredential(previewSrc);
        // New credentials -> reset status until re-tested
        updates.status = "unverified";
        updates.last_tested_at = null;
        updates.last_test_error = null;
      }
      if (Object.keys(updates).length === 0)
        return res.status(400).json({ error: "Nothing to update" });
      const { data, error } = await supabase
        .from("integrations")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ integration: publicShape(data as IntegrationRow) });
    }

    // ── Delete ──────────────────────────────────────────────────────────────
    if (req.method === "DELETE") {
      const id = String(req.query.id || "");
      if (!id) return res.status(400).json({ error: "id is required" });
      const { error } = await supabase.from("integrations").delete().eq("id", id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("integrations error:", msg);
    return res.status(500).json({ error: msg });
  }
}
