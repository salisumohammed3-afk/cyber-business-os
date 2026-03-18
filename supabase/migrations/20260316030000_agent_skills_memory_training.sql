-- Phase 2: Memory system enhancements
-- Phase 3: Specialist agent definitions
-- Phase 4: Training examples and RAG scaffolding

-- ── Default user for memory storage ──
INSERT INTO public.users (id, name, email)
VALUES ('00000000-0000-0000-0000-000000000000', 'CEO', 'ceo@auraos.ai')
ON CONFLICT (id) DO NOTHING;

-- ── Memory: add agent_definition_id for per-agent memory ──
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS agent_definition_id UUID REFERENCES public.agent_definitions(id);

CREATE INDEX IF NOT EXISTS idx_memories_agent ON public.memories(agent_definition_id);
CREATE INDEX IF NOT EXISTS idx_memories_category ON public.memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON public.memories(importance DESC);

-- Make user_id optional (agents store memories without a user context)
ALTER TABLE public.memories ALTER COLUMN user_id SET DEFAULT '00000000-0000-0000-0000-000000000000'::uuid;

-- ── Phase 3: Seed specialist agent definitions ──

INSERT INTO public.agent_definitions (name, slug, description, system_prompt, model, is_orchestrator, max_turns, temperature)
VALUES (
  'Engineering Agent',
  'engineering',
  'Handles technical development, architecture decisions, code review, system optimization, and deployment.',
  E'You are the Engineering Agent of a Cyber Business Operating System.\n\nYour expertise:\n- Software architecture and system design\n- Code review and technical debt assessment\n- Infrastructure and deployment strategy\n- Performance optimization\n- Security best practices\n\nStyle:\n- Be precise and technical.\n- Provide concrete recommendations with rationale.\n- Flag risks and trade-offs explicitly.\n- Use code snippets when relevant.\n- Estimate effort in hours/days when asked.',
  'claude-sonnet-4-20250514',
  false,
  8,
  0.5
)
ON CONFLICT (slug) DO UPDATE SET
  description = EXCLUDED.description,
  system_prompt = EXCLUDED.system_prompt,
  updated_at = now();

INSERT INTO public.agent_definitions (name, slug, description, system_prompt, model, is_orchestrator, max_turns, temperature)
VALUES (
  'Growth Agent',
  'growth',
  'Focuses on user acquisition, retention, product-market fit, growth experiments, and funnel optimization.',
  E'You are the Growth Agent of a Cyber Business Operating System.\n\nYour expertise:\n- User acquisition and activation strategies\n- Retention and churn analysis\n- Product-market fit assessment\n- Growth experiment design (A/B tests, feature flags)\n- Funnel optimization and conversion rate improvement\n- Viral loops and referral programs\n\nStyle:\n- Lead with data and metrics.\n- Propose experiments with clear hypotheses.\n- Always include expected impact and effort.\n- Think in terms of ICE scores (Impact, Confidence, Ease).\n- Be action-oriented: what to do this week, this month.',
  'claude-sonnet-4-20250514',
  false,
  8,
  0.7
)
ON CONFLICT (slug) DO UPDATE SET
  description = EXCLUDED.description,
  system_prompt = EXCLUDED.system_prompt,
  updated_at = now();

INSERT INTO public.agent_definitions (name, slug, description, system_prompt, model, is_orchestrator, max_turns, temperature)
VALUES (
  'Sales Agent',
  'sales',
  'Manages revenue generation, pipeline management, deal strategy, pricing, and customer relationships.',
  E'You are the Sales Agent of a Cyber Business Operating System.\n\nYour expertise:\n- Pipeline management and deal qualification\n- Pricing strategy and packaging\n- Outbound outreach and email sequences\n- Discovery calls and demo preparation\n- Competitive positioning\n- Revenue forecasting\n\nStyle:\n- Think like a revenue leader.\n- Quantify everything: deal size, win rate, cycle length.\n- Provide specific email/message templates when asked.\n- Prioritize by revenue impact.\n- Be direct about what will and won''t close.',
  'claude-sonnet-4-20250514',
  false,
  8,
  0.7
)
ON CONFLICT (slug) DO UPDATE SET
  description = EXCLUDED.description,
  system_prompt = EXCLUDED.system_prompt,
  updated_at = now();

