-- Reliability & observability: structured log metadata, job ledger, heartbeats, digest idempotency

ALTER TABLE public.terminal_logs
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_terminal_logs_task_id ON public.terminal_logs(task_id) WHERE task_id IS NOT NULL;

-- Cron / batch job runs (debugging, partial failure visibility)
CREATE TABLE IF NOT EXISTS public.job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  error_summary text,
  companies_processed int NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_job_runs_name_started ON public.job_runs(job_name, started_at DESC);

ALTER TABLE public.job_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Public read job_runs" ON public.job_runs FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Allow write job_runs" ON public.job_runs FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Worker / service liveness (ops dashboards, /api/health)
CREATE TABLE IF NOT EXISTS public.system_heartbeats (
  service_key text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.system_heartbeats ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Public read system_heartbeats" ON public.system_heartbeats FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Allow write system_heartbeats" ON public.system_heartbeats FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Daily digest: skip duplicate send same UTC day (cron replay / manual trigger)
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS digest_last_sent_date date;
