// runner.mjs — Executes agent tasks inside a Vercel Sandbox
// Zero external dependencies: uses only Node.js builtins + fetch
import { execSync } from "node:child_process";
import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  readdirSync, statSync,
} from "node:fs";
import { join, dirname } from "node:path";

// ── Environment ─────────────────────────────────────────────────────────────

const TASK_ID          = process.env.TASK_ID;
const CONVERSATION_ID  = process.env.CONVERSATION_ID;
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const SERPER_KEY       = process.env.SERPER_API_KEY || "";
const COMPOSIO_KEY     = process.env.COMPOSIO_API_KEY || "";
const PROJECTS_DB_URL  = process.env.PROJECTS_SUPABASE_URL || "";
const PROJECTS_DB_KEY  = process.env.PROJECTS_SUPABASE_KEY || "";
const SELF_URL         = process.env.SELF_URL || "";

if (!TASK_ID || !SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
  console.error("Missing required env vars");
  process.exit(1);
}

// ── Supabase REST helpers ───────────────────────────────────────────────────

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: "Bearer " + SUPABASE_KEY,
  "Content-Type": "application/json",
};

async function sbGet(table, filters = {}, opts = {}) {
  const params = new URLSearchParams({ select: opts.select || "*" });
  for (const [k, v] of Object.entries(filters)) params.set(k, v);
  if (opts.order) params.set("order", opts.order);
  if (opts.limit) params.set("limit", String(opts.limit));
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + params, { headers: SB_HEADERS });
  if (!r.ok) return null;
  const data = await r.json();
  return opts.single ? (data[0] || null) : data;
}

async function sbInsert(table, row) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + table, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data;
}

async function sbPatch(table, updates, filters = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) params.set(k, v);
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + params, {
    method: "PATCH",
    headers: { ...SB_HEADERS, Prefer: "return=representation" },
    body: JSON.stringify(updates),
  });
  if (!r.ok) return null;
  return await r.json();
}

async function sbRpc(url, key, fn, params) {
  const r = await fetch(url + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: {
      apikey: key, Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  if (!r.ok) return { error: await r.text() };
  return { data: await r.json() };
}

// ── Anthropic API ───────────────────────────────────────────────────────────

async function callClaude(model, system, messages, tools, maxTokens = 4096, temperature = 0.7, mcpServers = []) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const headers = {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
    if (mcpServers.length > 0) {
      headers["anthropic-beta"] = "mcp-client-2025-11-20";
    }

    const body = {
      model, max_tokens: maxTokens, temperature, system, messages,
      ...(tools.length > 0 ? { tools } : {}),
      ...(mcpServers.length > 0 ? { mcp_servers: mcpServers } : {}),
    };

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (resp.ok) return await resp.json();

    const is429 = resp.status === 429;
    const is5xx = resp.status >= 500;
    if ((is429 || is5xx) && attempt < MAX_RETRIES) {
      const wait = is429 ? attempt * 15000 : attempt * 5000;
      await log("API " + resp.status + " — retry " + (attempt + 1) + "/" + MAX_RETRIES + " in " + (wait / 1000) + "s", "error");
      await sleep(wait);
      continue;
    }
    const errBody = await resp.text().catch(() => "");
    throw new Error("Anthropic " + resp.status + ": " + errBody.slice(0, 300));
  }
}

// ── Logging ─────────────────────────────────────────────────────────────────

let agentSlug = "unknown";
let companyId = null;

async function log(message, logType = "info") {
  console.log("[" + logType + "] " + message);
  try {
    await sbInsert("terminal_logs", {
      message, source: "sandbox-runner", agent_slug: agentSlug,
      task_id: TASK_ID, log_type: logType, company_id: companyId,
    });
  } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Tool JSON schemas ───────────────────────────────────────────────────────

const BASE_TOOLS = [
  {
    name: "web_search",
    description: "Search the web for current information using Google.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "The search query" } },
      required: ["query"],
    },
  },
  {
    name: "database_query",
    description: "Query the business database. Tables: agents, tasks, chat_messages, conversations, metrics, agent_definitions, memories, users, companies, company_goals, projects.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string" },
        select: { type: "string", description: 'Columns (default: "*")' },
        filters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              column: { type: "string" },
              operator: { type: "string", description: "PostgREST op: eq, neq, gt, gte, lt, lte, like, ilike" },
              value: { type: "string" },
            },
            required: ["column", "operator", "value"],
          },
        },
        order_by: { type: "string" },
        ascending: { type: "boolean" },
        limit: { type: "number" },
      },
      required: ["table"],
    },
  },
  {
    name: "create_task",
    description: "Propose a new task. Enters the pipeline as 'proposed' and requires user approval.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        agent_slug: { type: "string", description: "Target: orchestrator, engineering, growth, research, designer, executive-assistant" },
        priority: { type: "number" },
      },
      required: ["title", "description", "agent_slug"],
    },
  },
  {
    name: "store_memory",
    description: "Store an important fact or insight for future reference.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string" },
        category: { type: "string", description: "business_context, user_preference, market_intel, decision, contact, metric" },
        importance: { type: "number", description: "0-10, default 5" },
      },
      required: ["content", "category"],
    },
  },
  {
    name: "recall_memories",
    description: "Search stored memories for relevant context.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        category: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "delegate_task",
    description: "Delegate work to a specialist sub-agent. Task runs after current agent finishes.",
    input_schema: {
      type: "object",
      properties: {
        agent_slug: { type: "string", description: "Target: engineering, growth, research, designer, executive-assistant" },
        instruction: { type: "string", description: "Detailed instruction for the sub-agent" },
        context: { type: "string", description: "Additional context" },
      },
      required: ["agent_slug", "instruction"],
    },
  },
  {
    name: "project_query",
    description: "Query the Projects database (agent-built projects). Tables are prefixed with company slug.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Full table name with prefix, e.g. qta_todo_items" },
        select: { type: "string" },
        filters: {
          type: "array",
          items: {
            type: "object",
            properties: { column: { type: "string" }, operator: { type: "string" }, value: { type: "string" } },
            required: ["column", "operator", "value"],
          },
        },
        order_by: { type: "string" },
        ascending: { type: "boolean" },
        limit: { type: "number" },
      },
      required: ["table"],
    },
  },
  {
    name: "fail_task",
    description: "Mark the task as FAILED. Call when you genuinely cannot complete the work after trying tools.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        partial_result: { type: "string" },
        tools_tried: { type: "array", items: { type: "string" } },
      },
      required: ["reason"],
    },
  },
];