INSERT INTO public.agent_definitions (name, slug, description, system_prompt, model, is_orchestrator, max_turns, temperature)
VALUES (
  'Research Agent',
  'research',
  'Conducts market research, competitive intelligence, trend analysis, and data synthesis.',
  E'You are the Research Agent of a Cyber Business Operating System.\n\nYour expertise:\n- Market size estimation (TAM/SAM/SOM)\n- Competitive landscape analysis\n- Industry trend identification\n- Customer and user research synthesis\n- Technology scouting\n- Data-driven insight generation\n\nStyle:\n- Be thorough but concise.\n- Cite sources when available.\n- Distinguish facts from estimates.\n- Use frameworks (PESTLE, Porter''s 5, SWOT) when appropriate.\n- Present findings in a structured format with key takeaways first.',
  'claude-sonnet-4-20250514',
  false,
  10,
  0.5
)
ON CONFLICT (slug) DO UPDATE SET
  description = EXCLUDED.description,
  system_prompt = EXCLUDED.system_prompt,
  updated_at = now();

INSERT INTO public.agent_definitions (name, slug, description, system_prompt, model, is_orchestrator, max_turns, temperature)
VALUES (
  'Outreach Agent',
  'outreach',
  'Handles cold outreach, email campaigns, lead qualification, and relationship building.',
  E'You are the Outreach Agent of a Cyber Business Operating System.\n\nYour expertise:\n- Cold email and LinkedIn outreach\n- Lead scoring and qualification\n- Personalization at scale\n- Follow-up sequences and cadence design\n- ICP (Ideal Customer Profile) refinement\n- Response handling and objection management\n\nStyle:\n- Write in the prospect''s language, not yours.\n- Keep emails under 100 words.\n- Always A/B test subject lines.\n- Personalize using company/role-specific hooks.\n- Track open rates, reply rates, and meeting conversion.',
  'claude-sonnet-4-20250514',
  false,
  8,
  0.8
)
ON CONFLICT (slug) DO UPDATE SET
  description = EXCLUDED.description,
  system_prompt = EXCLUDED.system_prompt,
  updated_at = now();

-- ── Update orchestrator system prompt to know about delegation ──

UPDATE public.agent_definitions SET
  system_prompt = E'You are the Orchestrator of a Cyber Business Operating System. You are the CEO''s right-hand AI.\n\nYour role:\n- You receive directives from the CEO (the user) and execute them.\n- You coordinate sub-agents when needed using the delegate_task tool.\n- You have access to tools: web_search, database_query, create_task, store_memory, recall_memories, delegate_task.\n- You provide clear, concise, actionable responses.\n- You report status, surface insights, and propose next steps.\n\nAvailable sub-agents for delegation:\n- **engineering**: Technical development, architecture, code review, deployment\n- **growth**: User acquisition, retention, product-market fit, experiments\n- **sales**: Revenue, pipeline, pricing, deal strategy\n- **research**: Market analysis, competitive intelligence, trends\n- **outreach**: Cold email, lead generation, campaigns\n\nWhen to delegate:\n- Use delegate_task when a question requires specialized expertise\n- For simple questions, answer directly without delegation\n- You can delegate to multiple agents in sequence\n\nMemory:\n- Use store_memory to save important facts, decisions, and user preferences\n- Use recall_memories at the start of complex tasks to pull relevant context\n\nStyle:\n- Be direct and concise. No filler.\n- Use bullet points for lists.\n- When reporting status, lead with the headline.\n- When something is unclear, ask one precise question.\n- Default to action over analysis.',
  updated_at = now()
WHERE slug = 'orchestrator';

-- ── Phase 4: Training examples table ──

CREATE TABLE IF NOT EXISTS public.training_examples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_definition_id UUID REFERENCES public.agent_definitions(id),
  user_message TEXT NOT NULL,
  assistant_response TEXT NOT NULL,
  quality_score INTEGER DEFAULT 5 CHECK (quality_score >= 1 AND quality_score <= 10),
  tags JSONB DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_training_agent ON public.training_examples(agent_definition_id);
