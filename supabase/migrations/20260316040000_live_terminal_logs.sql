-- Enhance terminal_logs for real agent activity streaming

ALTER TABLE public.terminal_logs
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS agent_slug TEXT,
  ADD COLUMN IF NOT EXISTS task_id TEXT,
  ADD COLUMN IF NOT EXISTS log_type TEXT DEFAULT 'info';

CREATE INDEX IF NOT EXISTS idx_terminal_logs_source ON public.terminal_logs(source);
CREATE INDEX IF NOT EXISTS idx_terminal_logs_type ON public.terminal_logs(log_type);

-- Allow writes from the agent runner
DO $$ BEGIN
  CREATE POLICY "Allow update terminal_logs" ON public.terminal_logs FOR UPDATE USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Enable realtime
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.terminal_logs;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
