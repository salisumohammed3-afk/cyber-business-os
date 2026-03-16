-- Task management system: add tags, recurring, source columns

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS recurrence_schedule TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'agent';

CREATE INDEX IF NOT EXISTS idx_tasks_source ON public.tasks(source);
CREATE INDEX IF NOT EXISTS idx_tasks_recurring ON public.tasks(is_recurring);

-- Mark all existing chat-response tasks as internal
UPDATE public.tasks
SET source = 'internal'
WHERE title = 'Respond to user message';
