-- Multi-company workspace architecture
-- Creates companies, company_goals, base_agent_definitions tables
-- Adds company_id to existing tables, backfills to default QTA company

-- ── 1. New tables ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES public.users(id) DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  brief JSONB DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(owner_id, slug)
);

CREATE TABLE IF NOT EXISTS public.company_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  target_metric TEXT,
  target_value NUMERIC,
  current_value NUMERIC DEFAULT 0,
  timeframe TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'achieved', 'paused', 'abandoned')),
  priority INTEGER NOT NULL DEFAULT 5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.base_agent_definitions (
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
  default_tools JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 2. Add company_id to existing tables (nullable first) ──────────────────

ALTER TABLE public.agent_definitions
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.companies(id);

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.companies(id);

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.companies(id);

ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.companies(id);

ALTER TABLE public.terminal_logs
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.companies(id);

-- ── 3. Backfill: create default QTA company ────────────────────────────────

INSERT INTO public.companies (id, owner_id, name, slug, brief, is_active)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  '00000000-0000-0000-0000-000000000000',
  'QTA',
  'qta',
  '{"what_we_do": "Quick To Act (QTA) is a business services company.", "stage": "early-revenue"}'::jsonb,
  true
)
ON CONFLICT DO NOTHING;

-- Set company_id on all existing rows
UPDATE public.agent_definitions SET company_id = '11111111-1111-1111-1111-111111111111' WHERE company_id IS NULL;
UPDATE public.conversations SET company_id = '11111111-1111-1111-1111-111111111111' WHERE company_id IS NULL;
UPDATE public.tasks SET company_id = '11111111-1111-1111-1111-111111111111' WHERE company_id IS NULL;
UPDATE public.memories SET company_id = '11111111-1111-1111-1111-111111111111' WHERE company_id IS NULL;
UPDATE public.terminal_logs SET company_id = '11111111-1111-1111-1111-111111111111' WHERE company_id IS NULL;

-- ── 4. Fix slug uniqueness: drop old, add compound ─────────────────────────

ALTER TABLE public.agent_definitions DROP CONSTRAINT IF EXISTS agent_definitions_slug_key;
DO $$ BEGIN
  ALTER TABLE public.agent_definitions ADD CONSTRAINT agent_definitions_company_slug_key UNIQUE (company_id, slug);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Make company_id NOT NULL on agent_definitions after backfill
ALTER TABLE public.agent_definitions ALTER COLUMN company_id SET NOT NULL;

-- ── 5. Populate base_agent_definitions from current agents ─────────────────

INSERT INTO public.base_agent_definitions (slug, name, description, system_prompt, model, is_orchestrator, max_turns, temperature, allowed_tools)
SELECT slug, name, description, system_prompt, model, is_orchestrator, max_turns, temperature, allowed_tools
FROM public.agent_definitions
WHERE company_id = '11111111-1111-1111-1111-111111111111'
ON CONFLICT (slug) DO NOTHING;

-- Add missing base agents: browser, designer, taskmaster
INSERT INTO public.base_agent_definitions (name, slug, description, system_prompt, model, is_orchestrator, max_turns, temperature)
VALUES (
  'Browser Agent',
  'browser',
  'Web automation, scraping, form filling, and data extraction from websites.',
  E'You are the Browser Agent of a Cyber Business Operating System.\n\nYour expertise:\n- Web scraping and data extraction\n- Form automation and submission\n- Website monitoring and change detection\n- Screenshot capture and visual analysis\n- Multi-step web workflows\n\nStyle:\n- Report extracted data in clean, structured formats.\n- Flag any access issues or CAPTCHAs.\n- Be efficient — minimize page loads.\n- Always validate extracted data for completeness.',
  'claude-sonnet-4-20250514',
  false, 8, 0.5
), (
  'Designer Agent',
  'designer',
  'UI/UX design, mockups, design system management, and visual asset creation.',
  E'You are the Designer Agent of a Cyber Business Operating System.\n\nYour expertise:\n- UI/UX design principles and best practices\n- Design system creation and maintenance\n- Wireframing and prototyping\n- Visual hierarchy and typography\n- Responsive design patterns\n- Accessibility standards (WCAG)\n\nStyle:\n- Think user-first.\n- Reference design patterns by name.\n- Provide specific CSS/Tailwind suggestions when relevant.\n- Balance aesthetics with usability.\n- Explain design rationale clearly.',
  'claude-sonnet-4-20250514',
  false, 8, 0.6
), (
  'Taskmaster Agent',
  'taskmaster',
  'Project management, task coordination, board management, and workflow optimization.',
  E'You are the Taskmaster Agent of a Cyber Business Operating System.\n\nYour expertise:\n- Project planning and milestone tracking\n- Task breakdown and dependency mapping\n- Sprint planning and velocity tracking\n- Resource allocation and workload balancing\n- Status reporting and blockers identification\n- Process improvement and automation\n\nStyle:\n- Be structured and systematic.\n- Use clear status indicators.\n- Track deadlines rigorously.\n- Escalate blockers immediately.\n- Provide actionable next steps, not just status updates.',
  'claude-sonnet-4-20250514',
  false, 10, 0.5
)
ON CONFLICT (slug) DO NOTHING;

