// runner.mjs — Executes agent tasks (Railway worker or Vercel Sandbox)
// Zero external dependencies: uses only Node.js builtins + fetch
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  readdirSync, statSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";

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

// ── Token usage tracking ───────────────────────────────────────────────────
const tokenUsage = {
  input_tokens: 0, output_tokens: 0,
  cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  api_calls: 0,
};

// Cost ceiling per task (USD). Auto-cancels task if exceeded.
// Override hierarchy: task.metadata.work_order.estimated_cost_usd  >  env  >  $2 default.
// (Work-order override is applied in main() after the task is loaded.)
let MAX_TASK_COST_USD = parseFloat(process.env.MAX_TASK_COST_USD || "2.0");

// Rough Claude Sonnet pricing (USD per 1M tokens) — covers the most-used model.
// Haiku is cheaper but we use the Sonnet rate as a safe ceiling estimator.
const PRICE_INPUT_PER_M = 3.0;
const PRICE_OUTPUT_PER_M = 15.0;
const PRICE_CACHE_WRITE_PER_M = 3.75;
const PRICE_CACHE_READ_PER_M = 0.30;

function estimatedCostUsd() {
  const u = tokenUsage;
  return (
    (u.input_tokens * PRICE_INPUT_PER_M) +
    (u.output_tokens * PRICE_OUTPUT_PER_M) +
    (u.cache_creation_input_tokens * PRICE_CACHE_WRITE_PER_M) +
    (u.cache_read_input_tokens * PRICE_CACHE_READ_PER_M)
  ) / 1_000_000;
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
      "anthropic-beta": "prompt-caching-2024-07-31",
      "content-type": "application/json",
    };

    // Opus 4.7+ deprecated `temperature` — omit it for those models.
    // Older models (Sonnet, Opus 4.6 and earlier) still accept + need it.
    const supportsTemperature = !(model.includes("opus-4-7") || model.includes("opus-4-8"));
    const body = {
      model, max_tokens: maxTokens, system, messages,
      ...(supportsTemperature ? { temperature } : {}),
      ...(tools.length > 0 ? { tools } : {}),
    };

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (resp.ok) {
      const data = await resp.json();
      // Track token usage
      if (data.usage) {
        tokenUsage.input_tokens += data.usage.input_tokens || 0;
        tokenUsage.output_tokens += data.usage.output_tokens || 0;
        tokenUsage.cache_creation_input_tokens += data.usage.cache_creation_input_tokens || 0;
        tokenUsage.cache_read_input_tokens += data.usage.cache_read_input_tokens || 0;
      }
      tokenUsage.api_calls++;
      return data;
    }

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
let agentDefId = null;
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
    description: "Search stored memories for relevant context. Use scope to control whose memories you see.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        category: { type: "string" },
        limit: { type: "number" },
        scope: { type: "string", description: "mine (your memories only, default), team (all company memories), or agent:<slug> (specific agent's memories)" },
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
    name: "update_goal_progress",
    description: "Report progress on a company goal after completing relevant work. Updates the goal's current_value.",
    input_schema: {
      type: "object",
      properties: {
        goal_title: { type: "string", description: "Title of the goal (fuzzy matched)" },
        new_value: { type: "number", description: "New current_value for the metric" },
        note: { type: "string", description: "Brief note on what you did to advance this goal" },
      },
      required: ["goal_title", "new_value"],
    },
  },
  {
    name: "read_agent_output",
    description: "Read the output/deliverables from a completed task. Use to build on another agent's work.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Specific task ID to read" },
        agent_slug: { type: "string", description: "Or: get the latest completed task by this agent" },
      },
    },
  },
  {
    name: "message_agent",
    description: "Leave a message for another agent. They'll see it on their next run. Use for coordination without full task delegation.",
    input_schema: {
      type: "object",
      properties: {
        target_agent: { type: "string", description: "Target agent slug: engineering, growth, research, designer, executive-assistant, orchestrator" },
        message: { type: "string", description: "The message content" },
        urgency: { type: "string", enum: ["fyi", "request", "blocker"], description: "fyi=informational, request=action needed, blocker=blocking your work" },
      },
      required: ["target_agent", "message"],
    },
  },
  {
    name: "update_agent",
    description:
      "Modify another agent's system_prompt, model, or description. Use when you spot a pattern — an agent " +
      "consistently misses a step, needs more context about the company, or could benefit from a sharper " +
      "instruction. The change is versioned and reversible. REQUIRES the target agent to have " +
      "is_safe_auto_modify=true (Sal opts in per-agent). Cannot modify the orchestrator. " +
      "Always include a clear `reason` — it's permanently logged.",
    input_schema: {
      type: "object",
      properties: {
        agent_slug: { type: "string", description: "Target agent slug (research, engineering, designer, growth, etc.)" },
        system_prompt: { type: "string", description: "New system prompt (replaces existing)" },
        model: { type: "string", description: "New model (e.g. claude-opus-4-7, claude-sonnet-4-6)" },
        description: { type: "string", description: "New short description shown in /agents" },
        reason: { type: "string", description: "Why this change — what pattern did you spot, what should improve" },
        dry_run: { type: "boolean", description: "If true, return what WOULD change without writing. Default false." },
      },
      required: ["agent_slug", "reason"],
    },
  },
  {
    name: "revert_agent",
    description:
      "Roll an agent back to a previous version. Use after a recent update_agent that didn't help, or " +
      "if a specialist's behaviour got worse. Pass version_number to target a specific version, or omit " +
      "to revert to the immediately-prior one.",
    input_schema: {
      type: "object",
      properties: {
        agent_slug: { type: "string" },
        version_number: { type: "number", description: "Specific version to restore. Omit to use the immediately-prior version." },
        reason: { type: "string", description: "Why you're reverting" },
      },
      required: ["agent_slug", "reason"],
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
  {
    name: "call_integration",
    description:
      "Call an external service connected via the API Center (OpenAI, GitHub, Resend, etc.). " +
      "Available vendors and their actions are listed in the 'Available Integrations' block of your system prompt. " +
      "Pick exactly one vendor + one action; pass the action's required params.",
    input_schema: {
      type: "object",
      properties: {
        vendor: { type: "string", description: "Vendor slug, e.g. 'openai', 'github', 'resend'" },
        action: { type: "string", description: "Action name within the vendor, e.g. 'chat', 'send', 'search'" },
        params: { type: "object", description: "Action-specific parameters (see Available Integrations for the schema)" },
      },
      required: ["vendor", "action", "params"],
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
      case "update_goal_progress": return await toolUpdateGoalProgress(input);
      case "read_agent_output":  return await toolReadAgentOutput(input);
      case "message_agent":      return await toolMessageAgent(input);
      case "update_agent":       return await toolUpdateAgent(input);
      case "revert_agent":       return await toolRevertAgent(input);
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
      case "call_integration":   return await toolCallIntegration(input);
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

// ── call_integration: dispatch to user-connected APIs (API Center) ──────────
//
// Reads from the integrations table (loaded once per task into _activeIntegrations).
// Decrypts credentials, substitutes {{var}} into the action's body_template,
// builds auth headers from the row's persisted config, fires the request.
// Self-healing: on 401/403, marks the integration as 'broken' so the user is
// alerted (Phase 4 surfaces this in chat).

import { createDecipheriv as _createDecipheriv } from "node:crypto";

function decryptIntegrationBlob(blob) {
  if (!blob || blob.v !== 1) throw new Error("Unsupported encrypted blob version");
  const rawKey = process.env.INTEGRATIONS_ENCRYPTION_KEY;
  if (!rawKey) throw new Error("INTEGRATIONS_ENCRYPTION_KEY not set in runner env");
  const key = Buffer.from(rawKey, "base64");
  if (key.length !== 32) throw new Error("INTEGRATIONS_ENCRYPTION_KEY must decode to 32 bytes");
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const ct = Buffer.from(blob.ciphertext, "base64");
  const dec = _createDecipheriv("aes-256-gcm", key, iv);
  dec.setAuthTag(tag);
  const pt = Buffer.concat([dec.update(ct), dec.final()]).toString("utf8");
  return JSON.parse(pt);
}

// Recursively substitute {{var}} placeholders in a template using params.
// If the entire string is "{{var}}", returns params.var with original type
// (so arrays stay arrays, numbers stay numbers). Otherwise does string replace.
function substituteTemplate(template, params) {
  if (typeof template === "string") {
    const m = template.match(/^\{\{(\w+)\}\}$/);
    if (m) return params[m[1]];
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) => String(params[k] ?? ""));
  }
  if (Array.isArray(template)) return template.map(v => substituteTemplate(v, params));
  if (template && typeof template === "object") {
    const out = {};
    for (const [k, v] of Object.entries(template)) out[k] = substituteTemplate(v, params);
    return out;
  }
  return template;
}

// Cache of active integrations for this task's company. Loaded once at task
// start (in main()) and read by toolCallIntegration.
let _activeIntegrations = [];

async function loadActiveIntegrations(forCompanyId) {
  if (!forCompanyId) return [];
  const params = new URLSearchParams({
    select: "id,vendor,display_name,auth_type,encrypted_credentials,config,actions,status",
    company_id: "eq." + forCompanyId,
    status: "in.(active,unverified)",  // try unverified too — first call will reveal if it works
  });
  const r = await fetch(SUPABASE_URL + "/rest/v1/integrations?" + params, { headers: SB_HEADERS });
  if (!r.ok) return [];
  return await r.json();
}

async function markIntegrationBroken(integrationId, message) {
  await sbPatch("integrations", {
    status: "broken",
    last_tested_at: new Date().toISOString(),
    last_test_error: message,
  }, { id: "eq." + integrationId });
}

async function toolCallIntegration(input) {
  const vendor = String(input.vendor || "").toLowerCase();
  const action = String(input.action || "");
  const params = (input.params && typeof input.params === "object") ? input.params : {};

  if (!vendor || !action) {
    return JSON.stringify({ error: "vendor and action are required" });
  }

  // Re-check the work-order vendor allowlist (defence in depth — the runner
  // also filters tools by work order, but the LLM might still try).
  if (_workOrderVendorAllow && !_workOrderVendorAllow.has(vendor)) {
    return JSON.stringify({
      error: `vendor '${vendor}' is not allowed for this work order. Allowed: ${[..._workOrderVendorAllow].join(", ") || "(none)"}`,
    });
  }

  const row = _activeIntegrations.find(i => i.vendor === vendor);
  if (!row) {
    return JSON.stringify({
      error: `Integration '${vendor}' is not connected for this company. Ask Sal to add it via the API Center.`,
    });
  }

  const actionDef = (row.actions || []).find(a => a.name === action);
  if (!actionDef) {
    const available = (row.actions || []).map(a => a.name).join(", ");
    return JSON.stringify({
      error: `Action '${action}' not found for vendor '${vendor}'. Available: ${available}`,
    });
  }

  // Decrypt credentials and build headers
  let creds;
  try {
    creds = row.encrypted_credentials ? decryptIntegrationBlob(row.encrypted_credentials) : {};
  } catch (e) {
    return JSON.stringify({ error: "Could not decrypt credentials: " + (e.message || e) });
  }

  const cfg = row.config || {};
  const baseUrl = String(cfg.base_url || "").replace(/\/$/, "");

  // Vendor/action defaults — "always use the best" without making the agent specify.
  // Agent's params override these. If you add a new known vendor here, also drop the
  // user-facing config knobs in api/lib/vendor-registry.ts so the form stays simple.
  const VENDOR_PARAM_DEFAULTS = {
    openai: {
      chat:     { model: "gpt-4o", max_tokens: 2048, temperature: 0.7 },
    },
    anthropic: {
      messages: { model: "claude-opus-4-7", max_tokens: 2048 },
    },
  };
  const defaults = VENDOR_PARAM_DEFAULTS[vendor]?.[action] || {};
  const filledParams = { ...defaults, ...params };

  const path = substituteTemplate(actionDef.path, filledParams);
  const url = baseUrl + path;

  const headers = { "Content-Type": "application/json" };

  // jwt_es256 vendors (Apple App Store Connect): sign a fresh JWT per call.
  // Static-key vendors: substitute creds into the auth header template.
  if (row.auth_type === "jwt_es256" && cfg.auth_header_name) {
    try {
      const { signAppStoreConnectJwt } = await import("../lib/jwt-es256.mjs");
      const jwt = signAppStoreConnectJwt(creds.key_id, creds.issuer_id, creds.private_key);
      headers[cfg.auth_header_name] = "Bearer " + jwt;
    } catch (e) {
      return JSON.stringify({ error: "Could not sign JWT for " + vendor + ": " + (e.message || e) });
    }
  } else if (cfg.auth_header_name && cfg.auth_header_template) {
    let authValue = String(cfg.auth_header_template);
    for (const [k, v] of Object.entries(creds)) {
      authValue = authValue.replaceAll("{{" + k + "}}", String(v));
    }
    headers[cfg.auth_header_name] = authValue;
  }

  // Build body
  let body;
  if (actionDef.method !== "GET" && actionDef.body_template) {
    const filled = substituteTemplate(actionDef.body_template, filledParams);
    body = JSON.stringify(filled);
  } else if (actionDef.method !== "GET") {
    body = JSON.stringify(filledParams);
  }

  await log(
    "Calling integration: " + vendor + "." + action + " " + actionDef.method + " " + url,
    "integration_call"
  );

  let r;
  try {
    r = await fetch(url, {
      method: actionDef.method,
      headers,
      body,
      signal: AbortSignal.timeout(45_000),
    });
  } catch (e) {
    return JSON.stringify({ error: "Network error calling " + vendor + ": " + (e.message || e) });
  }

  // Self-healing: if auth failed, mark broken AND post an integration_problem
  // card to the conversation so the user sees a Reconnect button immediately.
  if (r.status === 401 || r.status === 403) {
    const errText = await r.text().catch(() => "");
    const briefError = `${r.status} ${errText.slice(0, 150)}`.trim();
    await markIntegrationBroken(row.id, "Auth failed (" + r.status + ") on " + action);
    if (CONVERSATION_ID) {
      await sbInsert("chat_messages", {
        conversation_id: CONVERSATION_ID,
        role: "system",
        kind: "integration_problem",
        content: `⚠ Integration broken: ${row.display_name || vendor} returned ${r.status} on ${action}. Reconnect to fix.`,
        timestamp: new Date().toISOString(),
        metadata: {
          kind: "integration_problem",
          vendor: row.vendor,
          display_name: row.display_name,
          integration_id: row.id,
          action,
          original_error: briefError,
        },
      }).catch(() => {}); // non-fatal; agent still gets the error response
    }
    return JSON.stringify({
      error: `Authentication failed (${r.status}) calling ${vendor}.${action}. The integration has been marked broken — Sal has been notified to update credentials in the API Center.`,
    });
  }

  const respText = await r.text();
  let respJson = null;
  try { respJson = JSON.parse(respText); } catch { respJson = null; }

  if (!r.ok) {
    return JSON.stringify({
      error: `${vendor}.${action} returned ${r.status}: ${respText.slice(0, 500)}`,
      status: r.status,
    });
  }

  // Truncate large responses so we don't blow the agent's context
  const responseSummary = respJson ?? respText.slice(0, 8000);
  return JSON.stringify({
    success: true,
    status: r.status,
    response: responseSummary,
  });
}

// Per-work-order vendor allowlist for call_integration (defence in depth on
// top of the tool-name allowlist). Set by main() based on task.metadata.work_order.type.
let _workOrderVendorAllow = null;

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

const ALLOWED_QUERY_TABLES = new Set([
  "agents", "tasks", "chat_messages", "conversations",
  "agent_definitions", "memories", "companies", "company_goals", "projects",
]);

async function toolDatabaseQuery(input) {
  if (!ALLOWED_QUERY_TABLES.has(input.table)) {
    return JSON.stringify({ error: "Access denied: table '" + input.table + "' is not queryable. Allowed: " + [...ALLOWED_QUERY_TABLES].join(", ") });
  }

  const params = new URLSearchParams({ select: input.select || "*" });
  if (input.limit) params.set("limit", String(input.limit));
  else params.set("limit", "25");
  if (input.order_by) params.set("order", input.order_by + "." + (input.ascending === false ? "desc" : "asc"));
  for (const f of (input.filters || [])) params.set(f.column, f.operator + "." + f.value);

  // Enforce company isolation for multi-tenant safety
  if (companyId && input.table !== "companies") {
    params.set("company_id", "eq." + companyId);
  }

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
  if (input.category) {
    params.set("category", "eq." + input.category);
  } else {
    // Exclude agent_message category by default (use category:"agent_message" to explicitly retrieve)
    params.set("category", "neq.agent_message");
  }

  // Scope: "mine" (default) = this agent's memories, "team" = all, "agent:<slug>" = specific agent
  const scope = (input.scope || "mine").trim();
  if (scope === "mine" && agentDefId) {
    params.set("agent_definition_id", "eq." + agentDefId);
  } else if (scope.startsWith("agent:")) {
    const targetSlug = scope.slice(6);
    const targetAgent = await sbGet("agent_definitions", {
      slug: "eq." + targetSlug, company_id: "eq." + companyId,
    }, { select: "id", single: true });
    if (targetAgent) params.set("agent_definition_id", "eq." + targetAgent.id);
  }
  // scope === "team" => no agent filter, sees all company memories

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

async function toolUpdateGoalProgress(input) {
  if (!input.goal_title || input.new_value === undefined) {
    return JSON.stringify({ error: "goal_title and new_value are required" });
  }

  // Fetch active goals for this company
  const goals = await sbGet("company_goals", {
    company_id: "eq." + companyId, status: "eq.active",
  });
  if (!goals?.length) return JSON.stringify({ error: "No active goals found" });

  // Fuzzy match goal title
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
  const targetNorm = normalize(input.goal_title);
  let bestMatch = null;
  let bestScore = 0;
  for (const g of goals) {
    const goalNorm = normalize(g.title);
    // Word overlap scoring
    const targetWords = new Set(targetNorm.split(" "));
    const goalWords = new Set(goalNorm.split(" "));
    let shared = 0;
    for (const w of targetWords) if (goalWords.has(w)) shared++;
    const score = shared / Math.max(targetWords.size, goalWords.size, 1);
    if (score > bestScore) { bestScore = score; bestMatch = g; }
  }
  if (!bestMatch || bestScore < 0.3) {
    return JSON.stringify({ error: "No matching goal found for '" + input.goal_title + "'. Active goals: " + goals.map(g => g.title).join(", ") });
  }

  // Update goal
  const oldValue = bestMatch.current_value ?? 0;
  await sbPatch("company_goals", {
    current_value: input.new_value,
  }, { id: "eq." + bestMatch.id });

  // Store progress note as memory
  const note = input.note || ("Updated " + bestMatch.title + " from " + oldValue + " to " + input.new_value);
  await sbInsert("memories", {
    content: note,
    category: "metric",
    importance: 7,
    user_id: "00000000-0000-0000-0000-000000000000",
    company_id: companyId,
    agent_definition_id: agentDefId,
    metadata: { source: "goal_update", agent_slug: agentSlug, goal_id: bestMatch.id, old_value: oldValue, new_value: input.new_value },
  });

  return JSON.stringify({
    success: true,
    goal: bestMatch.title,
    previous: oldValue,
    current: input.new_value,
    target: bestMatch.target_value,
    metric: bestMatch.target_metric,
  });
}

async function toolReadAgentOutput(input) {
  let taskFilter = {};
  if (input.task_id) {
    taskFilter = { id: "eq." + input.task_id };
  } else if (input.agent_slug) {
    const targetAgent = await sbGet("agent_definitions", {
      slug: "eq." + input.agent_slug, company_id: "eq." + companyId,
    }, { select: "id", single: true });
    if (!targetAgent) return JSON.stringify({ error: "Agent '" + input.agent_slug + "' not found" });
    taskFilter = { agent_definition_id: "eq." + targetAgent.id, status: "eq.completed" };
  } else {
    return JSON.stringify({ error: "Provide either task_id or agent_slug" });
  }

  // Fetch task
  const params = new URLSearchParams({ ...taskFilter, select: "id,title,status,completed_at,agent_definition_id" });
  if (companyId) params.set("company_id", "eq." + companyId);
  params.set("order", "completed_at.desc");
  params.set("limit", "1");
  const taskR = await fetch(SUPABASE_URL + "/rest/v1/tasks?" + params, { headers: SB_HEADERS });
  if (!taskR.ok) return JSON.stringify({ error: "Failed to fetch task" });
  const tasks = await taskR.json();
  if (!tasks.length) return JSON.stringify({ error: "No matching completed task found" });

  const targetTask = tasks[0];
  // Fetch result
  const resultParams = new URLSearchParams({ task_id: "eq." + targetTask.id, select: "data", limit: "1" });
  const resultR = await fetch(SUPABASE_URL + "/rest/v1/task_results?" + resultParams, { headers: SB_HEADERS });
  if (!resultR.ok) return JSON.stringify({ error: "Failed to fetch task result" });
  const results = await resultR.json();
  if (!results.length) return JSON.stringify({ error: "No result found for task " + targetTask.id });

  const data = results[0].data || {};
  return JSON.stringify({
    task_id: targetTask.id,
    title: targetTask.title,
    completed_at: targetTask.completed_at,
    response: (data.response || "").slice(0, 3000),
    tools_used: data.tools_used || [],
    deliverables: data.tool_calls?.filter(t => t.tool === "deploy_static_site" || t.tool === "register_project" || t.tool === "github_push_file").map(t => ({ tool: t.tool, input: t.input })).slice(0, 5) || [],
  });
}

async function toolMessageAgent(input) {
  if (!input.target_agent || !input.message) {
    return JSON.stringify({ error: "target_agent and message are required" });
  }
  if (input.target_agent === agentSlug) {
    return JSON.stringify({ error: "Cannot message yourself" });
  }

  // Verify target agent exists
  const targetAgent = await sbGet("agent_definitions", {
    slug: "eq." + input.target_agent, company_id: "eq." + companyId,
  }, { select: "id,name", single: true });
  if (!targetAgent) return JSON.stringify({ error: "Agent '" + input.target_agent + "' not found" });

  // Store as a memory targeted at the other agent
  const result = await sbInsert("memories", {
    content: input.message,
    category: "agent_message",
    importance: input.urgency === "blocker" ? 9 : input.urgency === "request" ? 7 : 5,
    user_id: "00000000-0000-0000-0000-000000000000",
    company_id: companyId,
    agent_definition_id: targetAgent.id,
    metadata: {
      source: "agent_message",
      from: agentSlug,
      target_agent: input.target_agent,
      urgency: input.urgency || "fyi",
      task_id: TASK_ID,
    },
    // Messages expire after 7 days
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (!result) return JSON.stringify({ error: "Failed to send message" });
  return JSON.stringify({ success: true, sent_to: targetAgent.name, urgency: input.urgency || "fyi" });
}

// ── Self-modification tools (orchestrator) ─────────────────────────────────
//
// update_agent + revert_agent let the orchestrator improve teammates over time.
// Every change is versioned in agent_definition_versions, so any mistake is one
// click away from being undone. Three guards:
//   1) Target agent must have is_safe_auto_modify = true (Sal opts in per agent)
//   2) Cannot modify the orchestrator itself
//   3) reason is required and logged forever

const ALLOWED_AGENT_MODELS = new Set([
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4-7",
  "claude-haiku-4-5",
  "claude-haiku-4-20250514",
]);

async function loadModifiableAgent(slug) {
  const target = await sbGet("agent_definitions", {
    slug: "eq." + slug, company_id: "eq." + companyId,
  }, { select: "id,name,slug,system_prompt,model,description,is_orchestrator,is_safe_auto_modify", single: true });
  if (!target) return { error: `Agent '${slug}' not found in this company` };
  if (target.is_orchestrator) return { error: "Refusing to modify the orchestrator — it would let it disable its own safety checks" };
  if (!target.is_safe_auto_modify) return { error: `Agent '${slug}' is not opted in to auto-modify. Sal must enable 'Allow orchestrator to modify' in /company-settings?tab=agents first.` };
  return { agent: target };
}

function summariseAgentDiff(before, patch) {
  const changes = [];
  if (patch.system_prompt && patch.system_prompt !== before.system_prompt) {
    const beforeLen = (before.system_prompt || "").length;
    const afterLen = patch.system_prompt.length;
    changes.push(`system_prompt: ${beforeLen} → ${afterLen} chars`);
  }
  if (patch.model && patch.model !== before.model) changes.push(`model: ${before.model} → ${patch.model}`);
  if (patch.description !== undefined && patch.description !== before.description) changes.push("description updated");
  return changes.join("; ") || "no effective change";
}

async function toolUpdateAgent(input) {
  if (!input.agent_slug) return JSON.stringify({ error: "agent_slug is required" });
  if (!input.reason || String(input.reason).trim().length < 10) {
    return JSON.stringify({ error: "reason is required and must explain WHY (10+ chars). The reason is permanently logged." });
  }

  const { agent: target, error } = await loadModifiableAgent(input.agent_slug);
  if (error) return JSON.stringify({ error });

  // Build patch — only fields actually provided
  const patch = {};
  if (typeof input.system_prompt === "string" && input.system_prompt.trim()) patch.system_prompt = input.system_prompt;
  if (typeof input.model === "string" && input.model.trim()) {
    if (!ALLOWED_AGENT_MODELS.has(input.model)) {
      return JSON.stringify({ error: `Model '${input.model}' is not in the allowlist. Allowed: ${[...ALLOWED_AGENT_MODELS].join(", ")}` });
    }
    patch.model = input.model;
  }
  if (typeof input.description === "string") patch.description = input.description;

  if (Object.keys(patch).length === 0) {
    return JSON.stringify({ error: "Provide at least one of: system_prompt, model, description" });
  }

  const diffSummary = summariseAgentDiff(target, patch);

  if (input.dry_run) {
    return JSON.stringify({ dry_run: true, would_change: diffSummary, agent: target.name, current_version_will_be: "next version after writes" });
  }

  // Read latest version_number to compute next
  const latestVersions = await sbGet("agent_definition_versions", {
    agent_definition_id: "eq." + target.id,
    select: "version_number",
    order: "version_number.desc",
    limit: "1",
  });
  const nextVersion = (latestVersions?.[0]?.version_number || 0) + 1;

  // Compose post-patch snapshot for the version row
  const snapshot = {
    system_prompt: patch.system_prompt ?? target.system_prompt,
    model: patch.model ?? target.model,
    description: patch.description ?? target.description,
  };

  const versionRow = await sbInsert("agent_definition_versions", {
    agent_definition_id: target.id,
    company_id: companyId,
    version_number: nextVersion,
    system_prompt: snapshot.system_prompt,
    model: snapshot.model,
    description: snapshot.description,
    modified_by: agentSlug === "orchestrator" ? "orchestrator" : `specialist:${agentSlug}`,
    modified_by_task_id: TASK_ID,
    change_reason: input.reason,
    diff_summary: diffSummary,
  });
  if (!versionRow) return JSON.stringify({ error: "Failed to insert version row — aborted before mutating agent" });

  // Apply the patch to the live agent
  await sbPatch("agent_definitions", { ...patch, updated_at: new Date().toISOString() }, { id: "eq." + target.id });

  await log(`update_agent: ${target.slug} → v${nextVersion} (${diffSummary}). Reason: ${input.reason}`, "agent_config_changed", {
    target_agent_id: target.id,
    target_slug: target.slug,
    version_number: nextVersion,
    diff_summary: diffSummary,
  });

  return JSON.stringify({
    success: true,
    agent: target.name,
    version_number: nextVersion,
    diff_summary: diffSummary,
    revert_with: `revert_agent({agent_slug: "${target.slug}", version_number: ${nextVersion - 1}, reason: "..."})`,
  });
}

async function toolRevertAgent(input) {
  if (!input.agent_slug) return JSON.stringify({ error: "agent_slug is required" });
  if (!input.reason || String(input.reason).trim().length < 5) {
    return JSON.stringify({ error: "reason is required (5+ chars)" });
  }

  const { agent: target, error } = await loadModifiableAgent(input.agent_slug);
  if (error) return JSON.stringify({ error });

  // Find target version. If not specified, use the immediately-prior one.
  let targetVersion;
  if (typeof input.version_number === "number") {
    const rows = await sbGet("agent_definition_versions", {
      agent_definition_id: "eq." + target.id,
      version_number: "eq." + input.version_number,
      select: "*",
      single: true,
    });
    targetVersion = rows;
  } else {
    const all = await sbGet("agent_definition_versions", {
      agent_definition_id: "eq." + target.id,
      select: "*",
      order: "version_number.desc",
      limit: "2",
    });
    targetVersion = all?.[1]; // [0] is current, [1] is prior
  }
  if (!targetVersion) return JSON.stringify({ error: "No version found to revert to" });

  // Apply the version's snapshot back to live row
  const restorePatch = {
    system_prompt: targetVersion.system_prompt,
    model: targetVersion.model,
    description: targetVersion.description,
    updated_at: new Date().toISOString(),
  };
  await sbPatch("agent_definitions", restorePatch, { id: "eq." + target.id });

  // Log the revert as a NEW version row (history is append-only — no rewrites)
  const latestVersions = await sbGet("agent_definition_versions", {
    agent_definition_id: "eq." + target.id,
    select: "version_number",
    order: "version_number.desc",
    limit: "1",
  });
  const nextVersion = (latestVersions?.[0]?.version_number || 0) + 1;

  await sbInsert("agent_definition_versions", {
    agent_definition_id: target.id,
    company_id: companyId,
    version_number: nextVersion,
    system_prompt: targetVersion.system_prompt,
    model: targetVersion.model,
    description: targetVersion.description,
    modified_by: agentSlug === "orchestrator" ? "orchestrator" : `specialist:${agentSlug}`,
    modified_by_task_id: TASK_ID,
    change_reason: `Revert to v${targetVersion.version_number}: ${input.reason}`,
    diff_summary: `Reverted to v${targetVersion.version_number}`,
  });

  await log(`revert_agent: ${target.slug} → v${targetVersion.version_number} (logged as v${nextVersion}). Reason: ${input.reason}`, "agent_config_changed", {
    target_agent_id: target.id,
    target_slug: target.slug,
    reverted_to_version: targetVersion.version_number,
    new_version_row: nextVersion,
  });

  return JSON.stringify({
    success: true,
    agent: target.name,
    reverted_to_version: targetVersion.version_number,
    new_version_row: nextVersion,
  });
}

const MAX_DELEGATION_DEPTH = 4;

async function toolDelegateTask(input) {
  const agentDef = await sbGet("agent_definitions", {
    slug: "eq." + input.agent_slug, company_id: "eq." + companyId,
  }, { select: "id,name,slug", single: true });
  if (!agentDef) return JSON.stringify({ error: "Agent '" + input.agent_slug + "' not found" });
  if (agentDef.slug === agentSlug) return JSON.stringify({ error: "Cannot delegate to yourself" });

  // Check delegation depth to prevent circular chains
  const currentTask = await sbGet("tasks", { id: "eq." + TASK_ID }, { select: "metadata", single: true });
  const currentDepth = (currentTask?.metadata?.delegation_depth) || 0;
  if (currentDepth >= MAX_DELEGATION_DEPTH) {
    return JSON.stringify({ error: "Maximum delegation depth (" + MAX_DELEGATION_DEPTH + ") reached. Complete this task yourself or store findings as a memory for the target agent." });
  }

  const taskMeta = { delegation_depth: currentDepth + 1 };
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
    metadata: taskMeta,
    source: "agent",
  });
  if (!result) return JSON.stringify({ error: "Failed to create delegated task" });
  childTasks.push({ taskId: result[0].id, conversationId: CONVERSATION_ID });
  return JSON.stringify({ success: true, agent: agentDef.name, task_id: result[0].id, status: "queued", delegation_depth: currentDepth + 1 });
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
    if (!input.columns?.length) {
      return JSON.stringify({ error: "columns array required for alter_table (raw SQL is not supported)" });
    }
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

  return JSON.stringify({ error: "Unknown action: " + action });
}

async function toolRegisterProject(input) {
  // UPSERT by (company_id, name). The unique index in migration
  // 20260424000000_projects_unique_name.sql guarantees we never duplicate.
  // PostgREST: send Prefer: resolution=merge-duplicates with on_conflict.
  const row = {
    company_id: companyId,
    name: input.name,
    description: input.description || null,
    repo_url: input.repo_url || null,
    deploy_url: input.deploy_url || null,
    tables_created: input.tables_created || [],
    status: input.status || "building",
    created_by_task_id: TASK_ID,
    updated_at: new Date().toISOString(),
  };
  const params = new URLSearchParams({ on_conflict: "company_id,name" });
  const r = await fetch(SUPABASE_URL + "/rest/v1/projects?" + params, {
    method: "POST",
    headers: {
      ...SB_HEADERS,
      Prefer: "return=representation,resolution=merge-duplicates",
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    return JSON.stringify({ error: "Failed to register project: " + errText.slice(0, 300) });
  }
  const result = await r.json();
  const project = result[0];
  const isNew = project?.created_at === project?.updated_at;
  return JSON.stringify({
    success: true,
    project_id: project?.id,
    action: isNew ? "registered" : "updated",
    note: isNew ? "New project registered." : "Existing project updated (no duplicate created).",
  });
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

const STRIPPED_ENV_KEYS = [
  "ANTHROPIC_API_KEY", "SUPABASE_KEY", "COMPOSIO_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY", "VERCEL_TOKEN", "RAILWAY_TOKEN",
  "RAILWAY_DEPLOY_TOKEN", "SERPER_API_KEY", "PROJECTS_SUPABASE_KEY",
];

function assertSafePath(requestedPath) {
  const base = resolve(TASK_WORKDIR || process.cwd());
  const resolved = resolve(base, requestedPath);
  if (!resolved.startsWith(base + "/") && resolved !== base) {
    throw new Error("Path traversal blocked: " + requestedPath + " resolves outside sandbox");
  }
  return resolved;
}

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
    const cwd = assertSafePath(input.cwd || TASK_WORKDIR || ".");
    const safeEnv = { ...process.env };
    for (const key of STRIPPED_ENV_KEYS) delete safeEnv[key];
    const stdout = execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      shell: true,
      env: safeEnv,
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
    const safePath = assertSafePath(input.path);
    if (!existsSync(safePath)) return JSON.stringify({ error: "File not found: " + input.path });
    const content = readFileSync(safePath, "utf-8");
    return JSON.stringify({ content: content.slice(0, 20000), truncated: content.length > 20000 });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

function toolSandboxWriteFile(input) {
  try {
    const safePath = assertSafePath(input.path);
    const dir = dirname(safePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(safePath, input.content);
    return JSON.stringify({ success: true, path: input.path, bytes: input.content.length });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

function toolSandboxListFiles(input) {
  try {
    const dir = assertSafePath(input.path || TASK_WORKDIR || ".");
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

        // Disable SSO protection so the site is publicly accessible
        if (data.projectId) {
          try {
            await fetch("https://api.vercel.com/v9/projects/" + data.projectId, {
              method: "PATCH",
              headers: { Authorization: "Bearer " + VERCEL_TOKEN, "Content-Type": "application/json" },
              body: JSON.stringify({ ssoProtection: null }),
            });
          } catch (_) { /* non-fatal */ }
        }

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
      if (!existsSync(join(dir, "package.json"))) writeFileSync(join(dir, "package.json"), pkgJson);

      // Railway needs a repo. Check if we already pushed to GitHub for this task.
      // Use the Railway template deployment API with an image instead.
      // Simplest approach: deploy a Docker-based static site via Railway.
      const dockerfile = "FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm install\nCMD [\"npx\", \"serve\", \".\", \"-l\", \"$PORT\", \"-s\"]\n";
      if (!existsSync(join(dir, "Dockerfile"))) writeFileSync(join(dir, "Dockerfile"), dockerfile);

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

function compactMessages(messages) {
  if (messages.length <= 15) return;
  const keep = 8;
  const head = messages.slice(0, 1);
  const tail = messages.slice(-keep);
  const middle = messages.slice(1, -keep);

  const toolNames = [];
  const textSnippets = [];
  for (const m of middle) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "tool_use") toolNames.push(b.name);
        if (b.type === "tool_result") textSnippets.push((b.content || "").slice(0, 100));
      }
    } else if (typeof m.content === "string" && m.role === "assistant") {
      textSnippets.push(m.content.slice(0, 200));
    }
  }

  const summary = "[Previous work summary: " + middle.length + " messages compacted. " +
    "Tools used: " + [...new Set(toolNames)].join(", ") + ". " +
    "Key outputs: " + textSnippets.slice(0, 3).join("; ").slice(0, 500) + "]";

  messages.length = 0;
  messages.push(head[0]);
  messages.push({ role: "assistant", content: "Understood. Working on this." });
  messages.push({ role: "user", content: summary });
  messages.push({ role: "assistant", content: "Continuing from where I left off." });
  for (const m of tail) messages.push(m);
}

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
    const workSummary = "Completed " + turn + " steps. Tools used: " +
      [...new Set(allToolCalls.map(t => t.tool))].join(", ") + ". " +
      "Last actions: " + allToolCalls.slice(-3).map(t => t.tool + "(" + JSON.stringify(t.input).slice(0, 50) + ")").join(", ");

    const checkpoint = {
      messages: serializable,
      turn,
      tools_used: [...new Set(allToolCalls.map(t => t.tool))],
      work_summary: workSummary,
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

    // Check for cancellation every turn — user can hit "STOP ALL" at any time
    {
      const taskCheck = await sbGet("tasks", { id: "eq." + TASK_ID }, { select: "status", single: true });
      if (taskCheck?.status === "cancelled") {
        await log("Task cancelled by user — exiting", "task_cancelled");
        return { status: "cancelled", text: "Task was cancelled by user", toolCalls: allToolCalls, turns: turn };
      }
    }

    // Cost ceiling — auto-cancel if we've burned too much money on one task
    const costSoFar = estimatedCostUsd();
    if (costSoFar > MAX_TASK_COST_USD) {
      await log("Task hit cost ceiling ($" + costSoFar.toFixed(2) + " > $" + MAX_TASK_COST_USD + ") — auto-cancelling", "cost_ceiling_exceeded");
      // Mark task as cancelled in DB so retries/children don't restart it
      await sbPatch("tasks", {
        status: "cancelled",
        completed_at: new Date().toISOString(),
        error_message: "Cost ceiling exceeded ($" + costSoFar.toFixed(2) + " > $" + MAX_TASK_COST_USD + ")",
      }, { id: "eq." + TASK_ID });
      return { status: "cancelled", text: "Task hit cost ceiling of $" + MAX_TASK_COST_USD, toolCalls: allToolCalls, turns: turn };
    }

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

    // Log per-turn token usage
    if (response.usage) {
      const u = response.usage;
      await log("Tokens: " + (u.input_tokens || 0) + " in, " + (u.output_tokens || 0) + " out" +
        (u.cache_read_input_tokens ? ", " + u.cache_read_input_tokens + " cache-read" : ""), "token_usage");
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

      // Compact old messages every 5 turns to control context growth
      if (turn % 5 === 0) compactMessages(messages);

      // Post progress message to chat every 3 turns
      if (turn % 3 === 0 && CONVERSATION_ID) {
        const recentTools = allToolCalls.slice(-3).map(t => t.tool).join(", ");
        await sbInsert("chat_messages", {
          conversation_id: CONVERSATION_ID,
          role: "system",
          kind: "progress",
          content: "Working on it... (step " + turn + ", using: " + recentTools + ")",
          timestamp: new Date().toISOString(),
          metadata: { kind: "progress", progress: true, agent_slug: agentSlug, turn },
        }).catch(() => {}); // non-fatal
      }

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

// ── Quality review — REMOVED in Stage 3 ────────────────────────────────────
// The reviewResult / checkOutputUrls helpers were the engine of the invisible
// 3x-cost LLM-judge loop. They're gone. If we want URL health checks later,
// they belong in a tool the agent calls explicitly (test_url already does this),
// not a hidden post-task gate that retries up to 3 times.

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

  // Apply work-order cost cap if present (Stage 2: per-type budget enforcement)
  const woCost = task.metadata?.work_order?.estimated_cost_usd;
  if (typeof woCost === "number" && woCost > 0) {
    MAX_TASK_COST_USD = woCost;
    await log("Work order cost cap set to $" + MAX_TASK_COST_USD, "work_order_cost_cap");
  }
  // Apply work-order time budget if present
  const woMins = task.metadata?.work_order?.estimated_minutes;
  // (timeBudgetMs is set later — we'll honor woMins there)

  // 2. Load agent definition (default to orchestrator if none assigned).
  // Specialist agents run on Opus 4.7 by default — quality > cost for actual work.
  // DB value (agent_definitions.model) overrides this; this is just the fallback
  // when an agent has no row.
  let systemPrompt = "";
  let model = "claude-opus-4-7";
  let temperature = 0.7;
  const DEFAULT_TIME_BUDGET_MS = 5 * 60 * 1000; // 5 minutes
  let timeBudgetMs = DEFAULT_TIME_BUDGET_MS;
  agentDefId = null;

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
      // Work-order time cap takes precedence — predictable budgets per type
      if (typeof woMins === "number" && woMins > 0) {
        timeBudgetMs = woMins * 60 * 1000;
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

  // Build system prompt as cached blocks for prompt caching
  // Each block with cache_control gets cached by Anthropic (90% cost reduction on cache hits)
  const systemBlocks = [];
  const CACHE = { type: "ephemeral" };

  // Block 1: Base agent prompt (stable across tasks for same agent)
  systemBlocks.push({ type: "text", text: systemPrompt, cache_control: CACHE });

  // Block 2: Company context
  const company = await sbGet("companies", { id: "eq." + companyId }, { select: "name,brief", single: true });
  if (company?.brief) {
    const b = company.brief;
    const parts = [];
    if (b.what_we_do) parts.push("Business: " + b.what_we_do);
    if (b.stage) parts.push("Stage: " + b.stage);
    if (b.target_customers) parts.push("Customers: " + b.target_customers);
    if (b.tone_of_voice) parts.push("Tone: " + b.tone_of_voice);
    if (b.context_notes) parts.push("Notes: " + b.context_notes);
    if (parts.length) {
      systemBlocks.push({ type: "text", text: "\n\n## Company Context (" + company.name + ")\n" + parts.join("\n"), cache_control: CACHE });
    }
  }

  // Block 3: Active goals — framed as mission, not just data
  const goals = await sbGet("company_goals", {
    company_id: "eq." + companyId, status: "eq.active",
  }, { order: "priority.asc" });
  if (goals?.length) {
    const lines = goals.map((g, i) =>
      (i + 1) + ". " + g.title +
      (g.target_metric ? " — Progress: " + (g.current_value ?? 0) + "/" + (g.target_value ?? "?") + " " + g.target_metric : "") +
      (g.timeframe ? " — Deadline: " + g.timeframe : "")
    );
    systemBlocks.push({ type: "text", text: "\n\n## Your Mission\n" +
      "Everything you do should ladder up to these company goals:\n" + lines.join("\n") + "\n\n" +
      "When you complete work, use `update_goal_progress` if your work moved a goal metric forward. " +
      "When you store a memory, note which goal it relates to if applicable.",
      cache_control: CACHE });
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

  // Block 4: Composio integrations
  if (composioApps.length > 0) {
    systemBlocks.push({ type: "text", text: "\n\n## External Integrations (via Composio)\n" +
      "You have access to these external services. Use composio_find_actions(app_name, use_case) to discover available operations, then composio_execute(action_id, params) to run them.\n" +
      "Your allowed apps: " + composioApps.join(", ") + "\n" +
      "Workflow: 1) composio_find_actions → 2) composio_execute. Always discover actions first — do NOT guess action IDs.\n" +
      "Only use apps listed above — do not attempt to use apps outside your role.",
      cache_control: CACHE });
  }

  // Block 5: Skills
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
        let skillText = "\n\n## Installed Skills\nFollow these skill instructions carefully:\n";
        for (const skill of skills) {
          skillText += "\n### " + skill.name + "\n" + skill.content + "\n";
        }
        systemBlocks.push({ type: "text", text: skillText, cache_control: CACHE });
        await log("Loaded " + skills.length + " skill(s): " + skills.map(s => s.name).join(", "), "skills_loaded");
      }
    }
  }

  // Block 6: Operational rules (no cache_control — varies per task context)
  let operationalRules = "\n\n## How You Work\n" +
    "You are a professional. You do the work, you test the work, you deliver the work.\n\n" +
    "Before you declare anything done, verify it yourself. If you deployed a site, use test_url to check it actually loads. " +
    "If you created a document, make sure it has real content. If you did research, make sure your report contains actual data and sources, not suggestions.\n\n" +
    "If something goes wrong, fix it. Try a different approach. Professionals don't give up on the first error — they find another way. " +
    "If an external service is down, work around it.\n\n" +
    "The only thing that matters is the output: a link the user can click, a document they can read, data they can act on. " +
    "Everything else is just process. Never describe what you would do — do it.\n\n" +
    "## Memory\n" +
    "You have persistent memory across tasks. Use `recall_memories` to check what you or your teammates already know before starting work. " +
    "After completing significant work, store key findings, decisions, and learnings using `store_memory` — your future self and teammates will use them. " +
    "Scopes: mine (default, your own memories), team (all agents), agent:<slug> (specific teammate).";

  if (agentSlug === "orchestrator") {
    operationalRules +=
      "\n\n## Cross-task awareness — you ARE the team lead\n" +
      "When a specialist completes a task, the deliverable lives in `task_results`. " +
      "Use `read_agent_output({task_id})` to fetch a specific task's output, or " +
      "`read_agent_output({agent_slug: \"research\"})` for the most-recent completed task by that agent. " +
      "NEVER tell Sal you can't see a result — look it up first. " +
      "If Sal asks 'what did research find?', call `read_agent_output({agent_slug: \"research\"})` and summarise.\n\n" +
      "Use `message_agent({target_agent, message, urgency})` to leave context for another agent's next run — " +
      "lighter than `delegate_task`, useful for FYIs and small handoffs. The message arrives as a memory the target sees on its next task.\n\n" +
      "Use `update_goal_progress({goal_title, new_value, note})` when concrete work moves a company goal's metric.\n\n" +
      "## Iterating the team — `update_agent` / `revert_agent`\n" +
      "You're allowed to improve other agents over time. When you notice a *pattern* — research keeps " +
      "skipping citations, growth doesn't tag campaigns properly, designer ignores the brand colour palette — " +
      "you can update that agent's system_prompt or model directly with `update_agent({agent_slug, system_prompt|model|description, reason})`.\n\n" +
      "Rules of thumb:\n" +
      "- ONE-OFF mistakes are NOT a reason to mutate a prompt. The signal must be a pattern across 2+ tasks, or a glaring oversight in the existing prompt.\n" +
      "- ALWAYS pass `dry_run: true` first to see the diff, unless the change is trivial (e.g. fixing a typo).\n" +
      "- ALWAYS write a `reason` that makes the next reader (Sal, future you) understand WHY. \"Improving prompt\" is not a reason. \"Research kept ignoring competitor pricing — added explicit instruction to extract pricing in dollars\" is a reason.\n" +
      "- Only agents with `is_safe_auto_modify=true` are mutable. The tool will reject otherwise. Do not nag Sal to opt agents in — he'll do it when he's ready.\n" +
      "- You CANNOT modify yourself. The orchestrator's identity is fixed by Sal.\n" +
      "- If a change you made doesn't help — or makes things worse — call `revert_agent({agent_slug, reason})` to roll it back. Every change is logged in `agent_definition_versions`; nothing is destroyed.\n" +
      "- After a meaningful change, store a memory describing what you tried and why, so you can iterate later instead of repeating yourself.\n\n" +
      "If a tool you expect to have is missing, that's a bug to flag — do not invent workarounds that fake the answer.";
  }

  if (agentSlug === "engineering") {
    // Prepend engineering identity to the first block
    systemBlocks[0] = { type: "text", text: "You are the Engineering Agent. You build things and deliver working products.\n\n" + systemBlocks[0].text, cache_control: CACHE };

    operationalRules +=
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
      operationalRules += "\n\n## ACTIVE PROJECT EDIT MODE\n" +
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

  systemBlocks.push({ type: "text", text: operationalRules });

  // 6. Select tools for this agent
  let tools;
  if (agentSlug === "orchestrator") {
    const ORCHESTRATOR_ONLY = [
      "delegate_task", "create_task",
      "store_memory", "recall_memories",
      "database_query", "test_url", "fail_task",
      // Cross-task awareness: orchestrator must be able to read what specialists delivered
      // and pass messages between agents. Without these, every follow-up question forces
      // the user to re-paste content the system already has.
      "read_agent_output", "message_agent", "update_goal_progress",
      // Self-modification: orchestrator can iterate other agents' prompts/models when it
      // spots a recurring problem. Gated by agent_definitions.is_safe_auto_modify (opt-in)
      // and protected by the version log so any change is one click away from rollback.
      "update_agent", "revert_agent",
    ];
    tools = BASE_TOOLS.filter(t => ORCHESTRATOR_ONLY.includes(t.name));
    tools.push(MANAGE_INTEGRATIONS_TOOL);
  } else {
    tools = [...BASE_TOOLS];
    if (agentSlug === "engineering") tools.push(...ENGINEERING_TOOLS);
    if (agentSlug === "designer") tools.push(...DESIGNER_TOOLS);
    if (composioApps.length > 0) tools.push(...COMPOSIO_TOOLS);
  }

  // 6b. WORK ORDER TOOL LOCKDOWN
  // If this task carries a work_order, restrict tools to the type's allowlist.
  // This is the critical constraint: a build_static_site work order CANNOT
  // randomly call Apollo or send emails. Engineering can't pick from 22 tools.
  // Two layers:
  //   - Tool-name allowlist (which built-in tools)
  //   - Vendor allowlist (which API Center integrations call_integration may dispatch to)
  const WORK_ORDER_TOOL_ALLOWLIST = {
    research: new Set([
      "web_search", "test_url", "store_memory", "recall_memories", "fail_task", "fetch_url",
      "call_integration",
    ]),
    build_static_site: new Set([
      "test_url", "store_memory", "recall_memories", "fail_task",
      "github_create_repo", "github_push_file",
      "sandbox_bash", "sandbox_read_file", "sandbox_write_file", "sandbox_list_files",
      "deploy_static_site", "register_project",
      "call_integration",
    ]),
    edit_project: new Set([
      "test_url", "store_memory", "recall_memories", "fail_task",
      "github_push_file",
      "sandbox_bash", "sandbox_read_file", "sandbox_write_file", "sandbox_list_files",
      "deploy_static_site", "project_query",
      "call_integration",
    ]),
    send_outreach: new Set([
      "test_url", "store_memory", "recall_memories", "fail_task",
      "composio_find_actions", "composio_execute",
      "call_integration",
    ]),
    design_mockup: new Set([
      "test_url", "store_memory", "recall_memories", "fail_task",
      "design_system_search",
      "sandbox_write_file", "sandbox_read_file",
      "github_create_repo", "github_push_file",
      "deploy_static_site",
      "call_integration",
    ]),
    meeting_admin: new Set([
      "test_url", "store_memory", "recall_memories", "fail_task",
      "composio_find_actions", "composio_execute",
      "call_integration",
    ]),
    // Summary: read-only state gathering. Used by scheduled briefings.
    // No delegation, no external API calls — just query, recall, write the
    // recap, store any new memories worth remembering.
    summary: new Set([
      "database_query", "store_memory", "recall_memories", "fail_task",
    ]),
  };

  // Vendor allowlist per work-order type. call_integration enforces this at
  // execution time too, but limiting in the prompt helps the model not even try.
  const WORK_ORDER_VENDOR_ALLOWLIST = {
    // Research can persist findings to docs/sheets/notion (read-write, scoped to company workspace).
    // No money-moving or messaging — those stay locked out for this work order type.
    research: new Set(["openai", "anthropic", "exa", "serper", "googledocs", "googlesheets", "notion"]),
    build_static_site: new Set(["github", "openai", "anthropic"]),
    edit_project: new Set(["github", "openai", "anthropic"]),
    send_outreach: new Set(["resend", "openai", "anthropic"]),
    design_mockup: new Set(["openai", "anthropic", "googledocs", "notion"]),
    meeting_admin: new Set(["openai", "anthropic", "googledocs", "googlesheets", "notion"]),
  };

  const workOrder = task.metadata?.work_order;
  if (workOrder?.type && WORK_ORDER_TOOL_ALLOWLIST[workOrder.type]) {
    const allow = WORK_ORDER_TOOL_ALLOWLIST[workOrder.type];
    const before = tools.length;
    tools = tools.filter(t => allow.has(t.name));
    _workOrderVendorAllow = WORK_ORDER_VENDOR_ALLOWLIST[workOrder.type] || new Set();
    await log(
      "Work order '" + workOrder.type + "' locked tools: " + before + " -> " + tools.length +
      " (" + tools.map(t => t.name).join(", ") + ") | integration vendors allowed: " +
      [..._workOrderVendorAllow].join(", "),
      "work_order_tools_locked"
    );
  }

  // 6c. Load API Center integrations for this company. Filter by the
  // work-order's vendor allowlist so the agent only sees what it can use.
  if (companyId) {
    const allRows = await loadActiveIntegrations(companyId);
    if (workOrder?.type && _workOrderVendorAllow) {
      _activeIntegrations = allRows.filter(i => _workOrderVendorAllow.has(i.vendor));
    } else {
      _activeIntegrations = allRows;
    }
    if (_activeIntegrations.length > 0) {
      await log(
        "Loaded " + _activeIntegrations.length + " active integration(s): " +
        _activeIntegrations.map(i => i.vendor).join(", "),
        "integrations_loaded"
      );
      // Inject the integration catalog into the system prompt so the agent
      // knows what call_integration() can dispatch to and with what params.
      let intBlock = "\n\n## Available Integrations\n" +
        "Use `call_integration({ vendor, action, params })` to invoke these. " +
        "Pass params matching the action's input_schema below — strings as strings, arrays as arrays.\n";
      for (const i of _activeIntegrations) {
        intBlock += "\n### " + (i.display_name || i.vendor) + "  (vendor: `" + i.vendor + "`)\n";
        for (const a of (i.actions || [])) {
          intBlock += "- **" + a.name + "** — " + a.description + "\n";
          intBlock += "  - method: `" + a.method + "`, path: `" + a.path + "`\n";
          const props = a.input_schema?.properties || {};
          const required = a.input_schema?.required || [];
          intBlock += "  - params: ";
          intBlock += Object.entries(props).map(([pname, pspec]) => {
            const star = required.includes(pname) ? "*" : "";
            return "`" + pname + star + ": " + pspec.type + "`";
          }).join(", ") + "\n";
        }
      }
      intBlock += "\n*denotes required. If a vendor or action you need isn't here, ask Sal to connect it via the API Center.*";
      systemBlocks.push({ type: "text", text: intBlock });
    }
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

  // 8. Inject relevant memories
  const allMemoryLines = [];

  // 8a. Agent's own recent high-importance memories (always loaded, regardless of task keywords)
  if (agentDefId) {
    const ownMemParams = new URLSearchParams({
      select: "content,category,metadata", order: "importance.desc,created_at.desc", limit: "5",
      agent_definition_id: "eq." + agentDefId,
      category: "neq.agent_message",
      or: "(expires_at.is.null,expires_at.gt." + new Date().toISOString() + ")",
    });
    if (companyId) ownMemParams.set("company_id", "eq." + companyId);
    const ownMemR = await fetch(SUPABASE_URL + "/rest/v1/memories?" + ownMemParams, { headers: SB_HEADERS }).catch(() => null);
    if (ownMemR?.ok) {
      const ownMems = await ownMemR.json();
      for (const m of ownMems) {
        allMemoryLines.push("- [" + m.category + "] " + m.content + " (your own memory)");
      }
    }
  }

  // 8b. Task-relevant memories (full-text search across all company memories)
  const keywords = instruction.split(/\s+/).filter(w => w.length > 3).map(w => w.replace(/[^a-zA-Z0-9]/g, "")).filter(Boolean).slice(0, 8);
  if (keywords.length > 0) {
    const ftsQuery = keywords.join(" or ");
    const memParams = new URLSearchParams({
      select: "content,category,metadata", order: "importance.desc", limit: "8",
      fts: "websearch." + ftsQuery,
      category: "neq.agent_message",
      or: "(expires_at.is.null,expires_at.gt." + new Date().toISOString() + ")",
    });
    if (companyId) memParams.set("company_id", "eq." + companyId);
    const memR = await fetch(SUPABASE_URL + "/rest/v1/memories?" + memParams, { headers: SB_HEADERS }).catch(() => null);
    if (memR?.ok) {
      const mems = await memR.json();
      for (const m of mems) {
        const src = m.metadata?.agent_slug ? " (via " + m.metadata.agent_slug + ")" : "";
        const line = "- [" + m.category + "] " + m.content + src;
        if (!allMemoryLines.includes(line)) allMemoryLines.push(line);
      }
    }
  }

  // 8c. Inter-agent messages targeted at this agent
  if (agentDefId) {
    const msgParams = new URLSearchParams({
      select: "content,metadata,created_at", order: "created_at.desc", limit: "5",
      category: "eq.agent_message",
      or: "(expires_at.is.null,expires_at.gt." + new Date().toISOString() + ")",
    });
    if (companyId) msgParams.set("company_id", "eq." + companyId);
    // Filter messages targeted at this agent via metadata
    msgParams.set("metadata->>target_agent", "eq." + agentSlug);
    const msgR = await fetch(SUPABASE_URL + "/rest/v1/memories?" + msgParams, { headers: SB_HEADERS }).catch(() => null);
    if (msgR?.ok) {
      const msgs = await msgR.json();
      if (msgs.length > 0) {
        allMemoryLines.push("");
        allMemoryLines.push("**Messages from other agents:**");
        for (const m of msgs) {
          const from = m.metadata?.from || "unknown";
          const urgency = m.metadata?.urgency || "fyi";
          allMemoryLines.push("- [from " + from + ", " + urgency + "] " + m.content);
        }
      }
    }
  }

  if (allMemoryLines.length > 0) {
    systemBlocks.push({ type: "text", text: "\n\n## Relevant Memories\n" + allMemoryLines.join("\n") });
  }

  // 8d. Role-specific context — load memories/data tailored to this agent's role
  const roleContextLines = [];
  if (companyId && agentSlug !== "orchestrator") {
    const roleCategoryMap = {
      growth: ["campaign", "outreach", "sales", "pipeline", "lead", "contact", "pricing"],
      research: ["research", "analysis", "competitive-intel", "market", "trend"],
      engineering: ["project", "deployment", "architecture", "bug", "technical"],
      "executive-assistant": ["meeting", "email", "calendar", "scheduling", "client"],
      designer: ["design", "brand", "ui", "ux", "mockup"],
    };
    const roleCategories = roleCategoryMap[agentSlug] || [];
    if (roleCategories.length > 0) {
      // Fetch memories with tags/categories matching this agent's domain
      const tagFilter = roleCategories.map(c => "category.eq." + c).join(",");
      const roleMemParams = new URLSearchParams({
        select: "content,category,metadata", order: "importance.desc,created_at.desc", limit: "8",
        or: "(" + tagFilter + ")",
        category: "neq.agent_message",
      });
      roleMemParams.set("company_id", "eq." + companyId);
      roleMemParams.set("or", "(" + roleCategories.map(c => "category.eq." + c).join(",")
        + "," + roleCategories.map(t => "tags.cs.[\"" + t + "\"]").join(",") + ")");
      const roleMemR = await fetch(SUPABASE_URL + "/rest/v1/memories?" + roleMemParams, { headers: SB_HEADERS }).catch(() => null);
      if (roleMemR?.ok) {
        const roleMems = await roleMemR.json();
        for (const m of roleMems) {
          const line = "- [" + m.category + "] " + m.content;
          if (!allMemoryLines.includes(line)) roleContextLines.push(line);
        }
      }
    }
  }
  if (roleContextLines.length > 0) {
    systemBlocks.push({ type: "text", text: "\n\n## Domain Context (for your role)\n" + roleContextLines.join("\n") });
  }

  // 8e. Training examples — load high-quality examples so the agent learns from past successes
  if (agentDefId) {
    const trainingExamples = await sbGet("training_examples", {
      agent_definition_id: "eq." + agentDefId,
      is_active: "eq.true",
    }, { order: "quality_score.desc", limit: 3 });
    if (trainingExamples?.length) {
      let examplesText = "\n\n## Examples of Good Work\nLearn from these high-quality past interactions:\n";
      for (const ex of trainingExamples) {
        examplesText += "\n**User asked:** " + (ex.user_message.length > 200 ? ex.user_message.slice(0, 200) + "..." : ex.user_message) +
          "\n**You delivered:** " + (ex.assistant_response.length > 300 ? ex.assistant_response.slice(0, 300) + "..." : ex.assistant_response) +
          "\n**Quality:** " + ex.quality_score + "/10\n";
      }
      systemBlocks.push({ type: "text", text: examplesText, cache_control: CACHE });
      await log("Loaded " + trainingExamples.length + " training example(s)", "training_loaded");
    }
  }

  // 8f. Team status — what are other agents currently working on?
  if (companyId) {
    const runningTasks = await sbGet("tasks", {
      company_id: "eq." + companyId,
      status: "in.(running,pending)",
    }, { select: "title,status,started_at,agent_definition_id", order: "started_at.desc", limit: 10 });

    const recentCompletedTasks = await sbGet("tasks", {
      company_id: "eq." + companyId,
      status: "eq.completed",
    }, { select: "title,status,completed_at,agent_definition_id", order: "completed_at.desc", limit: 5 });

    // Get agent name mappings
    const allAgentDefs = await sbGet("agent_definitions", {
      company_id: "eq." + companyId,
    }, { select: "id,slug,name" });
    const agentIdToName = {};
    for (const a of (allAgentDefs || [])) agentIdToName[a.id] = a.name || a.slug;

    const teamLines = [];
    for (const t of (runningTasks || [])) {
      if (t.agent_definition_id === agentDefId) continue; // skip self
      const name = agentIdToName[t.agent_definition_id] || "Unknown";
      const elapsed = t.started_at ? Math.round((Date.now() - new Date(t.started_at).getTime()) / 60000) + " min" : "";
      teamLines.push("- **" + name + "**: " + t.title + " (" + t.status + (elapsed ? ", " + elapsed : "") + ")");
    }
    for (const t of (recentCompletedTasks || [])) {
      if (t.agent_definition_id === agentDefId) continue; // skip self
      const name = agentIdToName[t.agent_definition_id] || "Unknown";
      const ago = t.completed_at ? Math.round((Date.now() - new Date(t.completed_at).getTime()) / 60000) : 0;
      const agoStr = ago < 60 ? ago + " min ago" : Math.round(ago / 60) + "h ago";
      teamLines.push("- **" + name + "**: " + t.title + " (completed " + agoStr + ")");
    }

    if (teamLines.length > 0) {
      systemBlocks.push({ type: "text", text: "\n\n## Team Status\nWhat your teammates are working on:\n" + teamLines.join("\n") });
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

    // Inject resume context so the agent knows what it already did
    if (checkpoint.work_summary) {
      messages.push({
        role: "user",
        content: "[SYSTEM] You are resuming from a checkpoint. Previous work summary: " + checkpoint.work_summary + ". Continue from where you left off.",
      });
    }

    existingToolCalls = (checkpoint.tools_used || []).map(t => ({ tool: t, input: {}, output: "(from checkpoint)", source: "checkpoint" }));
  }

  await log("Starting agentic loop — " + tools.length + " tools, " + Math.round(timeBudgetMs / 1000) + "s time budget", "loop_start");

  // 10. Run the loop (pass systemBlocks for prompt caching)
  const result = await runLoop(model, systemBlocks, messages, tools, timeBudgetMs, temperature, existingToolCalls);

  await log("Loop finished: " + result.status + " in " + result.turns + " turn(s), " + result.toolCalls.length + " tool call(s)");

  // 10. Determine initial status
  const isDelegated = task.source === "agent" && task.parent_task_id;
  let finalText = result.text;
  let finalToolCalls = result.toolCalls;

  // Handle cancellation — skip review and all post-processing
  if (result.status === "cancelled") {
    await sbPatch("tasks", {
      status: "cancelled",
      completed_at: new Date().toISOString(),
    }, { id: "eq." + TASK_ID });
    await sbInsert("chat_messages", {
      conversation_id: CONVERSATION_ID,
      role: "system",
      kind: "work_order_status",
      content: "Task was cancelled.",
      timestamp: new Date().toISOString(),
      metadata: {
        kind: "work_order_status",
        status: "cancelled",
        agent_slug: agentSlug,
        task_id: TASK_ID,
      },
    });
    await log("Task cancelled — exiting cleanly", "task_cancelled");
    return;
  }

  const isTimeoutString = result.text.startsWith("Time budget expired") || result.text.startsWith("Hit safety cap");
  const hasRealOutput = result.status === "completed" && !isTimeoutString;
  const didWorkButTimedOut = result.status === "time_expired" && result.toolCalls.length > 2 && !isTimeoutString;

  let finalStatus = (hasRealOutput || didWorkButTimedOut) ? "completed" : "failed";
  let failReason = null;

  if (finalStatus === "failed" && result.status === "time_expired") {
    failReason = "Time budget expired without producing output";
  } else if (finalStatus === "failed") {
    failReason = finalText.slice(0, 500);
  }

  // 11. (Removed in Stage 3) Invisible LLM-judge review loop with up to 3
  // revision cycles. It was a hidden 3x cost multiplier with no user benefit
  // — review failures were retried automatically, so users couldn't tell that
  // their "completed" task was actually 3 attempts. If we want quality gates
  // later they go where they belong: opt-in per work-order type, with
  // cost+turn count visible to the user.

  // 12. Extract deliverables from the latest result (post-revision if applicable)
  const deliverables = extractDeliverables(finalToolCalls || []);
  if (deliverables.length > 0) {
    await log("Deliverables: " + deliverables.map(d => d.type + (d.url ? " " + d.url : "")).join(", "), "deliverables");
  }

  // Build a status message. If this task came from a work order, tag it with
  // kind=work_order_status so the UI renders it as a clean completion card.
  const isWorkOrder = !!task.metadata?.work_order;
  const cost = (typeof estimatedCostUsd === "function") ? estimatedCostUsd() : 0;
  const elapsedMin = task.started_at
    ? Math.round((Date.now() - new Date(task.started_at).getTime()) / 60000)
    : null;

  if (!isDelegated) {
    await sbInsert("chat_messages", {
      conversation_id: CONVERSATION_ID,
      role: isWorkOrder ? "system" : "orchestrator",
      kind: isWorkOrder ? "work_order_status" : "reply",
      content: finalText,
      timestamp: new Date().toISOString(),
      metadata: isWorkOrder
        ? {
            kind: "work_order_status",
            status: finalStatus,
            task_id: TASK_ID,
            work_order_type: task.metadata.work_order.type,
            agent_slug: agentSlug,
            cost_usd: Number(cost.toFixed(4)),
            duration_min: elapsedMin,
            tools_used: [...new Set(finalToolCalls.map(t => t.tool))],
            deliverables: deliverables.length > 0 ? deliverables : undefined,
          }
        : {
            kind: "reply",
            model, turns: result.turns,
            tools_used: [...new Set(finalToolCalls.map(t => t.tool))],
            agent_slug: agentSlug,
            deliverables: deliverables.length > 0 ? deliverables : undefined,
          },
    });
  } else if (task.source !== "internal" && CONVERSATION_ID) {
    // Delegated task finished — post a compact notification card to chat so Sal sees it
    // without having to navigate to Outputs. Internal/background tasks (proactive planner,
    // digest, etc.) are suppressed to avoid chat spam.
    const notificationContent = finalStatus === "completed"
      ? formatNotification(agentSlug, task.title, finalText, deliverables)
      : finalText;

    await sbInsert("chat_messages", {
      conversation_id: CONVERSATION_ID,
      role: "system",
      kind: "notification",
      content: notificationContent,
      timestamp: new Date().toISOString(),
      metadata: {
        kind: "notification",
        notification: finalStatus === "completed",
        // The chat renderer keys off event_type — without it the message silently drops.
        event_type: finalStatus === "completed" ? "task_completed" : "task_failed",
        completed_task_id: TASK_ID,
        agent_slug: agentSlug,
        duration_min: elapsedMin || undefined,
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
      token_usage: tokenUsage,
      ...(finalStatus === "failed" ? { failed: true } : {}),
    },
  });

  await log("Results written. Task " + finalStatus + ". Tokens: " + tokenUsage.input_tokens + " in / " + tokenUsage.output_tokens + " out / " + tokenUsage.cache_read_input_tokens + " cache-read / " + tokenUsage.api_calls + " API calls", "task_" + (finalStatus === "completed" ? "complete" : "failed"));

  // 12a. (Removed in Stage 3) Auto-extract memories using Haiku post-task.
  // Hidden ~$0.002/task, but added latency and weird false-positive memories.
  // Agents can use store_memory explicitly during a run if there's something
  // worth remembering. Manual is fine; auto was noise.

  // 12b. (Removed) Duplicate notification block \u2014 the else-branch above (line ~2864)
  // already inserts a notification for delegated tasks with the correct event_type.
  // Keeping two blocks meant Sal got the same completion message twice in chat.

  // 12c. Child tasks are already inserted as 'pending' by delegate_task.
  if (childTasks.length > 0) {
    await log(childTasks.length + " child task(s) queued for pickup: " +
      childTasks.map(c => c.taskId.slice(0, 8)).join(", "));
  }

  // 13. (Removed in Stage 3) Auto-retry of failed tasks. The "Task failed —
  // automatically retrying" loop spawned a fresh runner with a modified prompt,
  // burning credits on the same wrong approach. If a task fails, it stays
  // failed; the user can read the error and re-propose explicitly.

  // 14. (Removed in Stage 3) Agent handoff chains via metadata.handoff.next_agent.
  // Multi-agent chains spawn fresh runner processes with no shared state and
  // unbounded cost compounding. If a workflow needs two agents, that's two
  // work orders and two approvals.

  await log("Runner complete. Exiting.");
}

// ── Entry point ─────────────────────────────────────────────────────────────

main().catch(async (err) => {
  const msg = (err.message || String(err)).slice(0, 1000);
  const stack = (err.stack || "").slice(0, 1500);
  await log("FATAL: " + msg, "error");

  await sbPatch("tasks", {
    status: "failed",
    error_message: msg,
    completed_at: new Date().toISOString(),
  }, { id: "eq." + TASK_ID });

  // Surface the REAL error so we can see what broke. No more "Something went wrong".
  // UI renders kind=error distinctively.
  await sbInsert("chat_messages", {
    conversation_id: CONVERSATION_ID,
    role: "system",
    kind: "error",
    content: "Task failed: " + msg,
    timestamp: new Date().toISOString(),
    metadata: {
      kind: "error",
      source: "runner",
      task_id: TASK_ID,
      agent_slug: agentSlug,
      original_error: msg,
      stack: stack,
    },
  });

  process.exit(1);
});
