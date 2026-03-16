-- Composio tool gateway: add routing columns and seed per-agent tool assignments

-- 0. Drop any dashboard-added check constraint on tool_type
ALTER TABLE public.agent_tools DROP CONSTRAINT IF EXISTS agent_tools_tool_type_check;

-- 1. Add new columns to agent_tools
ALTER TABLE public.agent_tools
  ADD COLUMN IF NOT EXISTS connection_source TEXT NOT NULL DEFAULT 'internal',
  ADD COLUMN IF NOT EXISTS composio_action_id TEXT,
  ADD COLUMN IF NOT EXISTS tool_schema JSONB;

CREATE INDEX IF NOT EXISTS idx_agent_tools_connection_source ON public.agent_tools(connection_source);

-- 2. Seed Orchestrator tools
INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, tool_schema, is_enabled)
SELECT id, 'web_search', 'search', 'direct',
  '{"name":"web_search","description":"Search the web for current information. Use for market research, competitor analysis, news, and any real-time data.","input_schema":{"type":"object","properties":{"query":{"type":"string","description":"The search query"}},"required":["query"]}}'::jsonb,
  true
FROM public.agent_definitions WHERE slug = 'orchestrator'
ON CONFLICT DO NOTHING;

INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, tool_schema, is_enabled)
SELECT id, 'database_query', 'database', 'internal',
  '{"name":"database_query","description":"Query the business database. Tables: agents, tasks, chat_messages, conversations, metrics, agent_definitions, memories, users. Returns JSON rows.","input_schema":{"type":"object","properties":{"table":{"type":"string","description":"Table name to query"},"select":{"type":"string","description":"Columns to select (default: *)"},"filters":{"type":"array","description":"Array of filter objects: { column, operator, value }","items":{"type":"object","properties":{"column":{"type":"string"},"operator":{"type":"string"},"value":{"type":"string"}},"required":["column","operator","value"]}},"order_by":{"type":"string","description":"Column to order by"},"ascending":{"type":"boolean","description":"Sort direction (default: true)"},"limit":{"type":"number","description":"Max rows to return (default: 25)"}},"required":["table"]}}'::jsonb,
  true
FROM public.agent_definitions WHERE slug = 'orchestrator'
ON CONFLICT DO NOTHING;

INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, tool_schema, is_enabled)
SELECT id, 'create_task', 'task', 'internal',
  '{"name":"create_task","description":"Create a new task for an agent. Use this to delegate work to specialist agents (engineering, growth, sales, research, outreach).","input_schema":{"type":"object","properties":{"title":{"type":"string","description":"Task title"},"description":{"type":"string","description":"Detailed task description"},"agent_slug":{"type":"string","description":"Target agent slug: orchestrator, engineering, growth, sales, research, outreach"},"priority":{"type":"number","description":"Priority 0-10 (default: 5)"}},"required":["title","description","agent_slug"]}}'::jsonb,
  true
FROM public.agent_definitions WHERE slug = 'orchestrator'
ON CONFLICT DO NOTHING;

INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, tool_schema, is_enabled)
SELECT id, 'delegate_task', 'task', 'internal',
  '{"name":"delegate_task","description":"Delegate a task to a specialist sub-agent and wait for the result. The sub-agent will execute the task autonomously and return its output.","input_schema":{"type":"object","properties":{"agent_slug":{"type":"string","description":"Target agent: engineering, growth, sales, research, outreach"},"instruction":{"type":"string","description":"Detailed instruction for the sub-agent"},"context":{"type":"string","description":"Additional context from the current conversation to pass along"}},"required":["agent_slug","instruction"]}}'::jsonb,
  true
FROM public.agent_definitions WHERE slug = 'orchestrator'
ON CONFLICT DO NOTHING;

INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, tool_schema, is_enabled)
SELECT id, 'store_memory', 'memory', 'internal',
  '{"name":"store_memory","description":"Store an important fact, preference, or insight for future reference. Memories persist across conversations.","input_schema":{"type":"object","properties":{"content":{"type":"string","description":"The fact/insight to remember"},"category":{"type":"string","description":"Category: business_context, user_preference, market_intel, decision, contact, metric"},"importance":{"type":"number","description":"Importance 0-10 (default: 5)"}},"required":["content","category"]}}'::jsonb,
  true
FROM public.agent_definitions WHERE slug = 'orchestrator'
ON CONFLICT DO NOTHING;

INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, tool_schema, is_enabled)
SELECT id, 'recall_memories', 'memory', 'internal',
  '{"name":"recall_memories","description":"Search stored memories for relevant context. Use before answering questions about the business, user preferences, or past decisions.","input_schema":{"type":"object","properties":{"query":{"type":"string","description":"What to search for in memories"},"category":{"type":"string","description":"Optional category filter"},"limit":{"type":"number","description":"Max memories to return (default: 10)"}},"required":["query"]}}'::jsonb,
  true
FROM public.agent_definitions WHERE slug = 'orchestrator'
ON CONFLICT DO NOTHING;

