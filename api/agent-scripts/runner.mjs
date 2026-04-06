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
const RAILWAY_API_TOKEN = process.env.RAILWAY_DEPLOY_TOKEN || process.env.RAILWAY_TOKEN || "";
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

async function sbDelete(table, filters = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) params.set(k, v);
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + params, {
    method: "DELETE",
    headers: { ...SB_HEADERS, Prefer: "return=representation" },
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

async function callClaude(model, system, messages, tools, maxTokens = 4096, temperature = 0.7) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const headers = {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };

    const body = {
      model, max_tokens: maxTokens, temperature, system, messages,
      ...(tools.length > 0 ? { tools } : {}),
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
let _composioAllowedApps = null;

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
    name: "test_url",
    description: "Fetch a URL and check if it works. Returns the HTTP status and a preview of the page content. Use this to verify your own work — check that deployed sites load, that links work, that pages render correctly.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to test" },
      },
      required: ["url"],
    },
  },
  {
    name: "fail_task",
    description: "Mark the task as FAILED. LAST RESORT ONLY — call this ONLY after you have tried multiple different tools and approaches and can deliver nothing useful.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why you're failing — what you tried and why all alternatives are exhausted" },
        partial_result: { type: "string", description: "Any partial work you completed" },
        tools_tried: { type: "array", items: { type: "string" }, description: "Tools you already attempted" },
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
    description: "Deploy a static site directory. Tries Vercel first, falls back to Railway automatically. Returns a live URL.",
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

const MANAGE_INTEGRATIONS_TOOL = {
  name: "manage_integrations",
  description: "View, assign, or remove Composio app integrations for agents. Use 'list' to see what's connected and who has access, 'assign' to give an agent access to an app, 'remove' to revoke it.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "assign", "remove"], description: "What to do: list all connections, assign an app to an agent, or remove access" },
      app_name: { type: "string", description: "Composio app name (e.g. 'apollo', 'gmail', 'granola'). Required for assign/remove." },
      agent_slug: { type: "string", description: "Target agent slug (e.g. 'growth', 'research', 'engineering'). Required for assign/remove." },
    },
    required: ["action"],
  },
};

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
      case "composio_find_actions":  return await toolComposioFindActions(input);
      case "composio_execute":       return await toolComposioExecute(input);
      case "manage_integrations":    return await toolManageIntegrations(input);
      case "sandbox_bash":       return await toolSandboxBash(input);
      case "sandbox_read_file":  return await toolSandboxReadFile(input);
      case "sandbox_write_file": return await toolSandboxWriteFile(input);
      case "sandbox_list_files": return await toolSandboxListFiles(input);
      case "deploy_static_site": return await toolDeployStaticSite(input);
      case "test_url":           return await toolTestUrl(input);
      case "fail_task":          return JSON.stringify({ acknowledged: true, reason: input.reason });
      default:                   return JSON.stringify({ error: "Unknown tool: " + name });
    }
  } catch (e) {
    return JSON.stringify({ error: name + " failed: " + (e.message || e) });
  }
}

