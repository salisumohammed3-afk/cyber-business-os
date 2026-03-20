-- ── Agent Skills ─────────────────────────────────────────────────────────────
-- Markdown instruction sets that get injected into agent system prompts.
-- Skills are company-scoped and shared across agents via a junction table.

CREATE TABLE IF NOT EXISTS public.skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  source_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_skills_company ON public.skills(company_id);

ALTER TABLE public.skills ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Public read skills" ON public.skills FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Allow write skills" ON public.skills FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Agent ↔ Skill links ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.agent_skill_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_definition_id UUID NOT NULL REFERENCES public.agent_definitions(id) ON DELETE CASCADE,
  skill_id UUID NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_definition_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_asl_agent ON public.agent_skill_links(agent_definition_id);
CREATE INDEX IF NOT EXISTS idx_asl_skill ON public.agent_skill_links(skill_id);

ALTER TABLE public.agent_skill_links ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Public read agent_skill_links" ON public.agent_skill_links FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Allow write agent_skill_links" ON public.agent_skill_links FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Realtime for live UI updates
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.skills;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_skill_links;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
