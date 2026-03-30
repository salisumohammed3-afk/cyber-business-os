// runner.mjs — Executes agent tasks (Railway worker or Vercel Sandbox)
// Zero external dependencies: uses only Node.js builtins + fetch
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const VERCEL_TOKEN     = process.env.VERCEL_TOKEN || "";
const TASK_WORKDIR     = process.env.TASK_WORKDIR || "";

if (!TASK_ID || !SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
  console.error("Missing required env vars");
  process.exit(1);
}

const RUN_ID = randomUUID();
const USE_JSON_LOG = process.env.LOG_FORMAT === "json" || process.env.NODE_ENV === "production";

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
    const errBody = await resp.text().catch(() => "");

    if (resp.status === 400 && mcpServers.length > 0 && errBody.includes("MCP")) {
      await log("MCP server error — retrying WITHOUT MCP tools: " + errBody.slice(0, 200), "mcp_fallback");
      mcpServers = [];
      delete headers["anthropic-beta"];
      const bodyNoMcp = { model, max_tokens: maxTokens, temperature, system, messages, ...(tools.length > 0 ? { tools } : {}) };
      const resp2 = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(bodyNoMcp),
      });
      if (resp2.ok) return await resp2.json();
      const errBody2 = await resp2.text().catch(() => "");
      throw new Error("Anthropic " + resp2.status + " (MCP fallback): " + errBody2.slice(0, 300));
    }

    if ((is429 || is5xx) && attempt < MAX_RETRIES) {
      const wait = is429 ? attempt * 15000 : attempt * 5000;
      await log("API " + resp.status + " — retry " + (attempt + 1) + "/" + MAX_RETRIES + " in " + (wait / 1000) + "s", "provider_error", {
        http_status: resp.status,
        provider: "anthropic",
      });
      await sleep(wait);
      continue;
    }
    throw new Error("Anthropic " + resp.status + ": " + errBody.slice(0, 300));
  }
}

// ── Logging ─────────────────────────────────────────────────────────────────

let agentSlug = "unknown";
let companyId = null;

