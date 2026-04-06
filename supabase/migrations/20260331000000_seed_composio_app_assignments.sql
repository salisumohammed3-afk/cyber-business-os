-- Seed Composio app-level assignments into agent_tools.
-- The runner now reads agent_tools WHERE connection_source='composio' to build
-- per-agent allowlists. Each row's tool_name is the Composio app name (lowercased).
-- The is_enabled toggle in CompanySettings now controls runtime access.

-- Remove duplicate (agent_id, tool_name) rows before adding unique index.
-- Keep one row per pair using ctid (physical row id).
DELETE FROM public.agent_tools a
USING public.agent_tools b
WHERE a.agent_id = b.agent_id
  AND a.tool_name = b.tool_name
  AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tools_agent_tool_unique
  ON public.agent_tools (agent_id, tool_name);

-- Growth agent: Apollo, LinkedIn, Instantly, Gmail, AgentMail, Google Docs, Google Sheets
INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, is_enabled)
SELECT id, unnest(ARRAY['apollo','linkedin','instantly','gmail','agentmail','googledocs','googlesheets']),
       'composio', 'composio', true
FROM public.agent_definitions WHERE slug = 'growth'
ON CONFLICT DO NOTHING;

-- Research agent: Exa, Firecrawl, Google Docs, Google Sheets, Perplexity AI
INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, is_enabled)
SELECT id, unnest(ARRAY['exa','firecrawl','googledocs','googlesheets','perplexityai']),
       'composio', 'composio', true
FROM public.agent_definitions WHERE slug = 'research'
ON CONFLICT DO NOTHING;

-- Engineering agent: GitHub, Google Docs, Google Drive
INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, is_enabled)
SELECT id, unnest(ARRAY['github','googledocs','googledrive']),
       'composio', 'composio', true
FROM public.agent_definitions WHERE slug = 'engineering'
ON CONFLICT DO NOTHING;

-- Designer agent: Figma, Google Docs
INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, is_enabled)
SELECT id, unnest(ARRAY['figma','googledocs']),
       'composio', 'composio', true
FROM public.agent_definitions WHERE slug = 'designer'
ON CONFLICT DO NOTHING;

-- Executive Assistant: Google Calendar, Gmail, Google Docs, Google Sheets, Granola
INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, is_enabled)
SELECT id, unnest(ARRAY['googlecalendar','gmail','googledocs','googlesheets','granola']),
       'composio', 'composio', true
FROM public.agent_definitions WHERE slug = 'executive-assistant'
ON CONFLICT DO NOTHING;