-- Also add missing agents to the QTA company
INSERT INTO public.agent_definitions (name, slug, description, system_prompt, model, is_orchestrator, max_turns, temperature, company_id)
SELECT name, slug, description, system_prompt, model, is_orchestrator, max_turns, temperature, '11111111-1111-1111-1111-111111111111'
FROM public.base_agent_definitions
WHERE slug IN ('browser', 'designer', 'taskmaster')
ON CONFLICT (company_id, slug) DO NOTHING;

-- Store default tool assignments in base_agent_definitions
UPDATE public.base_agent_definitions SET default_tools = '["web_search","database_query","create_task","store_memory","recall_memories","delegate_task"]'::jsonb WHERE slug = 'orchestrator';
UPDATE public.base_agent_definitions SET default_tools = '["web_search","database_query","store_memory","recall_memories"]'::jsonb WHERE slug = 'engineering';
UPDATE public.base_agent_definitions SET default_tools = '["web_search","database_query","store_memory","recall_memories"]'::jsonb WHERE slug = 'growth';
UPDATE public.base_agent_definitions SET default_tools = '["web_search","database_query","store_memory","recall_memories"]'::jsonb WHERE slug = 'sales';
UPDATE public.base_agent_definitions SET default_tools = '["web_search","database_query","store_memory","recall_memories"]'::jsonb WHERE slug = 'research';
UPDATE public.base_agent_definitions SET default_tools = '["web_search","database_query","store_memory","recall_memories"]'::jsonb WHERE slug = 'outreach';
UPDATE public.base_agent_definitions SET default_tools = '["web_search","database_query","store_memory","recall_memories"]'::jsonb WHERE slug = 'browser';
UPDATE public.base_agent_definitions SET default_tools = '["web_search","database_query","store_memory","recall_memories"]'::jsonb WHERE slug = 'designer';
UPDATE public.base_agent_definitions SET default_tools = '["web_search","database_query","store_memory","recall_memories"]'::jsonb WHERE slug = 'taskmaster';

-- ── 6. Indexes ─────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_companies_owner ON public.companies(owner_id);
CREATE INDEX IF NOT EXISTS idx_companies_active ON public.companies(is_active);
CREATE INDEX IF NOT EXISTS idx_company_goals_company ON public.company_goals(company_id);
CREATE INDEX IF NOT EXISTS idx_company_goals_status ON public.company_goals(status);
CREATE INDEX IF NOT EXISTS idx_agent_definitions_company ON public.agent_definitions(company_id);
CREATE INDEX IF NOT EXISTS idx_conversations_company ON public.conversations(company_id);
CREATE INDEX IF NOT EXISTS idx_tasks_company ON public.tasks(company_id);
CREATE INDEX IF NOT EXISTS idx_memories_company ON public.memories(company_id);
CREATE INDEX IF NOT EXISTS idx_terminal_logs_company ON public.terminal_logs(company_id);

-- ── 7. RLS ─────────────────────────────────────────────────────────────────

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.base_agent_definitions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Public read companies" ON public.companies FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Allow write companies" ON public.companies FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Public read company_goals" ON public.company_goals FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Allow write company_goals" ON public.company_goals FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Public read base_agent_definitions" ON public.base_agent_definitions FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Allow write base_agent_definitions" ON public.base_agent_definitions FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 8. Realtime ────────────────────────────────────────────────────────────

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.companies;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.company_goals;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