async function toolTestUrl(input) {
  const url = input.url;
  if (!url || !url.startsWith("http")) return JSON.stringify({ error: "Invalid URL" });
  try {
    const r = await fetch(url, {
      method: "GET", redirect: "follow",
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "SalOS-Agent/1.0" },
    });
    const contentType = r.headers.get("content-type") || "";
    let preview = "";
    if (contentType.includes("text") || contentType.includes("html") || contentType.includes("json")) {
      const body = await r.text();
      // Strip HTML tags for a readable preview
      preview = body.replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1000);
    }
    return JSON.stringify({
      status: r.status,
      ok: r.ok,
      content_type: contentType.split(";")[0],
      url: r.url,
      preview: preview || "(binary content)",
    });
  } catch (e) {
    return JSON.stringify({ error: "Failed to reach " + url + ": " + (e.message || "timeout") });
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

  const requestedApp = (input.app_name || "").toLowerCase();
  if (_composioAllowedApps && !_composioAllowedApps.includes(requestedApp)) {
    return JSON.stringify({ error: "App '" + requestedApp + "' is not available for your role. Allowed: " + _composioAllowedApps.join(", ") });
  }

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

  if (_composioAllowedApps) {
    const actionLower = actionUpper.toLowerCase();
    const appMatch = _composioAllowedApps.some(app => actionLower.startsWith(app + "_") || actionLower.startsWith(app.replace(/[_-]/g, "") + "_"));
    if (!appMatch) {
      return JSON.stringify({ error: "Action '" + input.action_id + "' is not allowed for your role. Allowed apps: " + _composioAllowedApps.join(", ") });
    }
  }

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

// ── Manage Integrations tool (orchestrator only) ────────────────────────────

async function toolManageIntegrations(input) {
  const action = (input.action || "").toLowerCase();

  const allAgents = await sbGet("agent_definitions", companyId ? { company_id: "eq." + companyId } : {});
  if (!allAgents || allAgents.length === 0) return JSON.stringify({ error: "No agents found" });

  const agentMap = {};
  for (const a of allAgents) agentMap[a.slug] = a;

  if (action === "list") {
    const accounts = await getComposioAccounts();
    const connectedApps = [...new Set(accounts.filter(a => a.status === "ACTIVE").map(a => a.appName.toLowerCase()))];

    const agentIds = allAgents.map(a => a.id);
    const assignments = await sbGet("agent_tools", {
      "agent_id": "in.(" + agentIds.join(",") + ")",
      connection_source: "eq.composio",
    });

    const perAgent = {};
    for (const a of allAgents) {
      if (a.is_orchestrator) continue;
      const agentRows = (assignments || []).filter(r => r.agent_id === a.id);
      perAgent[a.slug] = {
        name: a.name,
        apps: agentRows.map(r => ({
          app: (r.tool_name || "").toLowerCase(),
          enabled: r.is_enabled,
        })),
      };
    }

    return JSON.stringify({ connected_apps: connectedApps, agent_assignments: perAgent });
  }

  if (action === "assign") {
    const appName = (input.app_name || "").toLowerCase();
    const targetSlug = input.agent_slug;
    if (!appName || !targetSlug) return JSON.stringify({ error: "Both app_name and agent_slug are required" });

    const agent = agentMap[targetSlug];
    if (!agent) return JSON.stringify({ error: "Agent '" + targetSlug + "' not found. Available: " + Object.keys(agentMap).join(", ") });
    if (agent.is_orchestrator) return JSON.stringify({ error: "Cannot assign Composio apps to the orchestrator" });

    const accounts = await getComposioAccounts();
    const connectedApps = [...new Set(accounts.filter(a => a.status === "ACTIVE").map(a => a.appName.toLowerCase()))];
    if (!connectedApps.includes(appName)) {
      return JSON.stringify({ error: "App '" + appName + "' is not connected in Composio. Connected: " + connectedApps.join(", ") });
    }

    const existing = await sbGet("agent_tools", {
      agent_id: "eq." + agent.id,
      connection_source: "eq.composio",
      tool_name: "eq." + appName,
    });

    if (existing && existing.length > 0) {
      await sbPatch("agent_tools", { is_enabled: true }, { id: "eq." + existing[0].id });
      return JSON.stringify({ success: true, action: "re-enabled", app: appName, agent: targetSlug });
    }

    await sbInsert("agent_tools", {
      agent_id: agent.id,
      tool_name: appName,
      tool_type: "composio",
      connection_source: "composio",
      is_enabled: true,
      composio_action_id: appName.toUpperCase(),
    });

    return JSON.stringify({ success: true, action: "assigned", app: appName, agent: targetSlug });
  }

  if (action === "remove") {
    const appName = (input.app_name || "").toLowerCase();
    const targetSlug = input.agent_slug;
    if (!appName || !targetSlug) return JSON.stringify({ error: "Both app_name and agent_slug are required" });

    const agent = agentMap[targetSlug];
    if (!agent) return JSON.stringify({ error: "Agent '" + targetSlug + "' not found" });

    const rows = await sbGet("agent_tools", {
      agent_id: "eq." + agent.id,
      connection_source: "eq.composio",
      tool_name: "eq." + appName,
    });

    if (!rows || rows.length === 0) {
      return JSON.stringify({ error: "App '" + appName + "' is not assigned to " + targetSlug });
    }

    await sbDelete("agent_tools", { id: "eq." + rows[0].id });
    return JSON.stringify({ success: true, action: "removed", app: appName, agent: targetSlug });
  }

  return JSON.stringify({ error: "Unknown action '" + action + "'. Use: list, assign, remove" });
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
  const { project_name, directory } = input;
  if (!project_name || !directory) return JSON.stringify({ error: "project_name and directory are required" });

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

  // Strategy 1: Vercel
  if (VERCEL_TOKEN) {
    try {
      await log("Deploying " + files.length + " files to Vercel as " + project_name, "deploy_start");
      const resp = await fetch("https://api.vercel.com/v13/deployments", {
        method: "POST",
        headers: { Authorization: "Bearer " + VERCEL_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: project_name,
          files: files,
          projectSettings: { framework: null },
          target: "production",
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const url = data.url ? "https://" + data.url : data.alias?.[0] ? "https://" + data.alias[0] : null;
        await log("Deployed to Vercel: " + (url || data.url || "unknown"), "deploy_complete");
        return JSON.stringify({ success: true, url, deployment_url: data.url, project: project_name, files_deployed: files.length, provider: "vercel" });
      }
      const errText = await resp.text().catch(() => "");
      await log("Vercel deploy failed (" + resp.status + "), falling back to Railway: " + errText.slice(0, 150), "deploy_fallback");
    } catch (e) {
      await log("Vercel deploy error, falling back to Railway: " + (e.message || e), "deploy_fallback");
    }
  }

  // Strategy 2: Railway static site via Nixpacks (push files to a temp GitHub repo, deploy from there)
  // Railway doesn't have a file-upload API like Vercel, so we use their service deployment
  // with a GitHub repo that already has the files pushed via github_push_file.
  // For now: create a lightweight static server + deploy via Railway API if token is available.
  if (RAILWAY_API_TOKEN) {
    try {
      await log("Trying Railway deployment for " + project_name, "deploy_railway_start");

      // Write a minimal serve config so Railway can serve the static files
      const pkgJson = JSON.stringify({
        name: project_name,
        scripts: { start: "npx serve . -l $PORT -s" },
        dependencies: { serve: "^14.0.0" },
      });
      writeFileSync(join(dir, "package.json"), pkgJson);

      // Railway needs a repo. Check if we already pushed to GitHub for this task.
      // Use the Railway template deployment API with an image instead.
      // Simplest approach: deploy a Docker-based static site via Railway.
      const dockerfile = "FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm install\nCMD [\"npx\", \"serve\", \".\", \"-l\", \"$PORT\", \"-s\"]\n";
      writeFileSync(join(dir, "Dockerfile"), dockerfile);

      // Create a tarball of the directory for Railway
      const tarPath = join(TASK_WORKDIR || process.cwd(), project_name + ".tar.gz");
      execSync("tar -czf " + JSON.stringify(tarPath) + " -C " + JSON.stringify(dir) + " .", { timeout: 15000 });
      const tarData = readFileSync(tarPath);

      // Get the project ID from the current Railway environment
      const railwayProjectId = process.env.RAILWAY_PROJECT_ID || "";
      const railwayEnvId = process.env.RAILWAY_ENVIRONMENT_ID || "";

      if (railwayProjectId && railwayEnvId) {
        // Create a new service in the same Railway project
        const createSvc = await fetch("https://backboard.railway.app/graphql/v2", {
          method: "POST",
          headers: { Authorization: "Bearer " + RAILWAY_API_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ query: "mutation { serviceCreate(input: { name: \"" + project_name + "\", projectId: \"" + railwayProjectId + "\" }) { id } }" }),
        });
        const svcData = await createSvc.json();
        const newServiceId = svcData?.data?.serviceCreate?.id;

        if (newServiceId) {
          // Generate a public domain for it
          const domainResp = await fetch("https://backboard.railway.app/graphql/v2", {
            method: "POST",
            headers: { Authorization: "Bearer " + RAILWAY_API_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ query: "mutation { serviceDomainCreate(input: { serviceId: \"" + newServiceId + "\", environmentId: \"" + railwayEnvId + "\" }) { domain } }" }),
          });
          const domainData = await domainResp.json();
          const domain = domainData?.data?.serviceDomainCreate?.domain;
          const liveUrl = domain ? "https://" + domain : null;

          await log("Railway service created: " + newServiceId + (liveUrl ? " at " + liveUrl : "") + ". Note: needs a deployment source (GitHub repo) to go live.", "deploy_railway_service");

          // Railway API doesn't support direct file uploads — it needs a GitHub repo connection.
          // If the files are already on GitHub, connect it. Otherwise, report the service + domain.
          return JSON.stringify({
            success: true,
            url: liveUrl,
            provider: "railway",
            project: project_name,
            service_id: newServiceId,
            files_deployed: files.length,
            note: "Railway service created with domain. Connect a GitHub repo or push code to complete deployment.",
          });
        }
      }
      await log("Railway deployment: could not create service", "deploy_railway_fail");
    } catch (e) {
      await log("Railway deploy error: " + (e.message || e), "deploy_railway_fail");
    }
  }

  // Strategy 3: GitHub Pages via raw.githack (last resort)
  if (!VERCEL_TOKEN && !RAILWAY_API_TOKEN) {
    return JSON.stringify({ error: "No deployment credentials configured (VERCEL_TOKEN and RAILWAY_API_TOKEN both missing). Push files to GitHub and use raw.githack.com as a last resort." });
  }

  return JSON.stringify({ error: "Both Vercel and Railway deployments failed. Push files to GitHub and use raw.githack.com as a last resort." });
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

async function runLoop(model, systemPrompt, messages, tools, timeBudgetMs, temperature, existingToolCalls = []) {
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

    const response = await callClaude(model, systemPrompt, messages, tools, 4096, temperature);

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

// Quick health check — just tests if important output URLs are reachable.
// The real quality assessment is done by the agents themselves.
async function checkOutputUrls(resultText, toolCalls) {
  const facts = [];

  // Gather URLs from deliverables
  const urlPattern = /https?:\/\/[^\s)>"]+/g;
  const allUrls = [...new Set((resultText.match(urlPattern) || []).filter(u =>
    !u.includes("api.anthropic.com") && !u.includes("supabase.co") &&
    !u.includes("api.github.com") && !u.includes("serper.dev")
  ))];

  const deployUrls = allUrls.filter(u =>
    u.includes("github.io") || u.includes("vercel.app") || u.includes("netlify.app") ||
    u.includes("docs.google.com") || u.includes("sheets.google.com")
  );

  // Also check registered project
  const projects = await sbGet("projects", { created_by_task_id: "eq." + TASK_ID });
  if (projects?.length && projects[0].deploy_url) {
    const pu = projects[0].deploy_url;
    if (!deployUrls.includes(pu)) deployUrls.unshift(pu);
  }

  for (const url of deployUrls.slice(0, 3)) {
    try {
      const r = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(12000) });
      facts.push({ url, status: r.status, ok: r.ok });
    } catch (e) {
      facts.push({ url, status: 0, ok: false, error: (e.message || "timeout").slice(0, 60) });
    }
  }

  return facts;
}

async function reviewResult(agentName, instruction, resultText, resultStatus, toolCalls) {
  try {
    // Run automated URL health checks
    const urlFacts = await checkOutputUrls(resultText, toolCalls || []);
    const brokenUrls = urlFacts.filter(f => !f.ok);
    const workingUrls = urlFacts.filter(f => f.ok);

    if (urlFacts.length > 0) {
      await log("URL checks: " + workingUrls.length + " ok, " + brokenUrls.length + " broken", "review_url_check");
    }

    // Build context for the reviewer — give it real facts, not rules
    let urlContext = "";
    if (workingUrls.length > 0) {
      urlContext += "\n\nWorking URLs (verified by automated check):\n" + workingUrls.map(u => "✓ " + u.url + " → " + u.status).join("\n");
    }
    if (brokenUrls.length > 0) {
      urlContext += "\n\nBroken URLs (verified by automated check):\n" + brokenUrls.map(u => "✗ " + u.url + " → " + (u.error || "HTTP " + u.status)).join("\n");
    }

    const toolsSummary = (toolCalls || []).length > 0
      ? "\n\nTools used: " + [...new Set((toolCalls || []).map(t => t.tool))].join(", ") + " (" + toolCalls.length + " total calls)"
      : "\n\nTools used: NONE";

    // The agent tested its own URLs? Note that.
    const selfTested = (toolCalls || []).some(t => t.tool === "test_url");

    const prompt = "You are reviewing work submitted by " + agentName + ".\n\n" +
      "TASK: " + instruction + "\n\n" +
      "OUTPUT:\n" + resultText.slice(0, 3000) +
      urlContext + toolsSummary +
      (selfTested ? "\n\nNote: The agent tested its own URLs before submitting." : "") +
      "\n\nThink about this like a manager reviewing an employee's work. " +
      "The question is simple: is there a usable deliverable here? Something the user can immediately use — " +
      "a link that works, a report with real information, a document they can open?\n\n" +
      "If the task asked for something to be built and there's no working link, that's not done. " +
      "If the task asked for research and the output is vague or generic, that's not done. " +
      "But if there's a real, usable output — even if it's not perfect — accept it.\n\n" +
      "Respond with ACCEPT: followed by what the deliverable is, or REJECT: followed by what's specifically missing or broken.";

    const resp = await callClaude("claude-sonnet-4-20250514",
      "You review agent work. Judge like a manager: is there a usable deliverable the user can act on right now?",
      [{ role: "user", content: prompt }], [], 512, 0.3);

    const verdict = resp.content.find(b => b.type === "text")?.text || "";
    if (verdict.startsWith("ACCEPT:")) return { accepted: true, summary: verdict.slice(7).trim() };
    if (verdict.startsWith("REJECT:")) return { accepted: false, summary: verdict.slice(7).trim() };
    await log("Review verdict ambiguous (no ACCEPT/REJECT prefix): " + verdict.slice(0, 100), "review_ambiguous");
    return { accepted: false, summary: "Review inconclusive — could not determine if output meets requirements" };
  } catch (err) {
    await log("Review error: " + (err?.message || err), "review_error");
    return { accepted: false, summary: "Review failed due to an error — manual check needed" };
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

  // 4a. Composio — discover active connected apps, filtered by agent_tools DB rows
  let composioApps = [];
  if (COMPOSIO_KEY && agentSlug !== "orchestrator" && agentDefId) {
    const accounts = await getComposioAccounts();
    const allActive = [...new Set(accounts.filter(a => a.status === "ACTIVE").map(a => a.appName.toLowerCase()))];

    const agentComposioRows = await sbGet("agent_tools", {
      agent_id: "eq." + agentDefId,
      is_enabled: "eq.true",
      connection_source: "eq.composio",
    });
    const allowed = (agentComposioRows || []).map(r => (r.tool_name || "").toLowerCase());

    composioApps = allActive.filter(app => allowed.includes(app));
    _composioAllowedApps = composioApps;
    if (composioApps.length > 0) {
      await log("Composio apps for " + agentSlug + ": " + composioApps.join(", ") + " (from DB, filtered against " + allActive.length + " active accounts)", "composio_loaded");
    }
  }

  // 4b. Inject external integrations into system prompt
  if (composioApps.length > 0) {
    systemPrompt += "\n\n## External Integrations (via Composio)\n" +
      "You have access to these external services. Use composio_find_actions(app_name, use_case) to discover available operations, then composio_execute(action_id, params) to run them.\n" +
      "Your allowed apps: " + composioApps.join(", ") + "\n" +
      "Workflow: 1) composio_find_actions → 2) composio_execute. Always discover actions first — do NOT guess action IDs.\n" +
      "Only use apps listed above — do not attempt to use apps outside your role.";
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
  systemPrompt += "\n\n## How You Work\n" +
    "You are a professional. You do the work, you test the work, you deliver the work.\n\n" +
    "Before you declare anything done, verify it yourself. If you deployed a site, use test_url to check it actually loads. " +
    "If you created a document, make sure it has real content. If you did research, make sure your report contains actual data and sources, not suggestions.\n\n" +
    "If something goes wrong, fix it. Try a different approach. Professionals don't give up on the first error — they find another way. " +
    "If an external service is down, work around it.\n\n" +
    "The only thing that matters is the output: a link the user can click, a document they can read, data they can act on. " +
    "Everything else is just process. Never describe what you would do — do it.";

  if (agentSlug === "engineering") {
    systemPrompt = "You are the Engineering Agent. You build things and deliver working products.\n\n" +
      systemPrompt +
      "\n\n## Your tools\n" +
      "You have: sandbox_write_file, sandbox_bash, sandbox_read_file, sandbox_list_files (local dev environment), " +
      "github_create_repo, github_push_file (version control), deploy_static_site (instant deployment), " +
      "register_project (platform registry), and test_url (verify your work).\n\n" +
      "## How you deliver\n" +
      "When someone asks you to build something, the job isn't done until there's a live URL they can visit. " +
      "Write the code, push it to GitHub, deploy it with deploy_static_site, then use test_url to confirm it loads. " +
      "deploy_static_site handles fallbacks automatically (Vercel → Railway). If it doesn't load, fix it and try again. " +
      "A GitHub repo without a working live URL is an unfinished job.\n\n" +
      "You're an engineer — debug and solve problems, don't report them.\n\n" +
      "For analysis or research tasks, deliver a real report with actual data — not a description of what you'd research.";

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
    const ORCHESTRATOR_ONLY = ["delegate_task", "create_task", "store_memory", "recall_memories", "database_query", "test_url", "fail_task"];
    tools = BASE_TOOLS.filter(t => ORCHESTRATOR_ONLY.includes(t.name));
    tools.push(MANAGE_INTEGRATIONS_TOOL);
  } else {
    tools = [...BASE_TOOLS];
    if (agentSlug === "engineering") tools.push(...ENGINEERING_TOOLS);
    if (agentSlug === "designer") tools.push(...DESIGNER_TOOLS);
    if (composioApps.length > 0) tools.push(...COMPOSIO_TOOLS);
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

  await log("Starting agentic loop — " + tools.length + " tools, " + Math.round(timeBudgetMs / 1000) + "s time budget", "loop_start");

  // 10. Run the loop
  const result = await runLoop(model, systemPrompt, messages, tools, timeBudgetMs, temperature, existingToolCalls);

  await log("Loop finished: " + result.status + " in " + result.turns + " turn(s), " + result.toolCalls.length + " tool call(s)");

  // 10. Determine initial status
  const isDelegated = task.source === "agent" && task.parent_task_id;
  let finalText = result.text;
  let finalToolCalls = result.toolCalls;

  const isTimeoutString = result.text.startsWith("Time budget expired") || result.text.startsWith("Hit safety cap");
  const hasRealOutput = result.status === "completed" && !isTimeoutString;
  const didWorkButTimedOut = result.status === "time_expired" && result.toolCalls.length > 2 && !isTimeoutString;

  let finalStatus = (hasRealOutput || didWorkButTimedOut) ? "completed" : "failed";
  let reviewSummary = null;
  let failReason = null;

  if (finalStatus === "failed" && result.status === "time_expired") {
    failReason = "Time budget expired without producing output";
  } else if (finalStatus === "failed") {
    failReason = finalText.slice(0, 500);
  }

  // 11. Quality review for ALL completed tasks (not just delegated)
  if (finalStatus === "completed") {
    const MAX_REVIEW_RETRIES = 2;
    let reviewAttempt = 0;
    let currentResult = result;

    while (reviewAttempt <= MAX_REVIEW_RETRIES) {
      const review = await reviewResult(agentSlug, instruction, currentResult.text, currentResult.status, currentResult.toolCalls);
      if (review.accepted) {
        reviewSummary = review.summary;
        finalText = currentResult.text;
        finalToolCalls = currentResult.toolCalls;
        finalStatus = "completed";
        await log("Review: ACCEPTED" + (reviewAttempt > 0 ? " (after " + reviewAttempt + " revision(s))" : ""), "review_accepted");
        break;
      }

      reviewAttempt++;
      if (reviewAttempt > MAX_REVIEW_RETRIES) {
        finalStatus = "failed";
        failReason = "Rejected after " + MAX_REVIEW_RETRIES + " revision attempts: " + review.summary;
        finalText = failReason;
        await log("Review: FINAL REJECT after " + MAX_REVIEW_RETRIES + " retries — " + review.summary, "review_rejected");
        break;
      }

      await log("Review: REJECTED (attempt " + reviewAttempt + "/" + MAX_REVIEW_RETRIES + ") — " + review.summary + ". Sending back for revision.", "review_retry");

      const revisionMessages = [...messages];
      revisionMessages.push({
        role: "user",
        content: "Your work was reviewed and sent back. Here's the feedback:\n\n" +
          review.summary + "\n\n" +
          "Fix the issues and deliver a working result. Use test_url to verify your links before submitting again.",
      });

      const REVISION_TIME_BUDGET = 3 * 60 * 1000;
      const retryResult = await runLoop(model, systemPrompt, revisionMessages, tools, REVISION_TIME_BUDGET, temperature, currentResult.toolCalls);
      await log("Revision loop done: " + retryResult.status + " in " + retryResult.turns + " turns", "review_revision_done");

      if (retryResult.status !== "completed") {
        finalStatus = "failed";
        failReason = "Failed during revision attempt " + reviewAttempt + ": " + retryResult.text;
        finalText = failReason;
        await log("Revision attempt " + reviewAttempt + " failed: " + retryResult.status, "review_revision_failed");
        break;
      }

      currentResult = retryResult;
    }
  }

  // 12. Extract deliverables from the latest result (post-revision if applicable)
  const deliverables = extractDeliverables(finalToolCalls || []);
  if (deliverables.length > 0) {
    await log("Deliverables: " + deliverables.map(d => d.type + (d.url ? " " + d.url : "")).join(", "), "deliverables");
  }

  if (!isDelegated) {
    await sbInsert("chat_messages", {
      conversation_id: CONVERSATION_ID,
      role: "orchestrator",
      content: finalText,
      timestamp: new Date().toISOString(),
      metadata: {
        model, turns: result.turns,
        tools_used: [...new Set(finalToolCalls.map(t => t.tool))],
        agent_slug: agentSlug,
        deliverables: deliverables.length > 0 ? deliverables : undefined,
      },
    });
  } else {
    const notificationContent = finalStatus === "completed"
      ? formatNotification(agentSlug, task.title, finalText, deliverables)
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
      tools_used: [...new Set(finalToolCalls.map(t => t.tool))],
      tool_calls: finalToolCalls,
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
