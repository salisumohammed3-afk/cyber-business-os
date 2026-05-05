import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  encryptCredentials,
  decryptCredentials,
  maskCredential,
  type EncryptedBlob,
} from "./lib/crypto.js";
import { getVendor, listVendors } from "./lib/vendor-registry.js";
import { signAppStoreConnectJwt } from "./lib/jwt-es256.mjs";

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
  const creds = decryptCredentials(row.encrypted_credentials) as Record<string, string>;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  // jwt_es256 is registered-only (App Store Connect today).
  if (def?.auth_type === "jwt_es256") {
    if (def.vendor !== "appstoreconnect") {
      throw new Error(`jwt_es256 not yet wired for vendor: ${def.vendor}`);
    }
    const jwt = signAppStoreConnectJwt(creds.key_id, creds.issuer_id, creds.private_key);
    if (def.auth_header_name) {
      headers[def.auth_header_name] = `Bearer ${jwt}`;
    }
    return headers;
  }

  // For static auth (api_key / bearer / basic), prefer config.* values from
  // the row itself (works for custom vendors) and fall back to the registry
  // for registered ones. Both cases interpolate creds into the template.
  const rowCfg = (row.config || {}) as Record<string, unknown>;
  const headerName = (rowCfg.auth_header_name as string) || def?.auth_header_name || "";
  const headerTemplate = (rowCfg.auth_header_template as string) || def?.auth_header_template || "";
  if (headerName && headerTemplate) {
    let value: string = headerTemplate;
    for (const [k, v] of Object.entries(creds)) {
      value = value.replaceAll(`{{${k}}}`, String(v));
    }
    headers[headerName] = value;
  }
  return headers;
}

// ── Pre-probe: vendor-specific suggestions during setup ───────────────────
//
// When the user pastes credentials into the Add-Integration modal, we call
// the vendor with those creds and ask "what's actually available?" — e.g.
// Resend's verified domains, GitHub's accessible repos, etc. The modal
// renders the response as clickable pills above the relevant config field
// so the user picks a valid value instead of guessing.

type SuggestionResult = {
  ok: boolean;
  error?: string;
  // Per config-field suggestions — keyed by field name, value is array of strings.
  suggestions?: Record<string, string[]>;
  // Optional human-readable note shown above the suggestions.
  note?: string;
};

async function fetchVendorSuggestions(
  vendor: string,
  credentials: Record<string, string>,
): Promise<SuggestionResult> {
  if (vendor === "resend") return probeResend(credentials);
  // No suggestions registered for this vendor — the modal will just show the
  // plain config fields. Not an error.
  return { ok: true, suggestions: {} };
}