async function log(message, logType = "info", meta = {}) {
  const base = {
    level: logType === "error" || logType === "provider_error" ? "error" : "info",
    msg: message,
    log_type: logType,
    task_id: TASK_ID,
    conversation_id: CONVERSATION_ID,
    company_id: companyId,
    agent_slug: agentSlug,
    run_id: RUN_ID,
    ts: new Date().toISOString(),
    ...meta,
  };
  if (USE_JSON_LOG) {
    console.log(JSON.stringify(base));
  } else {
    console.log("[" + logType + "] " + message);
  }
  try {
    const row = {
      message,
      source: "sandbox-runner",
      agent_slug: agentSlug,
      task_id: TASK_ID,
      log_type: logType,
      company_id: companyId,
      metadata: { run_id: RUN_ID, conversation_id: CONVERSATION_ID, ...meta },
    };
    await sbInsert("terminal_logs", row);
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
    description: "Delegate work to a specialist sub-agent. Optionally chain to another agent on completion via next_agent.",
    input_schema: {
      type: "object",
      properties: {
        agent_slug: { type: "string", description: "Target: engineering, growth, research, designer, executive-assistant" },
        instruction: { type: "string", description: "Detailed instruction for the sub-agent" },
        context: { type: "string", description: "Additional context" },
        next_agent: { type: "string", description: "Optional: agent slug to auto-handoff to on completion (e.g. 'engineering')" },
        next_instruction: { type: "string", description: "Optional: instruction for the next agent. Use {RESULT} as placeholder for this agent's output." },
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
    description: "Mark the task as FAILED. LAST RESORT ONLY — call this ONLY after you have tried multiple different tools and approaches. Before calling, ask yourself: did I try web_search? Did I try a different strategy? Can I deliver partial results instead? If you can deliver ANYTHING useful, do NOT call this.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why you're failing — must explain what you tried and why ALL alternatives are exhausted" },
        partial_result: { type: "string", description: "Any partial work you completed — deliver this instead of nothing" },
        tools_tried: { type: "array", items: { type: "string" }, description: "List of tools you already attempted" },
      },
      required: ["reason", "tools_tried"],
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
  {
    name: "deploy_static_site",
    description: "Deploy a static site directory to Vercel. Returns a live URL instantly. Use INSTEAD of GitHub Pages for deployment.",
    input_schema: {
      type: "object",
      properties: {
        project_name: { type: "string", description: "Project name (lowercase, hyphens ok), e.g. 'smart-todo-app'" },
        directory: { type: "string", description: "Path to the directory containing static files to deploy, e.g. 'todo-app'" },
      },
      required: ["project_name", "directory"],
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
      case "deploy_static_site": return await toolDeployStaticSite(input);
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
  // Dedup: check if a very similar memory already exists
  const snippet = input.content.slice(0, 60).replace(/%/g, "").replace(/'/g, "");
  if (snippet.length > 10) {
    const dupeParams = new URLSearchParams({
      select: "id,content", limit: "5",
      content: "ilike.*" + snippet + "*",
    });
    if (companyId) dupeParams.set("company_id", "eq." + companyId);
    const dupeR = await fetch(SUPABASE_URL + "/rest/v1/memories?" + dupeParams, { headers: SB_HEADERS }).catch(() => null);
    if (dupeR?.ok) {
      const dupes = await dupeR.json();
      const normNew = input.content.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
      for (const d of dupes) {
        const normOld = (d.content || "").toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
        const shorter = Math.min(normNew.length, normOld.length);
        const longer = Math.max(normNew.length, normOld.length);
        if (shorter > 0 && longer > 0) {
          let match = 0;
          const words1 = new Set(normNew.split(" "));
          const words2 = new Set(normOld.split(" "));
          for (const w of words1) if (words2.has(w)) match++;
          const overlap = match / Math.max(words1.size, words2.size);
          if (overlap > 0.8) {
            return JSON.stringify({ skipped: true, reason: "duplicate", existing_id: d.id });
          }
        }
      }
    }
  }

  const result = await sbInsert("memories", {
    content: input.content, category: input.category,
    importance: input.importance || 5,
    user_id: "00000000-0000-0000-0000-000000000000",
    company_id: companyId,
    agent_definition_id: agentDefId,
    metadata: { source: "agent", agent_slug: agentSlug },
  });
  if (!result) return JSON.stringify({ error: "Failed to store memory" });
  return JSON.stringify({ success: true, stored: input.content });
}

async function toolRecallMemories(input) {
  const params = new URLSearchParams({
    select: "content,category,importance,created_at,metadata",
    order: "importance.desc", limit: String(input.limit || 10),
  });
  if (companyId) params.set("company_id", "eq." + companyId);
  if (input.category) params.set("category", "eq." + input.category);
  const q = (input.query || "").trim().replace(/[^a-zA-Z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (q.length > 2) {
    params.set("fts", "websearch." + q);
  } else if (q.length > 0) {
    params.set("content", "ilike.*" + q + "*");
  }
  // Exclude expired memories
  params.set("or", "(expires_at.is.null,expires_at.gt." + new Date().toISOString() + ")");

  const r = await fetch(SUPABASE_URL + "/rest/v1/memories?" + params, { headers: SB_HEADERS });
  if (!r.ok) return JSON.stringify({ error: await r.text() });
  const data = await r.json();
  const results = data.map(m => ({
    content: m.content, category: m.category,
    importance: m.importance, created_at: m.created_at,
    source_agent: m.metadata?.agent_slug || "unknown",
  }));
  return JSON.stringify({ memories: results, count: results.length });
}

async function toolDelegateTask(input) {
  const agentDef = await sbGet("agent_definitions", {
    slug: "eq." + input.agent_slug, company_id: "eq." + companyId,
  }, { select: "id,name,slug", single: true });
  if (!agentDef) return JSON.stringify({ error: "Agent '" + input.agent_slug + "' not found" });
  if (agentDef.slug === agentSlug) return JSON.stringify({ error: "Cannot delegate to yourself" });

  const taskMeta = {};
  if (input.next_agent) {
    taskMeta.handoff = {
      next_agent: input.next_agent,
      next_instruction: input.next_instruction || "",
    };
  }

  const result = await sbInsert("tasks", {
    title: "Delegated: " + input.instruction.slice(0, 80),
    description: input.instruction,
    agent_definition_id: agentDef.id, conversation_id: CONVERSATION_ID,
    parent_task_id: TASK_ID, company_id: companyId,
    status: "pending",
    input_data: { instruction: input.instruction, context: input.context || "" },
    metadata: Object.keys(taskMeta).length > 0 ? taskMeta : {},
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

const BLOCKING_PATTERNS = [
  /\bhttp\.server\b/, /\bserve\s/, /\bnpx\s+serve\b/, /\blive-server\b/,
  /\bnginx\b/, /\bapache2?\b/, /\buvicorn\b/, /\bgunicorn\b/,
  /\btail\s+-f\b/, /\bwatch\b/, /\bnodemon\b/, /\bnpm\s+start\b/,
];

function toolSandboxBash(input) {
  const cmd = input.command || "";
  const isBlocking = BLOCKING_PATTERNS.some(p => p.test(cmd));
  if (isBlocking && !cmd.includes("&") && !cmd.includes("timeout")) {
    return JSON.stringify({
      error: "This command looks like it would run forever (blocking server/watcher). " +
        "Either append ' &' to run in background, prefix with 'timeout 10s', or use a different approach.",
      suggestion: cmd + " &",
    });
  }

  try {
    const cwd = input.cwd || TASK_WORKDIR || process.cwd();
    const stdout = execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: 120_000,
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
    const dir = input.path || TASK_WORKDIR || process.cwd();
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

async function toolDeployStaticSite(input) {
  if (!VERCEL_TOKEN) return JSON.stringify({ error: "VERCEL_TOKEN not configured. Use GitHub Pages as fallback." });
  const { project_name, directory } = input;
  if (!project_name || !directory) return JSON.stringify({ error: "project_name and directory are required" });

  try {
    const dir = join(TASK_WORKDIR || process.cwd(), directory);
    if (!existsSync(dir)) return JSON.stringify({ error: "Directory not found: " + directory });

    function collectFiles(base, prefix = "") {
      const results = [];
      for (const name of readdirSync(base)) {
        const full = join(base, name);
        const rel = prefix ? prefix + "/" + name : name;
        if (name.startsWith(".") || name === "node_modules") continue;
        const st = statSync(full);
        if (st.isDirectory()) {
          results.push(...collectFiles(full, rel));
        } else if (st.size < 5_000_000) {
          results.push({ file: rel, data: readFileSync(full).toString("base64"), encoding: "base64" });
        }
      }
      return results;
    }

    const files = collectFiles(dir);
    if (files.length === 0) return JSON.stringify({ error: "No files found in " + directory });

    await log("Deploying " + files.length + " files to Vercel as " + project_name, "deploy_start");

    const body = {
      name: project_name,
      files: files,
      projectSettings: { framework: null },
      target: "production",
    };

    const resp = await fetch("https://api.vercel.com/v13/deployments", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + VERCEL_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return JSON.stringify({ error: "Deploy failed: " + resp.status + " " + errText.slice(0, 300) });
    }

    const data = await resp.json();
    const url = data.url ? "https://" + data.url : data.alias?.[0] ? "https://" + data.alias[0] : null;

    await log("Deployed to " + (url || data.url || "unknown"), "deploy_complete");
    return JSON.stringify({
      success: true,
      url: url,
      deployment_url: data.url,
      project: project_name,
      files_deployed: files.length,
      ready_state: data.readyState || data.status,
    });
  } catch (e) {
    return JSON.stringify({ error: "Deploy error: " + (e.message || e) });
  }
}

// ── Agentic loop ────────────────────────────────────────────────────────────

async function saveCheckpoint(messages, turn, allToolCalls) {
  try {
    const serializable = messages.map(m => {
      if (typeof m.content === "string") return m;
      if (Array.isArray(m.content)) {
        return { role: m.role, content: m.content.map(b => {
          if (b.type === "tool_result") return { type: "tool_result", tool_use_id: b.tool_use_id, content: (b.content || "").slice(0, 2000) };
          if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input };
          if (b.type === "text") return { type: "text", text: (b.text || "").slice(0, 3000) };
          return b;
        })};
      }
      return m;
    });
    const checkpoint = {
      messages: serializable,
      turn,
      tools_used: [...new Set(allToolCalls.map(t => t.tool))],
      saved_at: new Date().toISOString(),
    };
    const jsonSize = JSON.stringify(checkpoint).length;
    const cpData = jsonSize > 500_000
      ? { ...checkpoint, messages: serializable.slice(-10) }
      : checkpoint;

    const existing = await sbGet("tasks", { id: "eq." + TASK_ID }, { select: "metadata", single: true });
    const merged = { ...(existing?.metadata || {}), checkpoint: cpData };
    await sbPatch("tasks", { metadata: merged }, { id: "eq." + TASK_ID });
  } catch (e) {
    await log("Checkpoint save failed: " + (e.message || e), "warn");
  }
}

async function runLoop(model, systemPrompt, messages, tools, timeBudgetMs, temperature, mcpServers = [], existingToolCalls = []) {
  const allToolCalls = [...existingToolCalls];
  let failAttempts = 0;
  const MAX_FAIL_RETRIES = 2;
  const HARD_TURN_CAP = 200;
  const startTime = Date.now();
  let turn = 0;

  function timeLeft() { return timeBudgetMs - (Date.now() - startTime); }
  function elapsed() { return Math.round((Date.now() - startTime) / 1000); }

  while (turn < HARD_TURN_CAP) {
    const remaining = timeLeft();
    if (remaining <= 0) break;

    turn++;
    await log("Step " + turn + " (" + elapsed() + "s elapsed, " + Math.round(remaining / 1000) + "s left) — calling " + model);

    // Warn when genuinely running low on time (< 60s left, and we've been working for a while)
    if (remaining < 60000 && turn > 2) {
      const urgency = remaining < 15000
        ? "THIS IS YOUR FINAL STEP. You MUST produce your final answer NOW as text. Do NOT use any more tools."
        : "You have less than a minute left. Wrap up — produce your final answer with the results you have so far. Partial results are acceptable.";
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === "user" && typeof lastMsg.content === "string") {
        lastMsg.content += "\n\n[SYSTEM] " + urgency;
      } else if (lastMsg && lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
        lastMsg.content.push({ type: "text", text: "\n\n[SYSTEM] " + urgency });
      } else {
        messages.push({ role: "user", content: "[SYSTEM] " + urgency });
      }
    }

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
        failAttempts++;
        if (failAttempts <= MAX_FAIL_RETRIES && timeLeft() > 30000) {
          await log("Agent wants to give up (attempt " + failAttempts + "/" + MAX_FAIL_RETRIES + ") — pushing back", "fail_pushback");
          messages.push({ role: "assistant", content: response.content });
          messages.push({ role: "user", content: [{
            type: "tool_result", tool_use_id: failBlock.id,
            content: "HOLD ON — Do not give up yet. You still have time. " +
              "Reason you wanted to fail: " + (failBlock.input.reason || "unknown") + "\n\n" +
              "Before failing, try these recovery strategies:\n" +
              "1. If a tool errored, try an alternative tool or different parameters\n" +
              "2. If web_search returned nothing, try different search terms\n" +
              "3. If an external service is down, work with what you have\n" +
              "4. If you're stuck on one approach, try a completely different approach\n" +
              "5. Deliver PARTIAL results — something useful is better than nothing\n\n" +
              "Only call fail_task again if you've truly exhausted ALL alternatives.",
          }]});
          allToolCalls.push({ tool: "fail_task", input: failBlock.input, output: "(pushed back)", source: "local" });
          continue;
        }
        return {
          status: "failed",
          text: failBlock.input.reason || "Agent could not complete",
          partial: failBlock.input.partial_result,
          toolCalls: allToolCalls,
          turns: turn,
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

      await saveCheckpoint(messages, turn, allToolCalls);
      continue;
    }

    const text = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("") || "Task completed but no text output was produced.";

    return { status: "completed", text, toolCalls: allToolCalls, turns: turn };
  }

  const reason = timeLeft() <= 0
    ? "Time budget expired (" + Math.round(timeBudgetMs / 1000) + "s)"
    : "Hit safety cap (" + HARD_TURN_CAP + " steps)";

  return {
    status: "time_expired",
    text: reason + " after " + turn + " steps. Tools used: " + allToolCalls.map(t => t.tool).join(", "),
    toolCalls: allToolCalls,
    turns: turn,
  };
}

// ── Quality review (for delegated tasks) ────────────────────────────────────

async function verifyEngineering(toolCalls, instruction) {
  const checks = [];
  const lcInstruction = (instruction || "").toLowerCase();

  const isBuildTask = /\b(build|create|deploy|app|site|website|tool|calculator|timer|game|dashboard|todo|to-do)\b/i.test(lcInstruction);
  const isAnalysisTask = /\b(analy[sz]e|review|audit|assess|research|investigate|document|report|reskin|presentation|brief)\b/i.test(lcInstruction);

  const sandboxTools = toolCalls.filter(t =>
    t.tool.startsWith("sandbox_") || t.tool === "github_push_file" || t.tool === "github_create_repo" || t.tool === "deploy_static_site"
  );

  if (isBuildTask) {
    if (sandboxTools.length === 0) {
      checks.push({ pass: false, msg: "No sandbox/GitHub/deploy tool calls — agent didn't build anything" });
    } else {
      checks.push({ pass: true, msg: sandboxTools.length + " build/push tool calls made" });
    }

    const projects = await sbGet("projects", { created_by_task_id: "eq." + TASK_ID });
    if (projects?.length) {
      const p = projects[0];
      checks.push({ pass: true, msg: "Project registered: " + p.name });
      if (p.deploy_url) {
        try {
          let url = p.deploy_url;
          let r = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(10000) });
          if (r.status === 401 && url.includes("-team-")) {
            const prodUrl = url.replace(/-[a-z0-9]+-team-[^.]+\.vercel\.app/, ".vercel.app");
            if (prodUrl !== url) {
              const r2 = await fetch(prodUrl, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(10000) });
              if (r2.ok) { r = r2; url = prodUrl; }
            }
          }
          checks.push({ pass: r.ok, msg: "Deploy URL " + url + " → " + r.status });
        } catch (e) {
          checks.push({ pass: false, msg: "Deploy URL unreachable: " + (e.message || "").slice(0, 80) });
        }
      }
    }
  } else if (isAnalysisTask) {
    if (toolCalls.length === 0) {
      checks.push({ pass: false, msg: "No tools used — agent didn't do any real work" });
    } else {
      checks.push({ pass: true, msg: toolCalls.length + " tool calls made for analysis/research work" });
    }
  } else {
    if (toolCalls.length >= 1) {
      checks.push({ pass: true, msg: toolCalls.length + " tool calls made" });
    } else {
      checks.push({ pass: false, msg: "No tools used — agent described work instead of doing it" });
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
  if (urls.length === 0 && searchCalls.length === 0) {
    checks.push({ pass: false, msg: "No URLs cited AND no search tools used" });
  } else if (urls.length > 0) {
    checks.push({ pass: true, msg: urls.length + " source URL(s) cited" });
  } else {
    checks.push({ pass: true, msg: "Agent used " + searchCalls.length + " search calls (URLs not in final text but research was done)" });
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
      verificationChecks = await verifyEngineering(toolCalls || [], instruction);
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

    const toolsSummary = (toolCalls || []).length > 0
      ? "\n\nTools the agent actually used: " + [...new Set((toolCalls || []).map(t => t.tool))].join(", ") + " (" + toolCalls.length + " total calls)"
      : "\n\nTools used: NONE";

    const prompt = "Agent: " + agentName + "\nTask: " + instruction +
      "\nResult (" + resultStatus + "):\n" + resultText.slice(0, 3000) +
      verificationContext + toolsSummary +
      "\n\nEvaluate whether the agent delivered real, actionable results." +
      "\n\nACCEPT if ANY of these are true:" +
      "\n- Agent used tools to do real work (wrote code, searched web, created documents, etc.)" +
      "\n- Agent produced substantive output with real data, analysis, or deliverables" +
      "\n- Agent created something tangible (files, repos, deployed apps, documents)" +
      "\n\nREJECT ONLY if:" +
      "\n- Agent produced ZERO tool calls AND the output is just describing what it WOULD do" +
      "\n- Agent's output is entirely generic/templated with no task-specific content" +
      "\n- Agent explicitly says it cannot do the task without actually trying" +
      "\n\nBias toward ACCEPT when the agent made genuine effort with tools. Partial results from real work > no results." +
      "\nRespond with ACCEPT: followed by summary, or REJECT: followed by what specifically was missing.";

    const resp = await callClaude("claude-sonnet-4-20250514", "You evaluate AI agent work. Accept genuine tool-based work and real output. Only reject if the agent clearly didn't try or produced nothing actionable.", [
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

// ── Deliverable Extraction ───────────────────────────────────────────────────

function extractDeliverables(toolCalls) {
  const deliverables = [];
  const seen = new Set();

  for (const tc of toolCalls) {
    let out;
    try { out = typeof tc.output === "string" ? JSON.parse(tc.output) : tc.output; } catch { continue; }
    if (!out || out.error || !out.success) continue;

    if (tc.tool === "deploy_static_site" && out.url) {
      const key = "project:" + out.url;
      if (!seen.has(key)) { seen.add(key); deliverables.push({ type: "project", label: out.project || "Live App", url: out.url }); }
    }

    if (tc.tool === "register_project" && out.project_id) {
      deliverables.push({ type: "registered", label: "Project registered", id: out.project_id });
    }

    if (tc.tool === "github_create_repo" && out.html_url) {
      const key = "repo:" + out.html_url;
      if (!seen.has(key)) { seen.add(key); deliverables.push({ type: "repo", label: out.name || "GitHub Repo", url: out.html_url }); }
    }

    if (tc.tool === "composio_execute") {
      const action = (tc.input?.action_id || "").toUpperCase();
      const data = out.data || out;

      if (action.includes("GOOGLEDOCS") && data.document_id) {
        const url = "https://docs.google.com/document/d/" + (data.response_data?.documentId || data.document_id);
        const key = "doc:" + url;
        if (!seen.has(key)) { seen.add(key); deliverables.push({ type: "doc", label: data.response_data?.title || "Google Doc", url }); }
      }
      if (action.includes("GOOGLESHEETS") && (data.spreadsheet_id || data.spreadsheetId)) {
        const sid = data.spreadsheet_id || data.spreadsheetId;
        const url = "https://docs.google.com/spreadsheets/d/" + sid;
        const key = "sheet:" + url;
        if (!seen.has(key)) { seen.add(key); deliverables.push({ type: "sheet", label: data.title || "Google Sheet", url }); }
      }
      if ((action.includes("AGENTMAIL") || action.includes("GMAIL")) && action.includes("SEND")) {
        deliverables.push({ type: "email", label: "Email sent" + (data.to ? " to " + data.to : "") });
      }
    }
  }

  return deliverables;
}

function formatNotification(agentSlug, taskTitle, resultText, deliverables) {
  const agentNames = {
    engineering: "Engineering Agent", research: "Research Agent",
    growth: "Growth Agent", designer: "Design Agent",
    "executive-assistant": "Executive Assistant",
  };
  const agentLabel = agentNames[agentSlug] || agentSlug;

  const cleanTitle = (taskTitle || "").replace(/^Delegated:\s*/i, "").slice(0, 80);

  let md = "**Task Complete" + (cleanTitle ? ": " + cleanTitle : "") + "**\n\n";
  md += "The " + agentLabel + " finished this task. Here's what was produced:\n\n";
  md += resultText.slice(0, 4000);

  if (deliverables.length > 0) {
    md += "\n\n---\n**Deliverables:**\n";
    for (const d of deliverables) {
      if (d.url) {
        md += "- [" + d.label + "](" + d.url + ")\n";
      } else {
        md += "- " + d.label + "\n";
      }
    }
  }

  return md;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  await log("Runner started for task " + TASK_ID.slice(0, 8) + (TASK_WORKDIR ? " (workdir: " + TASK_WORKDIR + ")" : ""));

  // 1. Load task
  const task = await sbGet("tasks", { id: "eq." + TASK_ID }, { single: true });
  if (!task) throw new Error("Task not found: " + TASK_ID);
  companyId = task.company_id;

  // 2. Load agent definition (default to orchestrator if none assigned)
  let systemPrompt = "";
  let model = "claude-sonnet-4-20250514";
  let temperature = 0.7;
  const DEFAULT_TIME_BUDGET_MS = 5 * 60 * 1000; // 5 minutes
  let timeBudgetMs = DEFAULT_TIME_BUDGET_MS;
  let agentDefId = null;

  let defId = task.agent_definition_id;
  if (!defId) {
    const orch = await sbGet("agent_definitions", { slug: "eq.orchestrator" }, { select: "id", single: true });
    if (orch) defId = orch.id;
    await log("No agent assigned — defaulting to orchestrator", "agent_fallback");
  }

  if (defId) {
    const def = await sbGet("agent_definitions", { id: "eq." + defId }, { single: true });
    if (def) {
      systemPrompt = def.system_prompt || systemPrompt;
      model = def.model || model;
      temperature = parseFloat(def.temperature) || temperature;
      if (def.time_budget_seconds) {
        timeBudgetMs = def.time_budget_seconds * 1000;
      } else if (def.max_turns) {
        timeBudgetMs = Math.max(def.max_turns * 30 * 1000, DEFAULT_TIME_BUDGET_MS);
      }
      agentDefId = def.id;
      agentSlug = def.slug || "unknown";
      await log("Agent: " + def.name + " (" + agentSlug + ") — model: " + model, "agent_loaded");
    }
  }

  if (!systemPrompt) {
    systemPrompt = "You are the Orchestrator of a Cyber Business OS — the CEO's AI right hand. Be direct and concise. Delegate to sub-agents for any substantial work.";
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
    "2. NEVER GIVE UP ON FIRST ERROR. If a tool fails, try different parameters, a different tool, or a different approach. You have many turns — use them.\n" +
    "3. Exhaust alternatives. web_search always works as a fallback.\n" +
    "4. NEVER output auth links, setup URLs, or 'please connect' messages.\n" +
    "5. Only call fail_task as an absolute last resort after trying multiple approaches. If you have partial results, deliver those instead of failing.\n" +
    "6. 'Completed' means you delivered real results, not setup instructions.\n" +
    "7. If an external service is down or errors, work around it. Build locally, use sandbox tools, produce results another way.";

  if (agentSlug === "engineering") {
    systemPrompt = "You are the Engineering Agent. You BUILD things. You have a full sandbox environment with filesystem, shell, and GitHub access.\n\n" +
      "CRITICAL: You MUST use your tools to write actual code, test it, and push it. NEVER just describe what you would build. ALWAYS build it.\n\n" +
      systemPrompt +
      "\n\n## Engineering Workflow\n" +
      "For BUILD/CREATE tasks (apps, sites, tools):\n" +
      "1. Write code files using sandbox_write_file\n" +
      "2. Test with sandbox_bash\n" +
      "3. Fix any errors\n" +
      "4. Create GitHub repo with github_create_repo\n" +
      "5. Push files with github_push_file\n" +
      "6. Deploy with deploy_static_site (instant live URL — preferred over GitHub Pages)\n" +
      "7. Register with register_project\n\n" +
      "For ANALYSIS/RESEARCH tasks (code review, reskinning analysis, technical assessment):\n" +
      "1. Use web_search, database_query, or sandbox tools to gather data\n" +
      "2. Analyze findings\n" +
      "3. Produce a detailed written report\n" +
      "4. No deployment or repo needed\n\n" +
      "IMPORTANT RULES:\n" +
      "- ALWAYS use tools. Never just describe what you'd do.\n" +
      "- If a tool fails, try a different approach. Don't give up on first error.\n" +
      "- If building an app, complete the full build-deploy cycle.\n" +
      "- Partial real results are better than no results. Deliver what you can.\n" +
      "- If deploy fails, still push to GitHub and register the project.";

    // Project edit mode: inject existing project context
    let rawInputCheck = task.input_data;
    if (typeof rawInputCheck === "string") try { rawInputCheck = JSON.parse(rawInputCheck); } catch {}
    if (rawInputCheck?.project_id) {
      const pi = rawInputCheck;
      systemPrompt += "\n\n## ACTIVE PROJECT EDIT MODE\n" +
        "You are making changes to an EXISTING project. DO NOT create a new repo.\n" +
        "- Repository: " + (pi.repo_url || "N/A") + "\n" +
        "- Live URL: " + (pi.deploy_url || "N/A") + "\n" +
        "- Branch: " + (pi.branch || "main") + "\n" +
        (pi.file_tree ? "\nCurrent file tree:\n" + pi.file_tree + "\n" : "") +
        "\nWorkflow for edits:\n" +
        "1. Read existing files from the repo using github_push_file's update capability or sandbox tools\n" +
        "2. Make targeted changes based on the user's feedback\n" +
        "3. Push updated files with github_push_file (it auto-fetches SHA for updates)\n" +
        "4. Do NOT call register_project again — the project is already registered\n" +
        "5. Summarise what you changed when done";
    }
  }

  // 6. Select tools for this agent
  let tools;
  if (agentSlug === "orchestrator") {
    // Orchestrator gets ONLY coordination tools — no web_search, no composio.
    // This forces it to delegate instead of doing research/work itself.
    const ORCHESTRATOR_ONLY = ["delegate_task", "create_task", "store_memory", "recall_memories", "database_query", "fail_task"];
    tools = BASE_TOOLS.filter(t => ORCHESTRATOR_ONLY.includes(t.name));
  } else {
    tools = [...BASE_TOOLS];
    if (agentSlug === "engineering") tools.push(...ENGINEERING_TOOLS);
    if (agentSlug === "designer") tools.push(...DESIGNER_TOOLS);
    if (composioApps.length > 0) tools.push(...COMPOSIO_TOOLS);
    if (mcpToolsets.length > 0) tools.push(...mcpToolsets);
  }

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

  // 8. Inject relevant memories (full-text search, all keywords, expiry-aware)
  const keywords = instruction.split(/\s+/).filter(w => w.length > 3).map(w => w.replace(/[^a-zA-Z0-9]/g, "")).filter(Boolean).slice(0, 8);
  if (keywords.length > 0) {
    const ftsQuery = keywords.join(" or ");
    const memParams = new URLSearchParams({
      select: "content,category,metadata", order: "importance.desc", limit: "8",
      fts: "websearch." + ftsQuery,
      or: "(expires_at.is.null,expires_at.gt." + new Date().toISOString() + ")",
    });
    if (companyId) memParams.set("company_id", "eq." + companyId);
    const memR = await fetch(SUPABASE_URL + "/rest/v1/memories?" + memParams, { headers: SB_HEADERS }).catch(() => null);
    if (memR?.ok) {
      const mems = await memR.json();
      if (mems.length > 0) {
        systemPrompt += "\n\n## Relevant Memories\n" + mems.map(m => {
          const src = m.metadata?.agent_slug ? " (via " + m.metadata.agent_slug + ")" : "";
          return "- [" + m.category + "] " + m.content + src;
        }).join("\n");
      }
    }
  }

  // 9. Check for checkpoint (resume from previous run)
  let existingToolCalls = [];
  const taskMeta = task.metadata || {};
  const checkpoint = taskMeta.checkpoint;

  if (checkpoint && checkpoint.messages && checkpoint.messages.length > 0) {
    await log("Resuming from checkpoint (" + (checkpoint.tools_used || []).join(", ") + ")", "checkpoint_resume");
    messages.length = 0;
    for (const m of checkpoint.messages) messages.push(m);
    existingToolCalls = (checkpoint.tools_used || []).map(t => ({ tool: t, input: {}, output: "(from checkpoint)", source: "checkpoint" }));
  }

  await log("Starting agentic loop — " + tools.length + " tools, " + mcpServers.length + " MCP servers, " + Math.round(timeBudgetMs / 1000) + "s time budget", "loop_start");

  // 10. Run the loop
  const result = await runLoop(model, systemPrompt, messages, tools, timeBudgetMs, temperature, mcpServers, existingToolCalls);

  await log("Loop finished: " + result.status + " in " + result.turns + " turn(s), " + result.toolCalls.length + " tool call(s)");

  // 10. Quality review for delegated tasks (with retry loop)
  const isDelegated = task.source === "agent" && task.parent_task_id;
  let finalText = result.text;
  let finalStatus = result.status === "completed" ? "completed" : "failed";
  let reviewSummary = null;

  if (isDelegated && result.status === "completed") {
    const MAX_REVIEW_RETRIES = 2;
    let reviewAttempt = 0;
    let currentResult = result;

    while (reviewAttempt <= MAX_REVIEW_RETRIES) {
      const review = await reviewResult(agentSlug, instruction, currentResult.text, currentResult.status, currentResult.toolCalls);
      if (review.accepted) {
        reviewSummary = review.summary;
        finalText = currentResult.text;
        finalStatus = "completed";
        await log("Review: ACCEPTED" + (reviewAttempt > 0 ? " (after " + reviewAttempt + " revision(s))" : ""), "review_accepted");
        break;
      }

      reviewAttempt++;
      if (reviewAttempt > MAX_REVIEW_RETRIES) {
        finalStatus = "failed";
        finalText = "Rejected after " + MAX_REVIEW_RETRIES + " revision attempts. Last rejection: " + review.summary;
        await log("Review: FINAL REJECT after " + MAX_REVIEW_RETRIES + " retries — " + review.summary, "review_rejected");
        break;
      }

      await log("Review: REJECTED (attempt " + reviewAttempt + "/" + MAX_REVIEW_RETRIES + ") — " + review.summary + ". Sending back for revision.", "review_retry");

      const revisionMessages = [...messages];
      revisionMessages.push({
        role: "user",
        content: "YOUR WORK WAS REVIEWED AND REJECTED. Here is the feedback:\n\n" +
          "REJECTION REASON: " + review.summary + "\n\n" +
          "You MUST fix these issues and try again. Use your tools to actually do the work — don't just describe what you would do. " +
          "Your previous response was:\n" + currentResult.text.slice(0, 2000) + "\n\n" +
          "Fix the problems and deliver real, complete results this time.",
      });

      const REVISION_TIME_BUDGET = 3 * 60 * 1000; // 3 minutes per revision
      const retryResult = await runLoop(model, systemPrompt, revisionMessages, tools, REVISION_TIME_BUDGET, temperature, mcpServers, currentResult.toolCalls);
      await log("Revision loop done: " + retryResult.status + " in " + retryResult.turns + " turns", "review_revision_done");

      if (retryResult.status !== "completed") {
        finalStatus = "failed";
        finalText = "Failed during revision attempt " + reviewAttempt + ": " + retryResult.text;
        await log("Revision attempt " + reviewAttempt + " failed: " + retryResult.status, "review_revision_failed");
        break;
      }

      currentResult = retryResult;
    }
  }

  // 11. Extract deliverables and write results
  const deliverables = extractDeliverables(result.toolCalls || []);
  if (deliverables.length > 0) {
    await log("Deliverables: " + deliverables.map(d => d.type + (d.url ? " " + d.url : "")).join(", "), "deliverables");
  }

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
    const notificationContent = finalStatus === "completed"
      ? formatNotification(agentSlug, task.title, result.text, deliverables)
      : finalText;

    await sbInsert("chat_messages", {
      conversation_id: CONVERSATION_ID,
      role: "orchestrator",
      content: notificationContent,
      timestamp: new Date().toISOString(),
      metadata: {
        notification: finalStatus === "completed",
        review: true,
        review_summary: reviewSummary,
        reviewed_task_id: TASK_ID,
        agent_slug: agentSlug,
        deliverables: deliverables.length > 0 ? deliverables : undefined,
      },
    });
  }

  const failReason = finalStatus === "failed"
    ? (result.status === "time_expired" ? "Time budget expired" : finalText.slice(0, 500))
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

  // 12. Child tasks are already inserted as 'pending' by delegate_task.
  if (childTasks.length > 0) {
    await log(childTasks.length + " child task(s) queued for pickup: " +
      childTasks.map(c => c.taskId.slice(0, 8)).join(", "));
  }

  // 13. Auto-retry for failed delegated tasks
  const taskMeta2 = task.metadata || {};
  const retryCount = taskMeta2.auto_retry_count || 0;
  const MAX_AUTO_RETRIES = 2;

  if (isDelegated && finalStatus === "failed" && retryCount < MAX_AUTO_RETRIES) {
    await log("Auto-retrying failed delegated task (attempt " + (retryCount + 1) + "/" + MAX_AUTO_RETRIES + ")", "auto_retry");

    const retryTask = await sbInsert("tasks", {
      title: task.title,
      description: task.description,
      agent_definition_id: task.agent_definition_id,
      conversation_id: CONVERSATION_ID,
      parent_task_id: task.parent_task_id || TASK_ID,
      company_id: companyId,
      status: "pending",
      input_data: {
        instruction: instruction + "\n\nIMPORTANT CONTEXT: A previous attempt at this task FAILED with this error:\n" +
          failReason + "\n\nYou MUST avoid this same mistake. Adjust your approach and try a different strategy.",
        context: (typeof task.input_data === "object" ? task.input_data?.context : "") || "",
      },
      metadata: { ...taskMeta2, auto_retry_count: retryCount + 1, previous_task_id: TASK_ID },
      source: "agent",
    });

    if (retryTask?.[0]?.id) {
      await log("Retry task created: " + retryTask[0].id.slice(0, 8), "auto_retry_created");
      await sbInsert("chat_messages", {
        conversation_id: CONVERSATION_ID,
        role: "orchestrator",
        content: "Task failed — automatically retrying with adjusted approach (attempt " + (retryCount + 1) + "/" + MAX_AUTO_RETRIES + ").",
        timestamp: new Date().toISOString(),
        metadata: { notification: true, retry: true, original_task_id: TASK_ID },
      });
    }
  }

  // 14. Handoff chain: if this task has a next_agent, auto-create the follow-up task
  const handoff = (task.metadata || {}).handoff;
  if (handoff?.next_agent && finalStatus === "completed") {
    const nextAgentDef = await sbGet("agent_definitions", {
      slug: "eq." + handoff.next_agent, company_id: "eq." + companyId,
    }, { select: "id,name", single: true });

    if (nextAgentDef) {
      const nextInstruction = (handoff.next_instruction || "Continue from previous agent output.")
        .replace(/\{RESULT\}/g, finalText);

      const handoffTask = await sbInsert("tasks", {
        title: "Handoff: " + handoff.next_agent + " — " + nextInstruction.slice(0, 60),
        description: nextInstruction,
        agent_definition_id: nextAgentDef.id,
        conversation_id: CONVERSATION_ID,
        parent_task_id: task.parent_task_id || TASK_ID,
        company_id: companyId,
        status: "pending",
        input_data: {
          instruction: nextInstruction,
          context: "Previous agent (" + agentSlug + ") output:\n\n" + finalText,
          deliverables: deliverables,
        },
        source: "agent",
      });

      if (handoffTask?.[0]?.id) {
        await log("Handoff: created task " + handoffTask[0].id.slice(0, 8) + " for " + handoff.next_agent, "handoff_created");
      }
    } else {
      await log("Handoff skipped: agent '" + handoff.next_agent + "' not found", "handoff_error");
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
