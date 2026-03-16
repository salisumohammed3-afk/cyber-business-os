-- Align schema to match types.ts and seed orchestrator agent
-- Uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so it's safe to run
-- even if tables were created via the Supabase dashboard.

-- ── New tables ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  email TEXT,
  company_context JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.users(id),
  title TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  system_prompt TEXT,
  model TEXT DEFAULT 'claude-sonnet-4-20250514',
  allowed_tools JSONB,
  is_orchestrator BOOLEAN NOT NULL DEFAULT false,
  max_turns INTEGER NOT NULL DEFAULT 10,
  temperature NUMERIC NOT NULL DEFAULT 0.7,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.agent_definitions(id),
  tool_name TEXT,
  tool_type TEXT,
  mcp_server_url TEXT,
  config JSONB,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.task_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id TEXT NOT NULL,
  result_type TEXT NOT NULL,
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id),
  category TEXT,
  content TEXT,
  metadata JSONB,
  importance INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Evolve chat_messages (add columns the new schema needs) ──

ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS conversation_id UUID,
  ADD COLUMN IF NOT EXISTS tool_calls JSONB,
  ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Allow content to be nullable (orchestrator may send tool_calls only)
ALTER TABLE public.chat_messages ALTER COLUMN content DROP NOT NULL;

-- Relax the role CHECK so we can use 'assistant' alongside 'orchestrator'
ALTER TABLE public.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_role_check;
ALTER TABLE public.chat_messages
  ADD CONSTRAINT chat_messages_role_check CHECK (role IN ('user', 'orchestrator', 'assistant'));

-- ── Evolve tasks table (add new columns) ──

DO $$ BEGIN
  ALTER TYPE public.task_status ADD VALUE IF NOT EXISTS 'pending';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE public.task_status ADD VALUE IF NOT EXISTS 'cancelled';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS conversation_id UUID,
  ADD COLUMN IF NOT EXISTS agent_definition_id UUID REFERENCES public.agent_definitions(id),
  ADD COLUMN IF NOT EXISTS parent_task_id TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS input_data JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_message TEXT,
  ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_retries INTEGER DEFAULT 3,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Make agent_id nullable (new tasks use agent_definition_id)
ALTER TABLE public.tasks ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE public.tasks ALTER COLUMN agent_name DROP NOT NULL;
ALTER TABLE public.tasks ALTER COLUMN title DROP NOT NULL;

-- ── RLS on new tables ──

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;

-- Public read
CREATE POLICY IF NOT EXISTS "Public read users" ON public.users FOR SELECT USING (true);
CREATE POLICY IF NOT EXISTS "Public read conversations" ON public.conversations FOR SELECT USING (true);
CREATE POLICY IF NOT EXISTS "Public read agent_definitions" ON public.agent_definitions FOR SELECT USING (true);
CREATE POLICY IF NOT EXISTS "Public read agent_tools" ON public.agent_tools FOR SELECT USING (true);
CREATE POLICY IF NOT EXISTS "Public read task_results" ON public.task_results FOR SELECT USING (true);
CREATE POLICY IF NOT EXISTS "Public read memories" ON public.memories FOR SELECT USING (true);

-- Anon/authenticated can write (service role bypasses RLS anyway)
CREATE POLICY IF NOT EXISTS "Allow write users" ON public.users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "Allow write conversations" ON public.conversations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "Allow write agent_definitions" ON public.agent_definitions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "Allow write agent_tools" ON public.agent_tools FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "Allow write task_results" ON public.task_results FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "Allow write memories" ON public.memories FOR ALL USING (true) WITH CHECK (true);

-- ── Indexes ──

CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON public.chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_conv ON public.tasks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_def ON public.tasks(agent_definition_id);
CREATE INDEX IF NOT EXISTS idx_agent_tools_agent ON public.agent_tools(agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_user ON public.memories(user_id);

-- ── Seed orchestrator agent ──

INSERT INTO public.agent_definitions (name, slug, description, system_prompt, model, is_orchestrator, max_turns, temperature)
VALUES (
  'Orchestrator',
  'orchestrator',
  'The CEO-level orchestrator that manages all sub-agents and responds to user directives.',
  E'You are the Orchestrator of a Cyber Business Operating System. You are the CEO''s right-hand AI.\n\nYour role:\n- You receive directives from the CEO (the user) and execute them.\n- You coordinate sub-agents (engineering, growth, sales, research) when needed.\n- You provide clear, concise, actionable responses.\n- You report status, surface insights, and propose next steps.\n- You speak with confidence and authority, like a seasoned Chief of Staff.\n\nStyle:\n- Be direct and concise. No filler.\n- Use bullet points for lists.\n- When reporting status, lead with the headline.\n- When something is unclear, ask one precise question.\n- Default to action over analysis.',
  'claude-sonnet-4-20250514',
  true,
  10,
  0.7
)
ON CONFLICT (slug) DO UPDATE SET
  system_prompt = EXCLUDED.system_prompt,
  model = EXCLUDED.model,
  updated_at = now();

-- Enable realtime for key tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_definitions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.task_results;