async function probeResend(credentials: Record<string, string>): Promise<SuggestionResult> {
  const key = (credentials.key || "").trim();
  if (!key) return { ok: false, error: "Paste your Resend API key first." };
  if (!key.startsWith("re_")) return { ok: false, error: "Resend keys start with re_ — double-check what you pasted." };

  try {
    const r = await fetch("https://api.resend.com/domains", {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) {
      // Resend uses 401/403 (standard) and 400 (their own "invalid api key" code).
      // Try to surface their message body if available.
      let serverMessage = "";
      try {
        const errBody = await r.json() as { message?: string; name?: string };
        serverMessage = errBody.message || errBody.name || "";
      } catch { /* fall through with status only */ }
      if (r.status === 400 || r.status === 401 || r.status === 403) {
        return {
          ok: false,
          error: serverMessage
            ? `Resend rejected the key: ${serverMessage}. Check resend.com/api-keys.`
            : `Resend rejected the key (${r.status}). Check it's still active at resend.com/api-keys.`,
        };
      }
      return { ok: false, error: `Resend returned ${r.status} when listing domains${serverMessage ? `: ${serverMessage}` : ""}.` };
    }
    const json = (await r.json()) as { data?: Array<{ name: string; status: string }> };
    const verified = (json.data || []).filter(d => d.status === "verified");
    if (verified.length === 0) {
      return {
        ok: true,
        suggestions: {},
        note:
          "No verified domains found on this Resend account yet. Verify a domain in Resend (Domains tab) before saving — otherwise sends will fail. You can still save with `onboarding@resend.dev` for testing only.",
      };
    }
    // Build sensible from-address suggestions from each verified domain.
    const fromCandidates = verified.flatMap(d => [
      `digest@${d.name}`,
      `hello@${d.name}`,
      `noreply@${d.name}`,
    ]);
    return {
      ok: true,
      note: `Verified domains on this account: ${verified.map(d => d.name).join(", ")}. Pick a from-address or type your own.`,
      suggestions: { from_email: fromCandidates },
    };
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not reach Resend: ${m}` };
  }
}

async function probeIntegration(row: IntegrationRow): Promise<{
  ok: boolean;
  status: number;
  message: string;
}> {
  const def = getVendor(row.vendor);

  // Build auth headers up-front (works for both registered and custom rows).
  let headers: Record<string, string>;
  try {
    headers = await buildAuthHeaders(row);
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, message: `Could not decrypt credentials: ${m}` };
  }

  // Decide what URL + method to hit. Registered vendors have an explicit
  // test action in the registry. Custom vendors don't, so fall back to a
  // GET on base_url itself — any 2xx / 4xx (other than auth errors) tells
  // us the host is reachable and the credential isn't outright rejected.
  const baseUrl = String((row.config?.base_url as string) || def?.base_url || "").replace(/\/$/, "");
  if (!baseUrl) {
    return { ok: false, status: 0, message: "No base_url configured — re-add the integration with config.base_url set." };
  }
  const isCustom = !def;
  const path = def?.test?.path ?? "";
  const method = def?.test?.method ?? "GET";
  const url = baseUrl + path;
  const expected = def?.test?.expect_status ?? 200;

  try {
    const r = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? "{}" : undefined,
      signal: AbortSignal.timeout(10_000),
    });

    // Auth failures are unambiguous regardless of registered vs custom.
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

    // Custom vendor: any non-auth-failure response means the host is reachable
    // and the credential at least isn't outright rejected. Treat as ok.
    if (isCustom) {
      return {
        ok: true,
        status: r.status,
        message: r.ok
          ? `Reachable (${r.status}). No vendor-specific test action configured for custom vendor — call call_vendor_http to exercise specific endpoints.`
          : `Reachable (${r.status}). Host is up and credential isn't rejected, but base URL doesn't accept GET. Try call_vendor_http with a specific path.`,
      };
    }

    // Registered vendor: match against the registry's expected status.
    if (r.status === expected || (expected === 200 && r.ok)) {
      return { ok: true, status: r.status, message: "Connection verified" };
    }
    if (r.status === 400 && expected === 400) {
      // Anthropic-style probes treat 400 as "auth ok"
      return { ok: true, status: 400, message: "Connection verified (probe returned expected 400)" };
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

    // ── Pre-probe (smart onboarding suggestions, before save) ───────────────
    // Lets the Add-Integration modal call the vendor with the user's pasted
    // credentials and ask "what valid choices exist?" — e.g. for Resend, the
    // verified domains. Returns suggestions per config field so the UI can
    // show clickable pills instead of a vague text input.
    if (req.method === "POST" && req.query.action === "pre_probe") {
      const body = (req.body || {}) as { vendor?: string; credentials?: Record<string, string> };
      const vendor = String(body.vendor || "");
      const credentials = body.credentials || {};
      if (!vendor) return res.status(400).json({ error: "vendor is required" });
      const result = await fetchVendorSuggestions(vendor, credentials);
      return res.status(200).json(result);
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
    // Two paths:
    //   1) Registered vendor (in vendor-registry.ts): metadata fills auto.
    //   2) Custom vendor (anything else, e.g. Mirage, OpenRouter, your.app):
    //      caller supplies auth_type, base_url, optional auth_header_name +
    //      auth_header_template, optional actions[]. Stored as a self-describing
    //      row exactly like a registered one — call_integration / runner work
    //      against the row, not the registry.
    if (req.method === "POST") {
      const body = req.body || {};
      const { company_id, vendor, credentials, config, display_name } = body;
      if (!company_id || !vendor)
        return res.status(400).json({ error: "company_id and vendor are required" });

      const def = getVendor(vendor);
      const creds = (credentials && typeof credentials === "object") ? credentials : {};

      let auth_type: string;
      let resolvedConfig: Record<string, unknown>;
      let resolvedActions: unknown[];
      let resolvedKind: string;
      let resolvedDisplayName: string;

      if (def) {
        // Registered vendor — validate required credential fields against registry.
        for (const f of def.credentials) {
          if (f.required && !creds[f.name])
            return res.status(400).json({ error: `Missing required credential: ${f.label}` });
        }
        auth_type = def.auth_type;
        resolvedKind = def.kind === "oauth" ? "oauth" : "rest_api";
        resolvedDisplayName = display_name || def.display_name;
        resolvedConfig = {
          base_url: def.base_url,
          auth_header_name: def.auth_header_name,
          auth_header_template: def.auth_header_template,
          ...(config || {}),
        };
        resolvedActions = def.actions;
      } else {
        // Custom vendor. Body-driven, self-describing.
        const submittedAuthType = typeof body.auth_type === "string" ? body.auth_type : "bearer";
        const allowed = ["bearer", "api_key", "basic", "none"];
        if (!allowed.includes(submittedAuthType)) {
          return res.status(400).json({
            error: `Custom vendor auth_type must be one of: ${allowed.join(", ")} (got: ${submittedAuthType})`,
          });
        }
        const submittedConfig = (config && typeof config === "object") ? config as Record<string, unknown> : {};
        if (submittedAuthType !== "none" && !submittedConfig.base_url) {
          return res.status(400).json({
            error: "Custom vendor requires config.base_url (the API root URL).",
          });
        }
        // Default auth header rules per auth_type if caller didn't specify.
        const defaultHeaderName =
          submittedAuthType === "bearer" ? "Authorization"
          : submittedAuthType === "api_key" ? "Authorization"
          : submittedAuthType === "basic" ? "Authorization"
          : null;
        const defaultHeaderTemplate =
          submittedAuthType === "bearer" ? "Bearer {{api_key}}"
          : submittedAuthType === "api_key" ? "{{api_key}}"
          : submittedAuthType === "basic" ? "Basic {{credentials_b64}}"
          : null;
        auth_type = submittedAuthType;
        resolvedKind = "rest_api";
        resolvedDisplayName = display_name || vendor;
        resolvedConfig = {
          ...submittedConfig,
          auth_header_name: submittedConfig.auth_header_name ?? defaultHeaderName,
          auth_header_template: submittedConfig.auth_header_template ?? defaultHeaderTemplate,
        };
        resolvedActions = Array.isArray(body.actions) ? body.actions : [];
      }

      const encrypted = encryptCredentials(creds);
      const previewSrc = String(
        creds.key || creds.token || creds.api_key || creds.password || creds.key_id || ""
      );
      const preview = previewSrc
        ? (auth_type === "jwt_es256" ? `Key ID: ${previewSrc}` : maskCredential(previewSrc))
        : null;

      const upsertRow = {
        company_id,
        vendor,
        display_name: resolvedDisplayName,
        kind: resolvedKind,
        auth_type,
        encrypted_credentials: encrypted,
        credential_preview: preview,
        config: resolvedConfig,
        actions: resolvedActions,
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
        // Look up the existing row to preserve auth_type (for preview style)
        const { data: existing } = await supabase
          .from("integrations")
          .select("auth_type")
          .eq("id", id)
          .maybeSingle();
        const encrypted = encryptCredentials(body.credentials);
        updates.encrypted_credentials = encrypted;
        const previewSrc = String(
          body.credentials.key || body.credentials.token || body.credentials.password || body.credentials.key_id || ""
        );
        if (previewSrc) {
          updates.credential_preview = existing?.auth_type === "jwt_es256"
            ? `Key ID: ${previewSrc}`
            : maskCredential(previewSrc);
        }
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