const ENGINEERING_TOOLS = [
  {
    name: "github_create_repo",
    description: "Create a new GitHub repository. Returns owner and repo name.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repo name, e.g. 'qta-todo-app'" },
        description: { type: "string" },
        is_private: { type: "boolean" },
      },
      required: ["name"],
    },
  },
  {
    name: "github_push_file",
    description: "Create or update a file in a GitHub repository.",
    input_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        path: { type: "string", description: "File path, e.g. 'src/index.html'" },
        content: { type: "string", description: "File content (plain text)" },
        message: { type: "string", description: "Commit message" },
        branch: { type: "string" },
      },
      required: ["owner", "repo", "path", "content"],
    },
  },
  {
    name: "database_admin",
    description: "Create or alter tables in the Projects database. Tables auto-prefixed with company slug.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create_table", "alter_table", "list_tables"] },
        table_name: { type: "string", description: "Name WITHOUT prefix" },
        columns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" }, type: { type: "string" },
              nullable: { type: "boolean" }, default: { type: "string" },
            },
            required: ["name", "type"],
          },
        },
        sql: { type: "string", description: "Raw ALTER TABLE SQL (table name will be prefixed)" },
      },
      required: ["action"],
    },
  },
  {
    name: "register_project",
    description: "Register a completed project in the platform database.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        repo_url: { type: "string" },
        deploy_url: { type: "string" },
        tables_created: { type: "array", items: { type: "string" } },
        status: { type: "string", enum: ["draft", "building", "live", "archived"] },
      },
      required: ["name"],
    },
  },
  {
    name: "sandbox_bash",
    description: "Run a shell command in the sandbox. Use for building, testing, linting code.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        cwd: { type: "string", description: "Working directory (default: /workspace)" },
      },
      required: ["command"],
    },
  },
  {
    name: "sandbox_read_file",
    description: "Read a file from the sandbox filesystem.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "sandbox_write_file",
    description: "Write a file to the sandbox filesystem. Creates directories automatically.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "sandbox_list_files",
    description: "List files in a directory in the sandbox filesystem.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path (default: /workspace)" } },
      required: [],
    },
  },
];

const DESIGNER_TOOLS = [
  {
    name: "design_system_search",
    description: "Search the design knowledge base for UI styles, palettes, typography, and patterns.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        domain: {
          type: "string",
          enum: ["style", "palette", "typography", "product_rule", "reasoning", "chart", "ux_guideline", "landing_pattern"],
        },
      },
      required: ["query"],
    },
  },
];

const COMPOSIO_TOOLS = [
  {
    name: "composio_find_actions",
    description: "Discover available actions for an external app. Use this before composio_execute to find the right action_id and required parameters.",
    input_schema: {
      type: "object",
      properties: {
        app_name: { type: "string", description: "App name, e.g. 'apollo', 'googledocs', 'linkedin', 'googlesheets', 'agent_mail', 'perplexityai', 'firecrawl', 'exa'" },
        use_case: { type: "string", description: "Describe what you want to do, e.g. 'search for a person by email'. Filters to the most relevant actions." },
      },
      required: ["app_name"],
    },
  },
  {
    name: "composio_execute",
    description: "Execute an action on an external app via Composio. Use composio_find_actions first to discover the correct action_id and parameters.",
    input_schema: {
      type: "object",
      properties: {
        action_id: { type: "string", description: "Action ID from composio_find_actions, e.g. 'GOOGLEDOCS_CREATE_DOCUMENT', 'APOLLO_PEOPLE_SEARCH'" },
        params: { type: "object", description: "Action parameters — check composio_find_actions output for required param names" },
      },
      required: ["action_id", "params"],
    },
  },
];

// ── Tool implementations ────────────────────────────────────────────────────

const childTasks = [];

async function executeTool(name, input) {
  try {
    switch (name) {
      case "web_search":         return await toolWebSearch(input);
      case "database_query":     return await toolDatabaseQuery(input);
      case "create_task":        return await toolCreateTask(input);
      case "store_memory":       return await toolStoreMemory(input);
      case "recall_memories":    return await toolRecallMemories(input);
      case "delegate_task":      return await toolDelegateTask(input);
      case "project_query":      return await toolProjectQuery(input);
      case "database_admin":     return await toolDatabaseAdmin(input);
      case "register_project":   return await toolRegisterProject(input);
      case "github_create_repo": return await toolGitHubCreateRepo(input);
      case "github_push_file":   return await toolGitHubPushFile(input);
      case "design_system_search": return await toolDesignSearch(input);
      case "composio_find_actions": return await toolComposioFindActions(input);
      case "composio_execute":      return await toolComposioExecute(input);
      case "sandbox_bash":       return await toolSandboxBash(input);
      case "sandbox_read_file":  return await toolSandboxReadFile(input);
      case "sandbox_write_file": return await toolSandboxWriteFile(input);
      case "sandbox_list_files": return await toolSandboxListFiles(input);
      case "fail_task":          return JSON.stringify({ acknowledged: true, reason: input.reason });
      default:                   return JSON.stringify({ error: "Unknown tool: " + name });
    }
  } catch (e) {
    return JSON.stringify({ error: name + " failed: " + (e.message || e) });
  }
}

async function toolWebSearch(input) {
  if (!SERPER_KEY) return JSON.stringify({ error: "Web search not configured (SERPER_API_KEY missing)" });
  const r = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": SERPER_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: input.query, num: 5 }),
  });
  if (!r.ok) return JSON.stringify({ error: "Search failed: " + r.status });
  const data = await r.json();
  const results = (data.organic || []).slice(0, 5)
    .map(x => "**" + x.title + "**\n" + x.snippet + "\n" + x.link)
    .join("\n\n");
  return results || "No results found.";
}

