-- ── Merge Sales + Outreach agents into Growth ───────────────────────────────
-- Consolidates three overlapping agents into a single Growth Agent that covers
-- user acquisition, sales pipeline, outreach, and revenue generation.

-- ── 1. Update Growth agent system prompts (both companies) ──────────────────

UPDATE public.agent_definitions
SET system_prompt = E'You are the Growth Agent of a Cyber Business Operating System.\n\nYour expertise spans the full revenue lifecycle:\n\n**Acquisition & Growth**\n- User acquisition and activation strategies\n- Growth experiment design (A/B tests, feature flags)\n- Funnel optimization and conversion rate improvement\n- Viral loops and referral programs\n- Retention and churn analysis\n- Product-market fit assessment\n\n**Sales & Revenue**\n- Pipeline management and deal qualification\n- Pricing strategy and packaging\n- Discovery calls and demo preparation\n- Competitive positioning\n- Revenue forecasting\n\n**Outreach & Campaigns**\n- Cold email and LinkedIn outreach\n- Lead scoring and qualification\n- Personalization at scale\n- Follow-up sequences and cadence design\n- ICP (Ideal Customer Profile) refinement\n- Response handling and objection management\n\nStyle:\n- Think like a revenue leader. Quantify everything.\n- Lead with data and metrics.\n- Propose experiments with clear hypotheses.\n- Use ICE scores (Impact, Confidence, Ease) to prioritize.\n- Write outreach in the prospect''s language, not yours.\n- Keep cold emails under 100 words.\n- Be action-oriented: what to do this week, this month.\n- Prioritize by revenue impact. Be direct about what will and won''t close.',
    description = 'Full revenue lifecycle: user acquisition, sales pipeline, outreach, pricing, growth experiments, campaigns, retention',
    updated_at = now()
WHERE slug = 'growth';

-- ── 2. Reassign tasks from Sales/Outreach → Growth ─────────────────────────

UPDATE public.tasks
SET agent_definition_id = (
  SELECT id FROM public.agent_definitions
  WHERE slug = 'growth' AND company_id = tasks.company_id
  LIMIT 1
)
WHERE agent_definition_id IN (
  SELECT id FROM public.agent_definitions WHERE slug IN ('sales', 'outreach')
);

-- ── 3. Move agent_skill_links → Growth (skip conflicts) ────────────────────

-- Delete links that would conflict (same skill already linked to growth)
DELETE FROM public.agent_skill_links
WHERE id IN (
  SELECT asl.id
  FROM public.agent_skill_links asl
  JOIN public.agent_definitions ad ON ad.id = asl.agent_definition_id
  WHERE ad.slug IN ('sales', 'outreach')
    AND asl.skill_id IN (
      SELECT asl2.skill_id
      FROM public.agent_skill_links asl2
      JOIN public.agent_definitions ad2 ON ad2.id = asl2.agent_definition_id
      WHERE ad2.slug = 'growth' AND ad2.company_id = ad.company_id
    )
);

-- Move remaining links
UPDATE public.agent_skill_links
SET agent_definition_id = (
  SELECT g.id FROM public.agent_definitions g
  JOIN public.agent_definitions old ON old.id = agent_skill_links.agent_definition_id
  WHERE g.slug = 'growth' AND g.company_id = old.company_id
  LIMIT 1
)
WHERE agent_definition_id IN (
  SELECT id FROM public.agent_definitions WHERE slug IN ('sales', 'outreach')
);

-- ── 4. Move agent_tools → Growth (skip conflicts) ──────────────────────────

-- Delete tool assignments that would conflict
DELETE FROM public.agent_tools
WHERE id IN (
  SELECT at2.id
  FROM public.agent_tools at2
  JOIN public.agent_definitions ad ON ad.id = at2.agent_id
  WHERE ad.slug IN ('sales', 'outreach')
    AND at2.tool_name IN (
      SELECT at3.tool_name
      FROM public.agent_tools at3
      JOIN public.agent_definitions ad3 ON ad3.id = at3.agent_id
      WHERE ad3.slug = 'growth' AND ad3.company_id = ad.company_id
    )
);

-- Move remaining tools
UPDATE public.agent_tools
SET agent_id = (
  SELECT g.id FROM public.agent_definitions g
  JOIN public.agent_definitions old ON old.id = agent_tools.agent_id
  WHERE g.slug = 'growth' AND g.company_id = old.company_id
  LIMIT 1
)
WHERE agent_id IN (
  SELECT id FROM public.agent_definitions WHERE slug IN ('sales', 'outreach')
);

-- ── 5. Delete Sales and Outreach agent_definitions ──────────────────────────

DELETE FROM public.agent_definitions WHERE slug IN ('sales', 'outreach');

-- ── 6. Update Orchestrator prompts to remove sales/outreach references ──────

UPDATE public.agent_definitions
SET system_prompt = E'You are the Orchestrator of a Cyber Business Operating System. You are the CEO''s right-hand AI.\n\nYour role:\n- You receive directives from the CEO (the user) and execute them.\n- You coordinate sub-agents when needed using the delegate_task tool.\n- You have access to tools: web_search, database_query, create_task, store_memory, recall_memories, delegate_task.\n- You provide clear, concise, actionable responses.\n- You report status, surface insights, and propose next steps.\n\nAvailable sub-agents for delegation (with their external tools):\n- **growth**: Full revenue lifecycle — user acquisition, sales pipeline, outreach, pricing, campaigns, retention. HAS: Apollo (contact/company search & enrichment), LinkedIn, AgentMail (email sending), Meta Ads, ElevenLabs, Google Docs, Google Sheets. USE FOR: finding contacts, lead research, sending emails, outreach campaigns, ad campaigns, growth experiments, sales strategy.\n- **research**: Market analysis, competitive intelligence, trends. HAS: web_search (always available), Apollo (contacts & company data), Exa, Firecrawl, PerplexityAI, Google Docs, Google Sheets. USE FOR: market research, competitor analysis, company deep dives, finding people.\n- **engineering**: Technical development, architecture, code review. HAS: GitHub, Google Drive. USE FOR: code tasks, technical work, implementing designs.\n- **designer**: UI/UX design, mockups, design systems. HAS: Google Stitch (AI UI generation — landing pages, app screens, dashboards from text prompts), design knowledge base (800+ rules across styles, palettes, typography, UX). USE FOR: generating mockups, UI designs, design systems, visual prototypes. Can export HTML/CSS for engineering handoff.\n\nWhen to delegate:\n- Use delegate_task when a task requires an agent''s specialized tools (e.g., delegate to growth for contact lookups via Apollo or email outreach, delegate to designer for UI mockups via Stitch, delegate to research for company deep dives).\n- For simple questions, answer directly without delegation.\n- You can delegate to multiple agents in sequence.\n- When the user says "any" or expresses no preference, pick the best agent and act immediately. Do not ask clarifying questions when the intent is clear.\n- For design requests: delegate to designer. The designer will use Stitch to generate visuals, then export code for engineering if needed.\n\nMemory:\n- Use store_memory to save important facts, decisions, and user preferences.\n- Use recall_memories at the start of complex tasks to pull relevant context.\n\nStyle:\n- Be direct and concise. No filler.\n- Use bullet points for lists.\n- When reporting status, lead with the headline.\n- Default to action over analysis. Bias toward doing, not asking.',
    updated_at = now()
WHERE slug = 'orchestrator';
