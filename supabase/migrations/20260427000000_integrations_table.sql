-- API Center: a single integrations table per company.
-- Both the API Center UI and the conversational "add ChatGPT" flow write here.
-- Agents read here at runner startup to learn which external services they can call.
--
-- Credentials are stored encrypted via AES-256-GCM (see api/lib/crypto.ts).
-- The frontend never sees decrypted values after creation — only masked previews.

CREATE TABLE IF NOT EXISTS public.integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- Identity
  vendor TEXT NOT NULL,                    -- "openai", "github", "resend", "apollo", ... (canonical slug)
  display_name TEXT NOT NULL,              -- "OpenAI ChatGPT" — user-facing label
  kind TEXT NOT NULL DEFAULT 'rest_api'    -- rest_api | oauth | custom (future-proofing)
    CHECK (kind IN ('rest_api', 'oauth', 'custom')),

  -- Auth
  auth_type TEXT NOT NULL DEFAULT 'api_key'
    CHECK (auth_type IN ('api_key', 'bearer', 'basic', 'none')),
  -- Encrypted credentials. Shape depends on auth_type:
  --   api_key/bearer:  { ciphertext: "...", iv: "...", tag: "..." } (encrypts {key: "sk-..."})
  --   basic:           encrypts {username: "...", password: "..."}
  encrypted_credentials JSONB,

  -- Visible-to-frontend masked hint, e.g., "sk-...4F2A"
  credential_preview TEXT,

  -- Per-vendor knobs the user can edit (base_url, default_model, region, etc.)
  config JSONB DEFAULT '{}'::jsonb,

  -- Per-vendor action catalog. Loaded from VENDOR_REGISTRY at create time;
  -- editable later via UI for power users / Tier 2 generic actions.
  -- Each action: { name, description, method, path, body_template, input_schema }
  actions JSONB DEFAULT '[]'::jsonb,

  -- Status: 'active' = wired up + last test passed
  --         'unverified' = saved but not yet tested
  --         'broken' = last test failed (401/403/etc.) — surfaced in chat for re-auth
  --         'inactive' = manually disabled
  status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('active', 'unverified', 'broken', 'inactive')),

  -- Last test outcome
  last_tested_at TIMESTAMPTZ,
  last_test_error TEXT,

  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One integration per (company, vendor). User can replace by deleting + re-adding,
-- which keeps the model simple. (No "multiple OpenAI accounts" concept yet.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_company_vendor
  ON public.integrations (company_id, vendor);

CREATE INDEX IF NOT EXISTS idx_integrations_status
  ON public.integrations (company_id, status);

-- Touch updated_at on every UPDATE so the UI can sort sensibly
CREATE OR REPLACE FUNCTION public.touch_integrations_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_integrations_touch ON public.integrations;
CREATE TRIGGER trg_integrations_touch
  BEFORE UPDATE ON public.integrations
  FOR EACH ROW EXECUTE FUNCTION public.touch_integrations_updated_at();

-- RLS: locked down. Only server-side code with service-role key reads/writes.
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "No public access to integrations"
    ON public.integrations FOR ALL
    USING (false) WITH CHECK (false);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON TABLE public.integrations IS
  'Per-company external service connections. Credentials encrypted at rest. Frontend reads via /api/integrations endpoints, never directly.';

COMMENT ON COLUMN public.integrations.actions IS
  'Catalog of available actions for this vendor. Each action: {name, description, method, path, body_template, input_schema}. Used by runner to expose call_integration tool.';