async function toolDatabaseQuery(input) {
  const params = new URLSearchParams({ select: input.select || "*" });
  if (input.limit) params.set("limit", String(input.limit));
  else params.set("limit", "25");
  if (input.order_by) params.set("order", input.order_by + "." + (input.ascending === false ? "desc" : "asc"));
  for (const f of (input.filters || [])) params.set(f.column, f.operator + "." + f.value);

  const r = await fetch(SUPABASE_URL + "/rest/v1/" + input.table + "?" + params, { headers: SB_HEADERS });
  if (!r.ok) { const e = await r.text(); return JSON.stringify({ error: e }); }
  return JSON.stringify(await r.json(), null, 2);
}

async function toolCreateTask(input) {
  const agentDef = await sbGet("agent_definitions", {
    slug: "eq." + input.agent_slug, company_id: "eq." + companyId,
  }, { select: "id,name", single: true });
  if (!agentDef) return JSON.stringify({ error: "Agent '" + input.agent_slug + "' not found" });

  const row = {
    title: input.title, description: input.description,
    agent_definition_id: agentDef.id, conversation_id: CONVERSATION_ID,
    parent_task_id: TASK_ID, company_id: companyId,
    priority: input.priority || 5, status: "proposed", source: "chat",
  };
  const result = await sbInsert("tasks", row);
  if (!result) return JSON.stringify({ error: "Failed to create task" });
  return JSON.stringify({ success: true, task_id: result[0]?.id, assigned_to: agentDef.name, status: "proposed" });
}

async function toolStoreMemory(input) {
  const result = await sbInsert("memories", {
    content: input.content, category: input.category,
    importance: input.importance || 5,
    user_id: "00000000-0000-0000-0000-000000000000",
    company_id: companyId, metadata: { source: "agent" },
  });
  if (!result) return JSON.stringify({ error: "Failed to store memory" });
  return JSON.stringify({ success: true, stored: input.content });
}

async function toolRecallMemories(input) {
  const params = new URLSearchParams({
    select: "content,category,importance,created_at",
    order: "importance.desc", limit: String(input.limit || 10),
  });
  if (companyId) params.set("company_id", "eq." + companyId);
  if (input.category) params.set("category", "eq." + input.category);
  params.set("content", "ilike.*" + input.query + "*");

  const r = await fetch(SUPABASE_URL + "/rest/v1/memories?" + params, { headers: SB_HEADERS });
  if (!r.ok) return JSON.stringify({ error: await r.text() });
  const data = await r.json();
  return JSON.stringify({ memories: data, count: data.length });
}

async function toolDelegateTask(input) {
  const agentDef = await sbGet("agent_definitions", {
    slug: "eq." + input.agent_slug, company_id: "eq." + companyId,
  }, { select: "id,name,slug", single: true });
  if (!agentDef) return JSON.stringify({ error: "Agent '" + input.agent_slug + "' not found" });
  if (agentDef.slug === agentSlug) return JSON.stringify({ error: "Cannot delegate to yourself" });

  const result = await sbInsert("tasks", {
    title: "Delegated: " + input.instruction.slice(0, 80),
    description: input.instruction,
    agent_definition_id: agentDef.id, conversation_id: CONVERSATION_ID,
    parent_task_id: TASK_ID, company_id: companyId,
    status: "pending",
    input_data: { instruction: input.instruction, context: input.context || "" },
    source: "agent",
  });
  if (!result) return JSON.stringify({ error: "Failed to create delegated task" });
  childTasks.push({ taskId: result[0].id, conversationId: CONVERSATION_ID });
  return JSON.stringify({ success: true, agent: agentDef.name, task_id: result[0].id, status: "queued" });
}

async function toolProjectQuery(input) {
  if (!PROJECTS_DB_URL || !PROJECTS_DB_KEY) return JSON.stringify({ error: "Projects DB not configured" });
  const params = new URLSearchParams({ select: input.select || "*" });
  params.set("limit", String(input.limit || 25));
  if (input.order_by) params.set("order", input.order_by + "." + (input.ascending === false ? "desc" : "asc"));
  for (const f of (input.filters || [])) params.set(f.column, f.operator + "." + f.value);

  const r = await fetch(PROJECTS_DB_URL + "/rest/v1/" + input.table + "?" + params, {
    headers: { apikey: PROJECTS_DB_KEY, Authorization: "Bearer " + PROJECTS_DB_KEY },
  });
  if (!r.ok) return JSON.stringify({ error: await r.text() });
  return JSON.stringify(await r.json(), null, 2);
}

async function toolDatabaseAdmin(input) {
  if (!PROJECTS_DB_URL || !PROJECTS_DB_KEY) return JSON.stringify({ error: "Projects DB not configured" });

  const company = await sbGet("companies", { id: "eq." + companyId }, { select: "slug", single: true });
  const slug = company?.slug || "default";
  const action = input.action;

  if (action === "list_tables") {
    const { data, error } = await sbRpc(PROJECTS_DB_URL, PROJECTS_DB_KEY, "exec_sql", {
      query: "SELECT json_agg(table_name) as tables FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '" + slug + "_%'",
    });
    if (error) return JSON.stringify({ error: "list_tables failed: " + error });
    return JSON.stringify(data);
  }

  if (!input.table_name) return JSON.stringify({ error: "table_name required" });
  const fullName = slug + "_" + input.table_name;

  if (action === "create_table") {
    const cols = (input.columns || []).filter(c => c.name !== "id" && c.name !== "created_at");
    if (!cols.length) return JSON.stringify({ error: "columns array required" });
    const colDefs = cols.map(c => {
      let d = '"' + c.name + '" ' + c.type;
      if (c.nullable === false) d += " NOT NULL";
      if (c.default) d += " DEFAULT " + c.default;
      return d;
    });
    const sql = 'CREATE TABLE IF NOT EXISTS public."' + fullName + '" (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ' + colDefs.join(", ") + ', created_at TIMESTAMPTZ NOT NULL DEFAULT now())';
    const { error } = await sbRpc(PROJECTS_DB_URL, PROJECTS_DB_KEY, "exec_sql", { query: sql });
    if (error) return JSON.stringify({ error: "create_table failed: " + error, sql });

    await sbRpc(PROJECTS_DB_URL, PROJECTS_DB_KEY, "exec_sql", { query: 'ALTER TABLE public."' + fullName + '" ENABLE ROW LEVEL SECURITY' });
    await sbRpc(PROJECTS_DB_URL, PROJECTS_DB_KEY, "exec_sql", {
      query: "DO $$ BEGIN CREATE POLICY \"Allow all on " + fullName + "\" ON public.\"" + fullName + "\" FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$",
    });
    await sbRpc(PROJECTS_DB_URL, PROJECTS_DB_KEY, "exec_sql", { query: "NOTIFY pgrst, 'reload schema'" });
    return JSON.stringify({ success: true, table: fullName, columns: cols.map(c => c.name) });
  }

  if (action === "alter_table") {
    if (input.sql) {
      const safeSql = input.sql.replace(new RegExp(input.table_name, "g"), fullName);
      const { error } = await sbRpc(PROJECTS_DB_URL, PROJECTS_DB_KEY, "exec_sql", { query: safeSql });
      if (error) return JSON.stringify({ error: "alter_table failed: " + error });
      return JSON.stringify({ success: true, table: fullName });
    }
    if (input.columns?.length) {
      const adds = input.columns.map(c =>
        'ADD COLUMN IF NOT EXISTS "' + c.name + '" ' + c.type +
        (c.nullable === false ? " NOT NULL" : "") +
        (c.default ? " DEFAULT " + c.default : "")
      );
      const sql = 'ALTER TABLE public."' + fullName + '" ' + adds.join(", ");
      const { error } = await sbRpc(PROJECTS_DB_URL, PROJECTS_DB_KEY, "exec_sql", { query: sql });
      if (error) return JSON.stringify({ error: "alter_table failed: " + error });
      return JSON.stringify({ success: true, table: fullName });
    }
    return JSON.stringify({ error: "columns or sql required for alter_table" });
  }

  return JSON.stringify({ error: "Unknown action: " + action });
}

