-- ── Projects registry (platform DB) ─────────────────────────────────────────
-- Tracks everything the engineering agent builds. Actual project data lives
-- in the separate Projects Supabase instance.

CREATE TABLE IF NOT EXISTS public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  repo_url TEXT,
  deploy_url TEXT,
  branch TEXT DEFAULT 'main',
  tables_created TEXT[] DEFAULT '{}',
  env_vars JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'building', 'live', 'archived')),
  created_by_task_id TEXT REFERENCES public.tasks(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_company ON public.projects(company_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON public.projects(status);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Public read projects" ON public.projects FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Allow write projects" ON public.projects FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Daily digest config on companies ────────────────────────────────────────

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS digest_email TEXT,
  ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN NOT NULL DEFAULT true;

-- Backfill QTA company with owner email
UPDATE public.companies
  SET digest_email = 'sal@quicktoact.com'
  WHERE id = '11111111-1111-1111-1111-111111111111'
    AND digest_email IS NULL;
