-- Stage 5: Generic scheduling. One row = one recurring policy the user has approved.
--
-- Each row clones its work_order_template into a fresh tasks row whenever
-- next_run_at <= now() (the Railway worker polls for this every 30s).
--
-- The work_order_template is the same shape as a [PROPOSE_WORK_ORDER] payload,
-- so any work-order type the system supports today is automatically schedulable.

CREATE TABLE IF NOT EXISTS public.scheduled_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- Human-readable label for the Settings UI and chat status cards
  name TEXT NOT NULL,
  description TEXT,

  -- Cadence: validated server-side. Spec shape depends on type.
  cadence_type TEXT NOT NULL
    CHECK (cadence_type IN ('hourly', 'daily', 'weekly', 'monthly', 'cron')),
  --   hourly:  { minute: 0..59 }
  --   daily:   { time: "HH:MM", tz: "Europe/London" }
  --   weekly:  { days: ["mon","wed",...], time: "HH:MM", tz: "..." }
  --   monthly: { day_of_month: 1..28, time: "HH:MM", tz: "..." }
  --   cron:    { expr: "0 9 * * 1" }
  cadence_spec JSONB NOT NULL,

  -- The work-order proposal to clone on each fire. Same shape as [PROPOSE_WORK_ORDER]:
  --   { type, title, description } at minimum. System fills agent + caps from work order type.
  work_order_template JSONB NOT NULL,

  -- Lifecycle
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ NOT NULL,
  -- Most recent firing's task id, for "Last result" UI display
  last_run_task_id TEXT REFERENCES public.tasks(id) ON DELETE SET NULL,
  -- Counters for at-a-glance reliability
  total_fires INT NOT NULL DEFAULT 0,
  total_failures INT NOT NULL DEFAULT 0,

  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL
);

-- Hot-path index: worker polls "active and due" every 30s
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
  ON public.scheduled_tasks (next_run_at)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_company
  ON public.scheduled_tasks (company_id);

-- Touch updated_at on every UPDATE
CREATE OR REPLACE FUNCTION public.touch_scheduled_tasks_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_scheduled_tasks_touch ON public.scheduled_tasks;
CREATE TRIGGER trg_scheduled_tasks_touch
  BEFORE UPDATE ON public.scheduled_tasks
  FOR EACH ROW EXECUTE FUNCTION public.touch_scheduled_tasks_updated_at();

-- Permissive RLS: server-side endpoints handle authz; frontend hits /api/schedules
-- (mirrors the pattern used for skills + agent_definitions in this codebase)
ALTER TABLE public.scheduled_tasks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Public read scheduled_tasks"
    ON public.scheduled_tasks FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Allow write scheduled_tasks"
    ON public.scheduled_tasks FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON TABLE public.scheduled_tasks IS
  'Recurring work policies. Each row fires its work_order_template into a fresh tasks row when next_run_at is reached. Pre-approved at creation; firings auto-run with the work-order type''s cost cap.';
COMMENT ON COLUMN public.scheduled_tasks.cadence_type IS
  'hourly | daily | weekly | monthly | cron. Determines required shape of cadence_spec.';
COMMENT ON COLUMN public.scheduled_tasks.work_order_template IS
  'Same shape as a [PROPOSE_WORK_ORDER] payload. Cloned into a tasks row each fire.';