async function toolRegisterProject(input) {
  const result = await sbInsert("projects", {
    company_id: companyId, name: input.name,
    description: input.description || null,
    repo_url: input.repo_url || null,
    deploy_url: input.deploy_url || null,
    tables_created: input.tables_created || [],
    status: input.status || "building",
    created_by_task_id: TASK_ID,
  });
  if (!result) return JSON.stringify({ error: "Failed to register project" });
  return JSON.stringify({ success: true, project_id: result[0]?.id });
}

// ── Composio account cache ──────────────────────────────────────────────────

let _composioAccountsCache = null;

async function getComposioAccounts() {
  if (_composioAccountsCache) return _composioAccountsCache;
  if (!COMPOSIO_KEY) return [];
  try {
    const r = await fetch("https://backend.composio.dev/api/v1/connectedAccounts?showActiveOnly=true", {
      headers: { "x-api-key": COMPOSIO_KEY },
    });
    if (!r.ok) return [];
    const data = await r.json();
    _composioAccountsCache = data.items || data || [];
    return _composioAccountsCache;
  } catch {
    return [];
  }
}

async function getComposioAccount(appName) {
  const accounts = await getComposioAccounts();
  return accounts.find(a => a.appName === appName && a.status === "ACTIVE") || null;
}

// ── GitHub tools (Composio REST API) ────────────────────────────────────────

async function getComposioGitHub() {
  const acct = await getComposioAccount("github");
  return acct ? { id: acct.id, key: COMPOSIO_KEY } : null;
}

async function composioExec(action, input, accountId) {
  const r = await fetch("https://backend.composio.dev/api/v2/actions/" + action + "/execute", {
    method: "POST",
    headers: { "x-api-key": COMPOSIO_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ connectedAccountId: accountId, input }),
  });
  return await r.json();
}

async function toolGitHubCreateRepo(input) {
  const acct = await getComposioGitHub();
  if (!acct) return JSON.stringify({ error: "No active GitHub connection in Composio" });

  const result = await composioExec(
    "GITHUB_CREATE_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER",
    { name: input.name, description: input.description || "", private: input.is_private || false, auto_init: true },
    acct.id,
  );

  if (result.successful === false) return JSON.stringify({ error: "Create repo failed: " + JSON.stringify(result).slice(0, 300) });

  const repo = result.data || {};
  const owner = repo.owner?.login || (repo.full_name || "").split("/")[0] || "";
  return JSON.stringify({
    success: true, owner, name: input.name,
    html_url: repo.html_url || repo.url,
    full_name: repo.full_name,
    note: 'Use owner="' + owner + '" and repo="' + input.name + '" for github_push_file.',
  });
}

async function toolGitHubPushFile(input) {
  const acct = await getComposioGitHub();
  if (!acct) return JSON.stringify({ error: "No active GitHub connection" });

  const b64 = Buffer.from(input.content, "utf-8").toString("base64");
  const params = {
    owner: input.owner, repo: input.repo, path: input.path,
    message: input.message || "Add " + input.path,
    content: b64, branch: input.branch || "main",
  };

  let result = await composioExec("GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS", params, acct.id);

  if (result.successful === false) {
    const errStr = JSON.stringify(result).slice(0, 400);
    if (errStr.includes("sha") || errStr.includes("already exists")) {
      const getResult = await composioExec("GITHUB_GET_REPOSITORY_CONTENT", {
        owner: input.owner, repo: input.repo, path: input.path,
      }, acct.id);
      const sha = getResult.data?.sha || getResult.data?.details?.sha;
      if (sha) {
        result = await composioExec("GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS", { ...params, sha }, acct.id);
        if (result.successful === false) return JSON.stringify({ error: "Update failed: " + JSON.stringify(result).slice(0, 300) });
        return JSON.stringify({ success: true, path: input.path, action: "updated" });
      }
    }
    return JSON.stringify({ error: "Push failed: " + errStr });
  }
  return JSON.stringify({ success: true, path: input.path, action: "created" });
}

// ── Design search ───────────────────────────────────────────────────────────

const DOMAIN_MAP = {
  style: "uiux-pro-max/styles", palette: "uiux-pro-max/palettes",
  typography: "uiux-pro-max/typography", product_rule: "uiux-pro-max/product-rules",
  reasoning: "uiux-pro-max/reasoning", chart: "uiux-pro-max/charts",
  ux_guideline: "uiux-pro-max/ux-guidelines", landing_pattern: "uiux-pro-max/landing-patterns",
};