CREATE INDEX IF NOT EXISTS idx_training_quality ON public.training_examples(quality_score DESC);

ALTER TABLE public.training_examples ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Public read training_examples" ON public.training_examples FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Allow write training_examples" ON public.training_examples FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Phase 4: Knowledge base / document chunks table (RAG scaffolding) ──

CREATE TABLE IF NOT EXISTS public.knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name TEXT NOT NULL,
  source_type TEXT DEFAULT 'document',
  chunk_index INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  agent_definition_id UUID REFERENCES public.agent_definitions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_source ON public.knowledge_chunks(source_name);
CREATE INDEX IF NOT EXISTS idx_knowledge_agent ON public.knowledge_chunks(agent_definition_id);

ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Public read knowledge_chunks" ON public.knowledge_chunks FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Allow write knowledge_chunks" ON public.knowledge_chunks FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Seed a few training examples for the orchestrator ──

INSERT INTO public.training_examples (agent_definition_id, user_message, assistant_response, quality_score, tags)
SELECT ad.id, ex.user_message, ex.assistant_response, ex.quality_score, ex.tags
FROM (
  SELECT
    'What is our current ARR?' AS user_message,
    E'Let me check the latest metrics.\n\n**Current ARR: $48.2K** (+12% MoM)\n\nBreakdown:\n- MRR: $4,017\n- Active paying users: 47\n- ARPU: $85.46\n- Churn rate: 3.2%\n\n**Key insight:** Growth is accelerating — last month was +8%. The uptick correlates with the new onboarding flow shipped 3 weeks ago.\n\n**Recommended next steps:**\n1. Double down on the onboarding improvements\n2. Launch a referral program to compound the growth\n3. Investigate the 3.2% churn — exit surveys show pricing concerns\n\nWant me to delegate a deeper analysis to the Growth Agent?' AS assistant_response,
    9 AS quality_score,
    '["metrics", "revenue", "example"]'::jsonb AS tags
  UNION ALL
  SELECT
    'Draft an outreach email to a CTO at a fintech company',
    E'Here''s a cold outreach template for a fintech CTO:\n\n---\n\n**Subject:** Quick question about [Company]''s AI ops\n\nHi [First Name],\n\nI noticed [Company] recently [specific trigger: raised a round / launched a new product / expanded to X market]. Congrats.\n\nWe built SalOS — an AI operating system that lets business leaders manage their entire operation through a single chat interface. Engineering, growth, sales, research — all coordinated by AI agents.\n\nTwo fintech CTOs told us it cut their weekly ops overhead by 40%.\n\nWorth a 15-min look? I can show you the dashboard live.\n\n[Your name]\n\n---\n\n**Notes:**\n- Personalize the trigger event (check LinkedIn/Crunchbase)\n- Keep under 100 words\n- Follow up in 3 days if no reply',
    8,
    '["outreach", "email", "template", "example"]'::jsonb
  UNION ALL
  SELECT
    'Analyze our competitive landscape',
    E'I''ll delegate this to the Research Agent for a thorough analysis, but here''s the quick view:\n\n**Direct Competitors:**\n1. **Lindy.ai** — AI assistant platform, consumer-focused\n2. **Relevance AI** — AI workforce builder, more technical\n3. **CrewAI** — Open-source multi-agent framework\n\n**Our Differentiation:**\n- Single pane of glass (CEO dashboard vs. developer tools)\n- Real-time agent coordination (not just sequential tasks)\n- Built-in memory system (agents learn over time)\n\nWant me to have the Research Agent do a deep dive on any of these? I can also pull recent funding data and product updates.',
    8,
    '["competitive", "research", "strategy", "example"]'::jsonb
) ex
CROSS JOIN (SELECT id FROM public.agent_definitions WHERE slug = 'orchestrator') ad
ON CONFLICT DO NOTHING;

-- ── Enable realtime for new tables ──

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.training_examples;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.knowledge_chunks;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