-- 3. Seed Sales agent tools (Apollo + internal)
INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, composio_action_id, tool_schema, is_enabled)
SELECT id, 'apollo_people_search', 'search', 'composio', 'APOLLO_PEOPLE_SEARCH',
  '{"name":"apollo_people_search","description":"Search Apollo contact database for people. Filter by job title, seniority, location, company domain, industry. Returns names, titles, emails, companies.","input_schema":{"type":"object","properties":{"person_titles":{"type":"array","items":{"type":"string"},"description":"Job titles to search for (e.g. CEO, CTO, VP Engineering)"},"person_seniorities":{"type":"array","items":{"type":"string"},"description":"Seniority levels: owner, founder, c_suite, partner, vp, head, director, manager, senior, entry"},"q_organization_domains":{"type":"array","items":{"type":"string"},"description":"Company domains to filter by (e.g. google.com)"},"organization_locations":{"type":"array","items":{"type":"string"},"description":"Company locations (e.g. United Kingdom, London)"},"organization_num_employees_ranges":{"type":"array","items":{"type":"string"},"description":"Employee count ranges (e.g. 1,10 or 11,50 or 51,200 or 201,500 or 501,1000)"},"per_page":{"type":"number","description":"Results per page (default: 10, max: 100)"},"page":{"type":"number","description":"Page number (default: 1)"}},"required":[]}}'::jsonb,
  true
FROM public.agent_definitions WHERE slug = 'sales'
ON CONFLICT DO NOTHING;

INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, composio_action_id, tool_schema, is_enabled)
SELECT id, 'apollo_org_search', 'search', 'composio', 'APOLLO_ORGANIZATION_SEARCH',
  '{"name":"apollo_org_search","description":"Search Apollo for companies/organizations. Filter by name, industry, location, employee count, revenue. Returns company profiles.","input_schema":{"type":"object","properties":{"q_organization_name":{"type":"string","description":"Company name to search for"},"organization_locations":{"type":"array","items":{"type":"string"},"description":"Locations (e.g. United Kingdom, California)"},"organization_num_employees_ranges":{"type":"array","items":{"type":"string"},"description":"Employee count ranges (e.g. 1,10 or 51,200)"},"q_organization_keyword_tags":{"type":"array","items":{"type":"string"},"description":"Industry/keyword tags"},"per_page":{"type":"number","description":"Results per page (default: 10)"},"page":{"type":"number","description":"Page number (default: 1)"}},"required":[]}}'::jsonb,
  true
FROM public.agent_definitions WHERE slug = 'sales'
ON CONFLICT DO NOTHING;

INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, composio_action_id, tool_schema, is_enabled)
SELECT id, 'apollo_enrich_person', 'enrichment', 'composio', 'APOLLO_PEOPLE_ENRICHMENT',
  '{"name":"apollo_enrich_person","description":"Enrich a contact with full details from Apollo. Provide an email, LinkedIn URL, or name+company to get comprehensive contact data including email, phone, title, company info.","input_schema":{"type":"object","properties":{"email":{"type":"string","description":"Email address to enrich"},"linkedin_url":{"type":"string","description":"LinkedIn profile URL"},"first_name":{"type":"string","description":"First name (use with last_name and organization)"},"last_name":{"type":"string","description":"Last name"},"organization_name":{"type":"string","description":"Company name"},"domain":{"type":"string","description":"Company domain"}},"required":[]}}'::jsonb,
  true
FROM public.agent_definitions WHERE slug = 'sales'
ON CONFLICT DO NOTHING;

INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, tool_schema, is_enabled)
SELECT id, 'store_memory', 'memory', 'internal',
  '{"name":"store_memory","description":"Store an important fact, preference, or insight for future reference. Memories persist across conversations.","input_schema":{"type":"object","properties":{"content":{"type":"string","description":"The fact/insight to remember"},"category":{"type":"string","description":"Category: business_context, user_preference, market_intel, decision, contact, metric"},"importance":{"type":"number","description":"Importance 0-10 (default: 5)"}},"required":["content","category"]}}'::jsonb,
  true
FROM public.agent_definitions WHERE slug = 'sales'
ON CONFLICT DO NOTHING;

INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, tool_schema, is_enabled)
SELECT id, 'database_query', 'database', 'internal',
  '{"name":"database_query","description":"Query the business database. Tables: agents, tasks, chat_messages, conversations, metrics, agent_definitions, memories, users. Returns JSON rows.","input_schema":{"type":"object","properties":{"table":{"type":"string","description":"Table name to query"},"select":{"type":"string","description":"Columns to select (default: *)"},"filters":{"type":"array","description":"Array of filter objects: { column, operator, value }","items":{"type":"object","properties":{"column":{"type":"string"},"operator":{"type":"string"},"value":{"type":"string"}},"required":["column","operator","value"]}},"order_by":{"type":"string","description":"Column to order by"},"ascending":{"type":"boolean","description":"Sort direction (default: true)"},"limit":{"type":"number","description":"Max rows to return (default: 25)"}},"required":["table"]}}'::jsonb,
  true