async function toolDesignSearch(input) {
  const params = new URLSearchParams({
    select: "source_name,content", source_type: "eq.skill-data",
    content: "ilike.*" + input.query + "*", limit: "10",
  });
  if (input.domain && DOMAIN_MAP[input.domain]) params.set("source_name", "eq." + DOMAIN_MAP[input.domain]);

  const r = await fetch(SUPABASE_URL + "/rest/v1/knowledge_chunks?" + params, { headers: SB_HEADERS });
  if (!r.ok) return JSON.stringify({ error: await r.text() });
  const data = await r.json();
  return JSON.stringify({ results: data.map(d => ({ domain: d.source_name, content: d.content })) });
}

// ── Composio generic tools ──────────────────────────────────────────────────

async function toolComposioFindActions(input) {
  if (!COMPOSIO_KEY) return JSON.stringify({ error: "Composio not configured (COMPOSIO_API_KEY missing)" });

  const params = new URLSearchParams({ limit: "15" });
  params.set("apps", input.app_name.toUpperCase());
  if (input.use_case) params.set("useCase", input.use_case);

  const r = await fetch("https://backend.composio.dev/api/v2/actions?" + params, {
    headers: { "x-api-key": COMPOSIO_KEY },
  });
  if (!r.ok) return JSON.stringify({ error: "Failed to list actions: " + r.status + " " + (await r.text()).slice(0, 200) });

  const data = await r.json();
  const items = data.items || data || [];
  const actions = items.slice(0, 15).map(a => ({
    action_id: a.name || a.enum || a.actionId,
    display_name: a.displayName || a.display_name || "",
    description: (a.description || "").slice(0, 200),
    parameters: Object.keys(a.parameters?.properties || {}).slice(0, 15),
    required: a.parameters?.required || [],
  }));

  return JSON.stringify({ app: input.app_name, action_count: actions.length, actions });
}

async function toolComposioExecute(input) {
  if (!COMPOSIO_KEY) return JSON.stringify({ error: "Composio not configured" });

  const actionUpper = input.action_id.toUpperCase();
  const accounts = await getComposioAccounts();

  let account = null;
  const parts = actionUpper.split("_");
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join("_").toLowerCase();
    account = accounts.find(a => a.appName === prefix && a.status === "ACTIVE");
    if (account) break;
    const noUnderscore = prefix.replace(/_/g, "");
    account = accounts.find(a => a.appName === noUnderscore && a.status === "ACTIVE");
    if (account) break;
    account = accounts.find(a => a.appName.replace(/[_-]/g, "") === noUnderscore && a.status === "ACTIVE");
    if (account) break;
  }

  if (!account) {
    const available = [...new Set(accounts.filter(a => a.status === "ACTIVE").map(a => a.appName))];
    return JSON.stringify({
      error: "No active connection for action: " + input.action_id,
      available_apps: available,
    });
  }

  await log("Composio exec: " + input.action_id + " via account " + account.appName, "composio_exec");
  const result = await composioExec(input.action_id, input.params || {}, account.id);

  if (result.successful === false) {
    return JSON.stringify({ error: "Action failed: " + JSON.stringify(result).slice(0, 500) });
  }

  const output = result.data || result;
  return JSON.stringify({ success: true, data: typeof output === "string" ? output.slice(0, 8000) : output });
}

// ── Sandbox filesystem tools (engineering agent only) ───────────────────────

function toolSandboxBash(input) {
  try {
    const cwd = input.cwd || process.cwd();
    const stdout = execSync(input.command, {
      cwd,
      encoding: "utf-8",
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
      shell: true,
    });
    return JSON.stringify({ stdout: stdout.slice(0, 8000) });
  } catch (e) {
    return JSON.stringify({
      error: (e.message || "").slice(0, 500),
      stdout: (e.stdout || "").slice(0, 4000),
      stderr: (e.stderr || "").slice(0, 4000),
      exitCode: e.status,
    });
  }
}

