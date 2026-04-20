-- Phase 3: Auto-approve columns for goal-driven autonomy
-- companies.auto_approve_enabled: opt-in per company for auto-approving proactive tasks
-- agent_definitions.is_safe_auto_approve: opt-in per agent (only safe agents like research)

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS auto_approve_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.agent_definitions
  ADD COLUMN IF NOT EXISTS is_safe_auto_approve BOOLEAN NOT NULL DEFAULT false;

-- Phase 1: Index for efficient agent-scoped memory retrieval
CREATE INDEX IF NOT EXISTS idx_memories_category_agent
  ON public.memories(category, agent_definition_id, company_id);

-- Mark research agent as safe for auto-approve (conservative default)
UPDATE public.agent_definitions
  SET is_safe_auto_approve = true
  WHERE slug = 'research';

COMMENT ON COLUMN public.companies.auto_approve_enabled IS 'When true, high-priority tasks from proactive planner can be auto-approved';
COMMENT ON COLUMN public.agent_definitions.is_safe_auto_approve IS 'When true, this agent''s proposed tasks can be auto-approved (if company also opted in)';
