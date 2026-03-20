-- ── Skill Recommendations ────────────────────────────────────────────────────
-- Agents periodically reflect on recent work and suggest skills they wish
-- they had. The CEO reviews and installs them via the platform.

CREATE TABLE IF NOT EXISTS public.skill_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_definition_id UUID NOT NULL REFERENCES public.agent_definitions(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  suggested_content TEXT,
  priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'installed', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_skill_recs_agent ON public.skill_recommendations(agent_definition_id);
CREATE INDEX IF NOT EXISTS idx_skill_recs_company ON public.skill_recommendations(company_id);
CREATE INDEX IF NOT EXISTS idx_skill_recs_status ON public.skill_recommendations(status);

ALTER TABLE public.skill_recommendations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Public read skill_recommendations" ON public.skill_recommendations FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Allow write skill_recommendations" ON public.skill_recommendations FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