function toolSandboxReadFile(input) {
  try {
    if (!existsSync(input.path)) return JSON.stringify({ error: "File not found: " + input.path });
    const content = readFileSync(input.path, "utf-8");
    return JSON.stringify({ content: content.slice(0, 20000), truncated: content.length > 20000 });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

function toolSandboxWriteFile(input) {
  try {
    const dir = dirname(input.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(input.path, input.content);
    return JSON.stringify({ success: true, path: input.path, bytes: input.content.length });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

function toolSandboxListFiles(input) {
  try {
    const dir = input.path || process.cwd();
    if (!existsSync(dir)) return JSON.stringify({ error: "Directory not found: " + dir });
    const entries = readdirSync(dir).map(name => {
      try {
        const s = statSync(join(dir, name));
        return { name, type: s.isDirectory() ? "dir" : "file", size: s.size };
      } catch { return { name, type: "unknown" }; }
    });
    return JSON.stringify({ path: dir, entries });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

// ── Agentic loop ────────────────────────────────────────────────────────────

async function runLoop(model, systemPrompt, messages, tools, maxTurns, temperature, mcpServers = []) {
  const allToolCalls = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    await log("Turn " + (turn + 1) + "/" + maxTurns + " — calling " + model);

    const response = await callClaude(model, systemPrompt, messages, tools, 4096, temperature, mcpServers);

    const mcpCalls = response.content.filter(b => b.type === "mcp_tool_use");
    for (const block of mcpCalls) {
      await log("MCP Tool: " + block.name + " on " + (block.server_name || "mcp"), "mcp_tool_call");
      allToolCalls.push({ tool: block.name, input: block.input, output: "(MCP-executed)", source: "mcp:" + (block.server_name || "unknown") });
    }

    const toolBlocks = response.content.filter(b => b.type === "tool_use");

    if (response.stop_reason === "tool_use" && toolBlocks.length > 0) {
      const failBlock = toolBlocks.find(b => b.name === "fail_task");
      if (failBlock) {
        return {
          status: "failed",
          text: failBlock.input.reason || "Agent could not complete",
          partial: failBlock.input.partial_result,
          toolCalls: allToolCalls,
          turns: turn + 1,
        };
      }

      messages.push({ role: "assistant", content: response.content });

      const results = [];
      for (const block of toolBlocks) {
        const inputPreview = JSON.stringify(block.input).slice(0, 120);
        await log("Tool: " + block.name + " — " + inputPreview, "tool_call");

        const output = await executeTool(block.name, block.input);
        const outputPreview = output.slice(0, 120);
        await log("Result: " + outputPreview, "tool_result");

        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
        allToolCalls.push({ tool: block.name, input: block.input, output: output.slice(0, 300), source: "local" });
      }

      messages.push({ role: "user", content: results });
      continue;
    }

    const text = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("") || "Task completed but no text output was produced.";

    return { status: "completed", text, toolCalls: allToolCalls, turns: turn + 1 };
  }

  return {
    status: "max_turns",
    text: "Hit maximum turns (" + maxTurns + "). Tools used: " + allToolCalls.map(t => t.tool).join(", "),
    toolCalls: allToolCalls,
    turns: maxTurns,
  };
}

// ── Quality review (for delegated tasks) ────────────────────────────────────

async function verifyEngineering(toolCalls) {
  const checks = [];

  const sandboxTools = toolCalls.filter(t =>
    t.tool.startsWith("sandbox_") || t.tool === "github_push_file" || t.tool === "github_create_repo"
  );
  if (sandboxTools.length === 0) {
    checks.push({ pass: false, msg: "No sandbox or GitHub tools used — agent described but didn't build" });
  } else {
    checks.push({ pass: true, msg: sandboxTools.length + " build/push tool calls made" });
  }

  const projects = await sbGet("projects", { created_by_task_id: "eq." + TASK_ID });
  if (!projects?.length) {
    checks.push({ pass: false, msg: "No project registered via register_project" });
  } else {
    const p = projects[0];
    checks.push({ pass: true, msg: "Project registered: " + p.name });
    if (p.deploy_url) {
      try {
        const r = await fetch(p.deploy_url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(10000) });
        checks.push({ pass: r.ok, msg: "Deploy URL " + p.deploy_url + " → " + r.status });
      } catch (e) {
        checks.push({ pass: false, msg: "Deploy URL unreachable: " + (e.message || "").slice(0, 80) });
      }
    }
    if (p.repo_url) {
      checks.push({ pass: true, msg: "Repo: " + p.repo_url });
    }
  }

  return checks;
}

async function verifyResearch(resultText, toolCalls) {
  const checks = [];

  const searchCalls = toolCalls.filter(t => t.tool === "web_search" || t.tool === "composio_execute");
  if (searchCalls.length === 0) {
    checks.push({ pass: false, msg: "No search or external tool calls — agent didn't actually research" });
  } else {
    checks.push({ pass: true, msg: searchCalls.length + " search/external tool calls made" });
  }

  const urlPattern = /https?:\/\/[^\s)]+/g;
  const urls = resultText.match(urlPattern) || [];
  if (urls.length === 0) {
    checks.push({ pass: false, msg: "No URLs or sources cited in the response" });
  } else {
    checks.push({ pass: true, msg: urls.length + " source URL(s) cited" });
  }

  if (resultText.length < 200) {
    checks.push({ pass: false, msg: "Response too short (" + resultText.length + " chars) for a research task" });
  }

  return checks;
}

async function reviewResult(agentName, instruction, resultText, resultStatus, toolCalls) {
  try {
    let verificationChecks = [];

    if (agentSlug === "engineering") {
      verificationChecks = await verifyEngineering(toolCalls || []);
    } else if (agentSlug === "research" || agentSlug === "growth") {
      verificationChecks = await verifyResearch(resultText, toolCalls || []);
    }

    const hardFails = verificationChecks.filter(c => !c.pass);
    if (hardFails.length > 0) {
      const failSummary = hardFails.map(f => f.msg).join("; ");
      await log("Verification FAILED: " + failSummary, "review_verification");
      return { accepted: false, summary: "Failed verification: " + failSummary };
    }

    if (verificationChecks.length > 0) {
      await log("Verification passed: " + verificationChecks.map(c => c.msg).join(", "), "review_verification");
    }

    const verificationContext = verificationChecks.length > 0
      ? "\n\nAutomated checks (all passed):\n" + verificationChecks.map(c => "✓ " + c.msg).join("\n")
      : "";

    const prompt = "Agent: " + agentName + "\nTask: " + instruction +
      "\nResult (" + resultStatus + "):\n" + resultText.slice(0, 3000) +
      verificationContext +
      "\n\nEvaluate whether the agent delivered real, actionable results (not just descriptions of what it WOULD do)." +
      "\nIf the agent delivered substantive results with real data/output, respond with ACCEPT: followed by a 2-sentence summary." +
      "\nIf the output is vague, generic, or describes actions without actually performing them, respond with REJECT: followed by explanation.";

    const resp = await callClaude("claude-sonnet-4-20250514", "You evaluate AI agent work quality. Be strict — 'completed' must mean real deliverables, not promises.", [
      { role: "user", content: prompt },
    ], [], 512, 0.3);

    const verdict = resp.content.find(b => b.type === "text")?.text || "";
    if (verdict.startsWith("ACCEPT:")) return { accepted: true, summary: verdict.slice(7).trim() };
    if (verdict.startsWith("REJECT:")) return { accepted: false, summary: verdict.slice(7).trim() };
    return { accepted: true, summary: resultText.slice(0, 200) };
  } catch {
    return { accepted: true, summary: resultText.slice(0, 200) };
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  await log("Sandbox runner started for task " + TASK_ID.slice(0, 8));

  // 1. Load task
  const task = await sbGet("tasks", { id: "eq." + TASK_ID }, { single: true });
  if (!task) throw new Error("Task not found: " + TASK_ID);
  companyId = task.company_id;

  // 2. Load agent definition
  let systemPrompt = "You are the Orchestrator of a Cyber Business OS — the CEO's AI right hand. Be direct and concise. Lead with action.";
  let model = "claude-sonnet-4-20250514";
  let temperature = 0.7;
  let maxTurns = 15;
  let agentDefId = null;

  if (task.agent_definition_id) {
    const def = await sbGet("agent_definitions", { id: "eq." + task.agent_definition_id }, { single: true });
    if (def) {
      systemPrompt = def.system_prompt || systemPrompt;
      model = def.model || model;
      temperature = parseFloat(def.temperature) || temperature;
      maxTurns = def.max_turns || maxTurns;
      agentDefId = def.id;
      agentSlug = def.slug || "unknown";
      await log("Agent: " + def.name + " (" + agentSlug + ") — model: " + model, "agent_loaded");
    }
  }

  // 3. Resolve company and inject context
  if (!companyId && agentDefId) {
    const agentRow = await sbGet("agent_definitions", { id: "eq." + agentDefId }, { select: "company_id", single: true });
    companyId = agentRow?.company_id || null;
  }
  companyId = companyId || "11111111-1111-1111-1111-111111111111";

  const company = await sbGet("companies", { id: "eq." + companyId }, { select: "name,brief", single: true });
  if (company?.brief) {
    const b = company.brief;
    const parts = [];
    if (b.what_we_do) parts.push("Business: " + b.what_we_do);
    if (b.stage) parts.push("Stage: " + b.stage);
    if (b.target_customers) parts.push("Customers: " + b.target_customers);
    if (b.tone_of_voice) parts.push("Tone: " + b.tone_of_voice);
    if (b.context_notes) parts.push("Notes: " + b.context_notes);
    if (parts.length) systemPrompt += "\n\n## Company Context (" + company.name + ")\n" + parts.join("\n");
  }

  const goals = await sbGet("company_goals", {
    company_id: "eq." + companyId, status: "eq.active",
  }, { order: "priority.asc" });
  if (goals?.length) {
    const lines = goals.map((g, i) =>
      (i + 1) + ". " + g.title +
      (g.target_metric ? " (" + (g.current_value ?? 0) + "/" + (g.target_value ?? "?") + " " + g.target_metric + ")" : "") +
      (g.timeframe ? " — " + g.timeframe : "")
    );
    systemPrompt += "\n\n## Active Goals\n" + lines.join("\n");
  }

  // 4. Load external integrations

  // 4a. Composio — auto-discover ALL active connected apps
  let composioApps = [];
  if (COMPOSIO_KEY) {
    const accounts = await getComposioAccounts();
    composioApps = [...new Set(accounts.filter(a => a.status === "ACTIVE").map(a => a.appName))];
    if (composioApps.length > 0) {
      await log("Composio apps: " + composioApps.join(", "), "composio_loaded");
    }
  }

  // 4b. MCP servers — load from agent_tools where auth token is stored
  const mcpServers = [];
  const mcpToolsets = [];
  if (agentDefId) {
    const mcpTools = await sbGet("agent_tools", {
      agent_id: "eq." + agentDefId,
      is_enabled: "eq.true",
      "mcp_server_url": "not.is.null",
    });
    for (const t of (mcpTools || [])) {
      if (t.mcp_server_url && t.config?.authorization_token) {
        const serverName = (t.tool_name || "mcp").toLowerCase().replace(/\s+/g, "-");
        mcpServers.push({
          type: "url",
          url: t.mcp_server_url,
          name: serverName,
          authorization_token: t.config.authorization_token,
        });
        mcpToolsets.push({ type: "mcp_toolset", mcp_server_name: serverName });
      }
    }
    if (mcpServers.length > 0) {
      await log("MCP servers: " + mcpServers.map(s => s.name).join(", "), "mcp_loaded");
    }
  }

  // 4c. Inject external integrations into system prompt
  if (composioApps.length > 0) {
    systemPrompt += "\n\n## External Integrations (via Composio)\n" +
      "You have access to these external services. Use composio_find_actions(app_name, use_case) to discover available operations, then composio_execute(action_id, params) to run them.\n" +
      "Connected apps: " + composioApps.join(", ") + "\n" +
      "Workflow: 1) composio_find_actions → 2) composio_execute. Always discover actions first — do NOT guess action IDs.";
  }
  if (mcpServers.length > 0) {
    systemPrompt += "\n\n## MCP Tool Servers (auto-discovered)\n" +
      "You have direct access to tools from: " + mcpServers.map(s => s.name).join(", ") + ". These tools are automatically available — just use them.";
  }

  // 4d. Load skills assigned to this agent
  if (agentDefId) {
    const links = await sbGet("agent_skill_links", {
      agent_definition_id: "eq." + agentDefId,
      is_active: "eq.true",
      select: "skill_id",
    });
    if (links && links.length > 0) {
      const skillIds = links.map(l => l.skill_id);
      const skills = await sbGet("skills", { id: "in.(" + skillIds.join(",") + ")" });
      if (skills && skills.length > 0) {
        systemPrompt += "\n\n## Installed Skills\nFollow these skill instructions carefully:\n";
        for (const skill of skills) {
          systemPrompt += "\n### " + skill.name + "\n" + skill.content + "\n";
        }
        await log("Loaded " + skills.length + " skill(s): " + skills.map(s => s.name).join(", "), "skills_loaded");
      }
    }
  }

  // 5. Operational rules
  systemPrompt += "\n\n## Operational Rules (MUST FOLLOW)\n" +
    "1. EXECUTE, don't describe. Use tools to do real work.\n" +
    "2. Exhaust alternatives. If one tool fails, try another. web_search always works.\n" +
    "3. NEVER output auth links, setup URLs, or 'please connect' messages.\n" +
    "4. If genuinely stuck after trying tools, call fail_task. Don't just admit failure in text.\n" +
    "5. 'Completed' means you delivered real results, not setup instructions.";

  if (agentSlug === "engineering") {
    systemPrompt = "You are the Engineering Agent. You BUILD things. You have a full sandbox environment with filesystem, shell, and GitHub access.\n\n" +
      "CRITICAL: You MUST use your tools to write actual code, test it, and push it. NEVER just describe what you would build. ALWAYS build it.\n\n" +
      systemPrompt +
      "\n\n## Engineering Workflow (FOLLOW THIS EXACTLY)\n" +
      "Step 1: Write all code files using sandbox_write_file (use relative paths like 'project/index.html')\n" +
      "Step 2: Run and test with sandbox_bash (e.g. 'cat project/index.html' to verify)\n" +
      "Step 3: Fix any errors found\n" +
      "Step 4: Create a GitHub repo with github_create_repo\n" +
      "Step 5: Push each file with github_push_file\n" +
      "Step 6: Register the project with register_project\n\n" +
      "You MUST complete ALL steps. A text description of what you WOULD build is NOT acceptable output.";
  }

  // 6. Select tools for this agent
  const tools = [...BASE_TOOLS];
  if (agentSlug === "engineering") tools.push(...ENGINEERING_TOOLS);
  if (agentSlug === "designer") tools.push(...DESIGNER_TOOLS);
  if (composioApps.length > 0) tools.push(...COMPOSIO_TOOLS);
  if (mcpToolsets.length > 0) tools.push(...mcpToolsets);

  // 7. Build conversation
  let rawInput = task.input_data;
  if (typeof rawInput === "string") try { rawInput = JSON.parse(rawInput); } catch {}
  const instruction = rawInput?.instruction || task.description || task.title || "Execute the task";

  const history = await sbGet("chat_messages", {
    conversation_id: "eq." + CONVERSATION_ID,
  }, { select: "role,content", order: "created_at.asc" }) || [];

  const messages = history.map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content || "",
  }));

  // Ensure proper alternation and inject task instruction
  if (messages.length > 0 && messages[messages.length - 1].role === "user") {
    messages.push({ role: "assistant", content: "Understood. I'll work on this now." });
  }
  messages.push({
    role: "user",
    content: "YOUR TASK: " + instruction + "\n\nUse your available tools to complete this. Do NOT just describe what you would do — actually do it.",
  });

  if (messages.length === 0) {
    messages.push({ role: "user", content: "Execute: " + (task.title || "No details provided.") });
  }

  // 8. Inject relevant memories
  const keywords = instruction.split(/\s+/).filter(w => w.length > 3).slice(0, 5);
  if (keywords.length > 0) {
    const memParams = new URLSearchParams({
      select: "content,category", order: "importance.desc", limit: "8",
    });
    if (companyId) memParams.set("company_id", "eq." + companyId);
    memParams.set("content", "ilike.*" + keywords[0] + "*");
    const memR = await fetch(SUPABASE_URL + "/rest/v1/memories?" + memParams, { headers: SB_HEADERS }).catch(() => null);
    if (memR?.ok) {
      const mems = await memR.json();
      if (mems.length > 0) {
        systemPrompt += "\n\n## Relevant Memories\n" + mems.map(m => "- [" + m.category + "] " + m.content).join("\n");
      }
    }
  }

  await log("Starting agentic loop — " + tools.length + " tools, " + mcpServers.length + " MCP servers, max " + maxTurns + " turns", "loop_start");

  // 9. Run the loop
  const result = await runLoop(model, systemPrompt, messages, tools, maxTurns, temperature, mcpServers);

  await log("Loop finished: " + result.status + " in " + result.turns + " turn(s), " + result.toolCalls.length + " tool call(s)");

  // 10. Quality review for delegated tasks
  const isDelegated = task.source === "agent" && task.parent_task_id;
  let finalText = result.text;
  let finalStatus = result.status === "completed" ? "completed" : "failed";

  if (isDelegated && result.status === "completed") {
    const review = await reviewResult(agentSlug, instruction, result.text, result.status, result.toolCalls);
    if (review.accepted) {
      finalText = review.summary;
      await log("Review: ACCEPTED", "review_accepted");
    } else {
      finalStatus = "failed";
      finalText = "Rejected by review: " + review.summary;
      await log("Review: REJECTED — " + review.summary, "review_rejected");
    }
  }

  // 11. Write results
  if (!isDelegated) {
    await sbInsert("chat_messages", {
      conversation_id: CONVERSATION_ID,
      role: "orchestrator",
      content: finalText,
      timestamp: new Date().toISOString(),
      tool_calls: result.toolCalls.length > 0 ? result.toolCalls : null,
      metadata: {
        model, turns: result.turns,
        tools_used: [...new Set(result.toolCalls.map(t => t.tool))],
        agent_slug: agentSlug,
      },
    });
  } else {
    await sbInsert("chat_messages", {
      conversation_id: CONVERSATION_ID,
      role: "orchestrator",
      content: finalText,
      timestamp: new Date().toISOString(),
      metadata: { review: true, reviewed_task_id: TASK_ID, agent_slug: agentSlug },
    });
  }

  const failReason = finalStatus === "failed"
    ? (result.status === "max_turns" ? "Max turns reached" : result.text.slice(0, 500))
    : null;

  await sbPatch("tasks", {
    status: finalStatus,
    completed_at: new Date().toISOString(),
    ...(failReason ? { error_message: failReason } : {}),
  }, { id: "eq." + TASK_ID });

  await sbInsert("task_results", {
    task_id: TASK_ID,
    result_type: "text",
    data: {
      response: finalText,
      tools_used: [...new Set(result.toolCalls.map(t => t.tool))],
      tool_calls: result.toolCalls,
      turns: result.turns,
      model, agent_slug: agentSlug,
      ...(finalStatus === "failed" ? { failed: true } : {}),
    },
  });

  await log("Results written. Task " + finalStatus + ".", "task_" + (finalStatus === "completed" ? "complete" : "failed"));

  // 12. Trigger child tasks
  if (childTasks.length > 0 && SELF_URL) {
    await log("Triggering " + childTasks.length + " child task(s)");
    for (let i = 0; i < childTasks.length; i++) {
      if (i > 0) await sleep(5000);
      try {
        const url = SELF_URL + "/api/run-agent";
        const body = { task_id: childTasks[i].taskId, conversation_id: childTasks[i].conversationId };
        await log("Triggering child " + childTasks[i].taskId.slice(0, 8) + " via " + url);
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const respText = await resp.text().catch(() => "");
        await log("Child trigger response: " + resp.status + " " + respText.slice(0, 200));
      } catch (e) {
        await log("Child trigger failed: " + (e.message || e), "error");
      }
    }
  }

  await log("Runner complete. Exiting.");
}

// ── Entry point ─────────────────────────────────────────────────────────────

main().catch(async (err) => {
  const msg = (err.message || String(err)).slice(0, 500);
  await log("FATAL: " + msg, "error");

  await sbPatch("tasks", {
    status: "failed",
    error_message: msg,
    completed_at: new Date().toISOString(),
  }, { id: "eq." + TASK_ID });

  await sbInsert("chat_messages", {
    conversation_id: CONVERSATION_ID,
    role: "orchestrator",
    content: "Something went wrong while processing your request. Please try again.",
    timestamp: new Date().toISOString(),
    metadata: { error: true, original_error: msg },
  });

  process.exit(1);
});
