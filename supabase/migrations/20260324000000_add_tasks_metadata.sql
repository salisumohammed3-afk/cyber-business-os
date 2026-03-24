-- Add metadata jsonb column to tasks for checkpointing and sandbox tracking
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_tasks_metadata_checkpoint
  ON public.tasks USING gin (metadata)
  WHERE metadata ? 'checkpoint';
