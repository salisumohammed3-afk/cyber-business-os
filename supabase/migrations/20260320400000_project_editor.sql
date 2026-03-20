-- Add edit_conversation_id to projects for the project editor feature
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS edit_conversation_id UUID REFERENCES public.conversations(id);

CREATE INDEX IF NOT EXISTS idx_projects_edit_conv ON public.projects(edit_conversation_id) WHERE edit_conversation_id IS NOT NULL;