FROM public.agent_definitions WHERE slug = 'sales'
ON CONFLICT DO NOTHING;

-- 4. Seed Outreach agent tools (Instantly + internal)
INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, composio_action_id, tool_schema, is_enabled)
SELECT id, 'instantly_list_campaigns', 'campaign', 'composio', 'INSTANTLY_LIST_CAMPAIGNS',
  '{"name":"instantly_list_campaigns","description":"List all cold email campaigns in Instantly. Returns campaign names, statuses, stats (sent, opened, replied), and IDs.","input_schema":{"type":"object","properties":{"skip":{"type":"number","description":"Number of campaigns to skip (pagination)"},"limit":{"type":"number","description":"Max campaigns to return (default: 10)"}},"required":[]}}'::jsonb,
  true
FROM public.agent_definitions WHERE slug = 'outreach'
ON CONFLICT DO NOTHING;

INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, composio_action_id, tool_schema, is_enabled)
SELECT id, 'instantly_add_leads', 'campaign', 'composio', 'INSTANTLY_ADD_LEADS_BULK',
  '{"name":"instantly_add_leads","description":"Add leads in bulk to an Instantly campaign. Each lead needs an email and can include name, company, and custom variables for personalization.","input_schema":{"type":"object","properties":{"campaign_id":{"type":"string","description":"UUID of the campaign to add leads to"},"leads":{"type":"array","description":"Array of lead objects","items":{"type":"object","properties":{"email":{"type":"string","description":"Lead email address"},"first_name":{"type":"string"},"last_name":{"type":"string"},"company_name":{"type":"string"},"personalization":{"type":"string","description":"Custom personalization snippet"},"custom_variables":{"type":"object","description":"Key-value custom variables for email templates"}},"required":["email"]}},"skip_if_in_workspace":{"type":"boolean","description":"Skip leads already in workspace (default: true)"}},"required":["campaign_id","leads"]}}'::jsonb,
  true
FROM public.agent_definitions WHERE slug = 'outreach'
ON CONFLICT DO NOTHING;

INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, composio_action_id, tool_schema, is_enabled)
SELECT id, 'instantly_create_campaign', 'campaign', 'composio', 'INSTANTLY_CREATE_CAMPAIGN',
  '{"name":"instantly_create_campaign","description":"Create a new cold email campaign in Instantly with email sequences, scheduling, and sending configuration.","input_schema":{"type":"object","properties":{"name":{"type":"string","description":"Campaign name"},"account_ids":{"type":"array","items":{"type":"string"},"description":"Sending account UUIDs to use"},"sequences":{"type":"array","description":"Email sequence steps","items":{"type":"object","properties":{"steps":{"type":"array","items":{"type":"object","properties":{"subject":{"type":"string"},"body":{"type":"string","description":"Email body (supports {{variables}}"},"delay":{"type":"number","description":"Days to wait before sending this step"}}}}}}},"daily_limit":{"type":"number","description":"Max emails per day per account"},"stop_on_reply":{"type":"boolean","description":"Stop sequence when lead replies (default: true)"}},"required":["name"]}}'::jsonb,
  true
FROM public.agent_definitions WHERE slug = 'outreach'
ON CONFLICT DO NOTHING;

INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, tool_schema, is_enabled)
SELECT id, 'store_memory', 'memory', 'internal',
  '{"name":"store_memory","description":"Store an important fact, preference, or insight for future reference. Memories persist across conversations.","input_schema":{"type":"object","properties":{"content":{"type":"string","description":"The fact/insight to remember"},"category":{"type":"string","description":"Category: business_context, user_preference, market_intel, decision, contact, metric"},"importance":{"type":"number","description":"Importance 0-10 (default: 5)"}},"required":["content","category"]}}'::jsonb,
  true
FROM public.agent_definitions WHERE slug = 'outreach'
ON CONFLICT DO NOTHING;

INSERT INTO public.agent_tools (agent_id, tool_name, tool_type, connection_source, tool_schema, is_enabled)
SELECT id, 'database_query', 'database', 'internal',
  '{"name":"database_query","description":"Query the business database. Tables: agents, tasks, chat_messages, conversations, metrics, agent_definitions, memories, users. Returns JSON rows.","input_schema":{"type":"object","properties":{"table":{"type":"string","description":"Table name to query"},"select":{"type":"string","description":"Columns to select (default: *)"},"filters":{"type":"array","description":"Array of filter objects: { column, operator, value }","items":{"type":"object","properties":{"column":{"type":"string"},"operator":{"type":"string"},"value":{"type":"string"}},"required":["column","operator","value"]}},"order_by":{"type":"string","description":"Column to order by"},"ascending":{"type":"boolean","description":"Sort direction (default: true)"},"limit":{"type":"number","description":"Max rows to return (default: 25)"}},"required":["table"]}}'::jsonb,
  true
FROM public.agent_definitions WHERE slug = 'outreach'
ON CONFLICT DO NOTHING;
