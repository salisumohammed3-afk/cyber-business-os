import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 60;

// Markers the orchestrator emits to trigger structured cards in chat:
//   [PROPOSE_WORK_ORDER]   -> one-off work-order proposal (Stage 2)
//   [PROPOSE_INTEGRATION]  -> integration setup card (API Center Phase 2)
//   [PROPOSE_SCHEDULE]     -> recurring policy proposal (Stage 5)
const WORK_ORDER_MARKER = "[PROPOSE_WORK_ORDER]";
const INTEGRATION_MARKER = "[PROPOSE_INTEGRATION]";
const SCHEDULE_MARKER = "[PROPOSE_SCHEDULE]";

// Generic marker-then-JSON extractor. Handles multi-line JSON, single-line JSON,
// JSON wrapped in code fences. Used for both work orders and integrations.
function extractJsonAfterAnyMarker(
  text: string,
  marker: string
): { preamble: string; rawJson: string } | null {
  const idx = text.indexOf(marker);
  if (idx < 0) return null;
  const preamble = text.slice(0, idx).trim();
  const after = text.slice(idx + marker.length);
  const firstBrace = after.indexOf("{");
  if (firstBrace < 0) return null;
  const lastBrace = after.lastIndexOf("}");
  if (lastBrace <= firstBrace) return null;
  const rawJson = after.slice(firstBrace, lastBrace + 1);
  return { preamble, rawJson };
}

function extractJsonAfterMarker(text: string) {
  return extractJsonAfterAnyMarker(text, WORK_ORDER_MARKER);
}

function extractIntegrationProposal(text: string) {
  return extractJsonAfterAnyMarker(text, INTEGRATION_MARKER);
}

function extractScheduleProposal(text: string) {
  return extractJsonAfterAnyMarker(text, SCHEDULE_MARKER);
}

// In-memory rate limiter (resets on cold start / redeploy)
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10;

// Tool-use loop cap — chat mode should answer quickly, not do a research project
const MAX_TOOL_TURNS = 3;

// ── Work order types (shared with runner via task.metadata.work_order.type) ─

const WORK_ORDER_TYPES = [
  "research",
  "build_static_site",
  "edit_project",
  "send_outreach",
  "design_mockup",
  "meeting_admin",
  "summary",
] as const;

type WorkOrderType = (typeof WORK_ORDER_TYPES)[number];

const AGENT_FOR_TYPE: Record<WorkOrderType, string> = {
  research: "research",
  build_static_site: "engineering",
  edit_project: "engineering",
  send_outreach: "growth",
  design_mockup: "designer",
  meeting_admin: "executive-assistant",
  summary: "orchestrator",
};

// Default cost/time caps. Stage 3 moves these to the runner registry.
const COST_CAP_USD: Record<WorkOrderType, number> = {
  research: 0.5,
  build_static_site: 2.0,
  edit_project: 1.5,
  send_outreach: 0.5,
  design_mockup: 1.0,
  meeting_admin: 0.3,
  summary: 0.2,
};

const TIME_CAP_MIN: Record<WorkOrderType, number> = {
  research: 5,
  build_static_site: 15,
  edit_project: 10,
  send_outreach: 5,
  design_mockup: 10,
  meeting_admin: 5,
  summary: 3,
};

const OUTPUT_TARGET: Record<WorkOrderType, string> = {
  research: "memo",
  build_static_site: "project",
  edit_project: "project",
  send_outreach: "email_draft",
  design_mockup: "mockup_file",
  meeting_admin: "calendar_event",
  summary: "memo",
};

// Tools each work order type requires for preflight checks.
// "native" sources check the integrations table (API Center).
// "composio" sources check Composio's connectedAccounts API.
type IntegrationSource = "native" | "composio";

const REQUIRED_INTEGRATIONS: Record<
  WorkOrderType,
  Array<{ vendor: string; source: IntegrationSource }>
> = {
  research: [],
  build_static_site: [{ vendor: "github", source: "native" }],
  edit_project: [{ vendor: "github", source: "native" }],
  send_outreach: [{ vendor: "gmail", source: "composio" }],
  design_mockup: [],
  meeting_admin: [{ vendor: "googlecalendar", source: "composio" }],
  summary: [],
};

interface WorkOrderProposal {
  type: WorkOrderType;
  agent: string;
  title: string;
  description: string;
  estimated_cost_usd: number;
  estimated_minutes: number;
  output_target: string;
  preflight: { tool: string; status: "ready" | "missing" | "unknown"; note?: string }[];
}

function checkRateLimit(companyId: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(companyId) || [];
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
  if (recent.length >= RATE_LIMIT_MAX) return false;
  recent.push(now);
  rateLimitMap.set(companyId, recent);
  return true;
}

const ROUTING_ADDENDUM = `

## How to respond

You're Sal's AI colleague. Talk naturally like a smart teammate.

**Default: answer in this message.** You have tools to read state (\`fetch_url\`, \`query_state\`) AND to do trivial admin (\`cancel_tasks\`, \`manage_schedule\`, \`store_memory\`). Only propose a work order when the request genuinely needs minutes of agent execution and tools you don't have access to in chat.

**Answer directly** for:
- Questions, opinions, ideas, status checks, clarifications, pushback
- Quick reviews of a URL — use \`fetch_url\` and reply
- Looking up tasks / memories / goals / schedules — use \`query_state\`
- Summaries, recaps, brainstorms — your own knowledge is enough
- Anything conversational

**Just do it** (no work order, no approval card) for trivial admin Sal asks for in chat:
- "Clear the list" / "cancel those proposals" / "kill what's running" → \`cancel_tasks\` with the right status filter. If unclear which list, default to status="proposed" (un-approved drafts) and tell him what you cancelled.
- "Pause the daily briefing" / "stop that schedule" / "delete the morning recap" → \`manage_schedule\` with action=pause/resume/delete and either schedule_id or a name_match substring.
- "Remember that..." / "note that..." / "we now use X" → \`store_memory\` with the fact in your own words. Pick a sensible category from the enum.

Don't ask for confirmation on these admin actions unless the operation is genuinely destructive and irreversible (e.g. deleting many things at once). For "clear my proposed task list" — just do it and report back the count + titles.

**Propose a work order** when the user clearly wants something done that needs:
- Building or editing a deployed website / app (engineering)
- Deep research with multiple scraping rounds and a written report (research)
- Sending email outreach or running a campaign (growth)
- Creating a UI mockup or design spec (designer)
- Calendar / Monday / email management actions (executive-assistant)

**Format for work order proposals — NOTHING else.** Output a one-line acknowledgment, then on a new line the literal marker \`[PROPOSE_WORK_ORDER]\`, then a JSON object on the following lines:

\`\`\`
Got it — I'll set this up for your approval.
[PROPOSE_WORK_ORDER]
{
  "type": "research" | "build_static_site" | "edit_project" | "send_outreach" | "design_mockup" | "meeting_admin",
  "title": "Short imperative title (under 60 chars)",
  "description": "Specifically what the agent will do, step by step. Be concrete."
}
\`\`\`

Pick the SINGLE best type. The system fills in agent, cost estimate, time estimate, and output target from the type. Sal will see a card and click Approve before anything runs. Don't propose multiple at once — pick the most important and propose it. Sal can ask for more.

If the request is ambiguous, just ask Sal what he means — don't guess and propose.

## Adding integrations (API Center)

If Sal asks to "add", "connect", "hook up", or "set up" an external service (OpenAI/ChatGPT, GitHub, Resend, Apollo, Anthropic, Serper, Exa — anything in the known-vendors list), DO NOT propose a work order. Instead, propose an integration setup. Output a one-line acknowledgment, then \`[PROPOSE_INTEGRATION]\`, then JSON:

\`\`\`
Sure — let's get OpenAI connected. Paste your API key and I'll wire it up.
[PROPOSE_INTEGRATION]
{
  "vendor": "openai"
}
\`\`\`

The system looks up the vendor in the registry, fills in the form fields (which credentials are needed, where to get them, what the test endpoint is), and shows Sal a card. Sal pastes the key, the system saves it encrypted, runs a connection test, and confirms. **Pick exactly one vendor per proposal.** Known vendors: openai, anthropic, github, resend, serper, exa.

If Sal asks for a vendor that's NOT in this list (e.g., Twilio, Klaviyo), don't propose — say you can't add it via the API Center yet and tell him a custom integration needs a code change. Don't pretend.

## Recurring schedules

If Sal asks for something to happen on a recurring cadence (e.g. "every Monday at 9", "daily at 8am", "every hour", "the 1st of each month") — DO NOT propose a one-off work order. Propose a *schedule*. Output a one-line acknowledgment, then \`[PROPOSE_SCHEDULE]\`, then JSON:

\`\`\`
Got it — I'll set up a recurring policy for your approval.
[PROPOSE_SCHEDULE]
{
  "name": "Short label, under 60 chars (e.g. 'Weekday morning briefing')",
  "description": "What this schedule does, plain English",
  "cadence": {
    "type": "hourly" | "daily" | "weekly" | "monthly" | "cron",
    /* Then ONE of: */
    "minute": 0,                                       /* hourly */
    "time": "08:00", "tz": "Europe/London",            /* daily */
    "days": ["mon","tue","wed","thu","fri"], "time": "09:00", "tz": "Europe/London",  /* weekly */
    "day_of_month": 1, "time": "09:00", "tz": "Europe/London",  /* monthly */
    "expr": "0 9 * * 1"                                /* cron escape hatch */
  },
  "work_order": {
    "type": "research" | "build_static_site" | "edit_project" | "send_outreach" | "design_mockup" | "meeting_admin" | "summary",
    "title": "Short imperative title",
    "description": "What the agent should do each time the schedule fires"
  }
}
\`\`\`

Pick the cadence type that matches the user's words. Default tz to "Europe/London" unless Sal specifies otherwise. Default minute to 0 for hourly. Days for weekly use lowercase 3-letter codes ("mon", "tue", etc.). Day_of_month is capped at 28 — for the 31st of the month use cron.

The "summary" work-order type is for status briefings — gathers tasks/memories/goals and posts a chat-formatted recap. Use it for things like "give me a daily briefing" or "send me a weekly recap of progress."

Sal will see a card showing the cadence in human-readable form (e.g. "every day at 09:00 Europe/London"), the next 3 firing times, what work order will fire each time, and the cost cap per firing. He approves the schedule once; firings then run automatically without re-approval. He can pause/delete from Settings → Schedules anytime.

If the cadence is ambiguous (e.g. "regularly", "every so often"), ASK which cadence — don't guess.`;

type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; source: { type: "url"; url: string } };
type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;
type Message = { role: "user" | "assistant"; content: string | ContentBlock[] };

// ── Tool definitions for chat mode ──────────────────────────────────────────

const CHAT_TOOLS = [
  {
    name: "fetch_url",
    description: "Fetch a URL and return its text content (HTML stripped). Use this to review websites, read articles, check if a page loads, or gather page content to answer a question. 15s timeout, returns up to 4KB of text.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL starting with http:// or https://" },
      },
      required: ["url"],
    },
  },
  {
    name: "query_state",
    description: "Look up current business state (tasks, memories, goals, or schedules) when the user asks about status, history, or what's happening. Returns JSON.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["tasks", "memories", "goals", "schedules"],
          description: "What to query",
        },
        status: {
          type: "string",
          description: "For tasks only: filter by status (pending, running, completed, failed, proposed, cancelled)",
        },
        search: {
          type: "string",
          description: "For memories only: keyword search within content",
        },
        limit: { type: "number", description: "Max rows, default 10" },
      },
      required: ["type"],
    },
  },
  // ── Admin write tools — bounded, reversible, don't burn money ─────────────
  // These are for trivial state management Sal asks for in chat ("clear the
  // list", "pause that schedule", "remember X"). They affect ONLY this
  // company's own state — never external services. Use them freely; you don't
  // need a work-order proposal for any of these.
  {
    name: "cancel_tasks",
    description:
      "Cancel tasks. Use when Sal says 'clear the list', 'cancel those proposals', 'kill what's running', etc. " +
      "REQUIRES either status (filters by status) or task_ids (specific tasks). Hard cap of 50 per call. " +
      "Reports back how many were cancelled.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["proposed", "pending", "running", "failed"],
          description: "Cancel all tasks in this status (most common: 'proposed' to clear un-approved drafts)",
        },
        task_ids: {
          type: "array",
          items: { type: "string" },
          description: "Cancel specific tasks by id. Overrides status filter.",
        },
        max: {
          type: "number",
          description: "Safety cap on number to cancel. Default 50, max 50.",
        },
      },
    },
  },
  {
    name: "manage_schedule",
    description:
      "Pause, resume, or delete a recurring schedule. Use when Sal says 'pause the daily briefing', " +
      "'stop that schedule', 'delete the morning recap', etc. Match by schedule_id (preferred) or " +
      "name_match (case-insensitive substring of the schedule's name).",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["pause", "resume", "delete"] },
        schedule_id: { type: "string" },
        name_match: { type: "string", description: "Substring of the schedule's name (case-insensitive)" },
      },
      required: ["action"],
    },
  },
  {
    name: "store_memory",
    description:
      "Save a fact for future reference. Use when Sal says 'remember that...', 'note that...', 'we now use X', " +
      "or any time he tells you a durable piece of context. Categories help organisation: " +
      "business_context | user_preference | market_intel | decision | contact | metric | technical_finding | process_learning.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The fact to remember, in your own words" },
        category: {
          type: "string",
          enum: [
            "business_context", "user_preference", "market_intel", "decision",
            "contact", "metric", "technical_finding", "process_learning",
          ],
          description: "Default 'business_context' if unsure",
        },
        importance: { type: "number", description: "1-10, default 5" },
      },
      required: ["content"],
    },
  },
];

async function runFetchUrl(input: Record<string, unknown>): Promise<string> {
  const url = typeof input.url === "string" ? input.url : "";
  if (!url || !url.startsWith("http")) {
    return JSON.stringify({ error: "Invalid URL — must start with http:// or https://" });
  }
  try {
    const r = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "SalOS-ChatBot/1.0" },
    });
    const contentType = r.headers.get("content-type") || "";
    let preview = "";
    if (
      contentType.includes("text") ||
      contentType.includes("html") ||
      contentType.includes("json")
    ) {
      const body = await r.text();
      preview = body
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 4000);
    }
    return JSON.stringify({
      status: r.status,
      ok: r.ok,
      content_type: contentType.split(";")[0],
      url: r.url,
      preview: preview || "(binary content)",
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "timeout";
    return JSON.stringify({ error: `Failed to reach ${url}: ${msg}` });
  }
}

async function runQueryState(
  supabase: SupabaseClient,
  companyId: string,
  input: Record<string, unknown>
): Promise<string> {
  const type = String(input.type || "");
  const limit = Math.min(Number(input.limit) || 10, 25);

  try {
    if (type === "tasks") {
      let q = supabase
        .from("tasks")
        .select("id,title,status,created_at,completed_at")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (input.status) q = q.eq("status", String(input.status));
      const { data, error } = await q;
      if (error) return JSON.stringify({ error: error.message });
      return JSON.stringify({ tasks: data || [] });
    }
    if (type === "memories") {
      let q = supabase
        .from("memories")
        .select("content,category,importance,created_at")
        .eq("company_id", companyId)
        .neq("category", "agent_message")
        .order("importance", { ascending: false })
        .limit(limit);
      if (input.search) q = q.ilike("content", `%${String(input.search)}%`);
      const { data, error } = await q;
      if (error) return JSON.stringify({ error: error.message });
      return JSON.stringify({ memories: data || [] });
    }
    if (type === "goals") {
      const { data, error } = await supabase
        .from("company_goals")
        .select("title,target_metric,current_value,target_value,timeframe,status")
        .eq("company_id", companyId)
        .order("priority", { ascending: true })
        .limit(limit);
      if (error) return JSON.stringify({ error: error.message });
      return JSON.stringify({ goals: data || [] });
    }
    if (type === "schedules") {
      const { data, error } = await supabase
        .from("scheduled_tasks")
        .select("id,name,cadence_type,cadence_spec,is_active,next_run_at,last_run_at,total_fires,total_failures")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) return JSON.stringify({ error: error.message });
      return JSON.stringify({ schedules: data || [] });
    }
    return JSON.stringify({ error: `Unknown type: ${type}` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: msg });
  }
}

// ── Admin write tools ──────────────────────────────────────────────────────

async function runCancelTasks(
  supabase: SupabaseClient,
  companyId: string,
  input: Record<string, unknown>
): Promise<string> {
  const status = typeof input.status === "string" ? input.status : null;
  const taskIds = Array.isArray(input.task_ids) ? (input.task_ids as string[]).filter(s => typeof s === "string") : null;
  const cap = Math.min(Number(input.max) || 50, 50);

  if (!status && (!taskIds || taskIds.length === 0)) {
    return JSON.stringify({
      error: "Provide either status (e.g. 'proposed') or task_ids — refusing to cancel without a filter.",
    });
  }

  const validStatuses = ["proposed", "pending", "running", "failed"];
  if (status && !validStatuses.includes(status)) {
    return JSON.stringify({ error: `status must be one of: ${validStatuses.join(", ")}` });
  }

  // Find the rows we'd cancel (so we can report titles)
  let q = supabase
    .from("tasks")
    .select("id, title, status")
    .eq("company_id", companyId)
    .limit(cap);
  if (taskIds && taskIds.length > 0) q = q.in("id", taskIds);
  else if (status) q = q.eq("status", status);

  const { data: targets, error: selErr } = await q;
  if (selErr) return JSON.stringify({ error: selErr.message });
  if (!targets?.length) return JSON.stringify({ cancelled: 0, message: "Nothing to cancel" });

  const ids = targets.map((t: { id: string }) => t.id);
  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("tasks")
    .update({
      status: "cancelled",
      completed_at: nowIso,
      error_message: "Cancelled by orchestrator at user request",
    })
    .in("id", ids);
  if (updErr) return JSON.stringify({ error: updErr.message });

  // Log so the chat-mode action shows up in terminal_logs for traceability
  const logs = targets.slice(0, cap).map((t: { id: string; status: string }) => ({
    task_id: t.id,
    message: `Task cancelled by orchestrator chat command (was ${t.status})`,
    source: "orchestrator-chat",
    log_type: "task_cancelled",
    company_id: companyId,
  }));
  if (logs.length) await supabase.from("terminal_logs").insert(logs).then(() => {}, () => {});

  return JSON.stringify({
    cancelled: targets.length,
    titles: targets.map((t: { title: string }) => t.title).slice(0, 10),
  });
}

async function runManageSchedule(
  supabase: SupabaseClient,
  companyId: string,
  input: Record<string, unknown>
): Promise<string> {
  const action = String(input.action || "");
  if (!["pause", "resume", "delete"].includes(action)) {
    return JSON.stringify({ error: "action must be pause | resume | delete" });
  }
  const id = typeof input.schedule_id === "string" ? input.schedule_id : null;
  const nameMatch = typeof input.name_match === "string" ? input.name_match : null;

  if (!id && !nameMatch) {
    return JSON.stringify({ error: "Provide schedule_id or name_match" });
  }

  // Find target schedule(s)
  let q = supabase
    .from("scheduled_tasks")
    .select("id, name, is_active")
    .eq("company_id", companyId);
  if (id) q = q.eq("id", id);
  else if (nameMatch) q = q.ilike("name", `%${nameMatch}%`);

  const { data: rows, error: selErr } = await q;
  if (selErr) return JSON.stringify({ error: selErr.message });
  if (!rows?.length) return JSON.stringify({ error: "No schedule matched" });
  if (rows.length > 1) {
    return JSON.stringify({
      error: `${rows.length} schedules matched "${nameMatch}". Be more specific or pass schedule_id.`,
      candidates: rows.map((r: { id: string; name: string }) => ({ id: r.id, name: r.name })),
    });
  }

  const target = rows[0];
  if (action === "delete") {
    const { error } = await supabase.from("scheduled_tasks").delete().eq("id", target.id);
    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify({ ok: true, action, schedule: target.name });
  }
  const { error } = await supabase
    .from("scheduled_tasks")
    .update({ is_active: action === "resume" })
    .eq("id", target.id);
  if (error) return JSON.stringify({ error: error.message });
  return JSON.stringify({ ok: true, action, schedule: target.name });
}

async function runStoreMemory(
  supabase: SupabaseClient,
  companyId: string,
  input: Record<string, unknown>
): Promise<string> {
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!content) return JSON.stringify({ error: "content is required" });
  if (content.length < 3) return JSON.stringify({ error: "content too short" });

  const validCats = [
    "business_context", "user_preference", "market_intel", "decision",
    "contact", "metric", "technical_finding", "process_learning",
  ];
  const category = validCats.includes(String(input.category)) ? String(input.category) : "business_context";
  const importance = Math.min(Math.max(Number(input.importance) || 5, 1), 10);

  const { data, error } = await supabase
    .from("memories")
    .insert({
      company_id: companyId,
      content: content.slice(0, 2000),
      category,
      importance,
      user_id: "00000000-0000-0000-0000-000000000000",
      metadata: { source: "orchestrator_chat" },
    })
    .select("id")
    .single();
  if (error) return JSON.stringify({ error: error.message });
  return JSON.stringify({ ok: true, memory_id: data?.id, category, importance });
}

async function runChatTool(
  supabase: SupabaseClient,
  companyId: string,
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  if (name === "fetch_url") return runFetchUrl(input);
  if (name === "query_state") return runQueryState(supabase, companyId, input);
  if (name === "cancel_tasks") return runCancelTasks(supabase, companyId, input);
  if (name === "manage_schedule") return runManageSchedule(supabase, companyId, input);
  if (name === "store_memory") return runStoreMemory(supabase, companyId, input);
  return JSON.stringify({ error: `Unknown tool: ${name}` });
}

// ── Work order proposal: parse + preflight ──────────────────────────────────

async function checkComposioConnected(appName: string): Promise<"ready" | "missing" | "unknown"> {
  const composioKey = process.env.COMPOSIO_API_KEY;
  if (!composioKey) return "unknown";
  try {
    const r = await fetch("https://backend.composio.dev/api/v1/connectedAccounts?showActiveOnly=true", {
      headers: { "x-api-key": composioKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return "unknown";
    const data = await r.json();
    const items = (data.items || data || []) as Array<{ appName: string; status: string }>;
    const connected = items.some(
      a => a.appName?.toLowerCase() === appName.toLowerCase() && a.status === "ACTIVE"
    );
    return connected ? "ready" : "missing";
  } catch {
    return "unknown";
  }
}

// Check the API Center / integrations table.
// Returns:
//   ready     -> integration row exists and isn't broken
//   missing   -> no row, OR row exists with status='broken' (re-auth needed)
//   unknown   -> couldn't query (treat as warning, don't block)
async function checkNativeIntegrationConnected(
  supabase: SupabaseClient,
  companyId: string,
  vendor: string
): Promise<{ status: "ready" | "missing" | "unknown"; note?: string }> {
  try {
    const { data, error } = await supabase
      .from("integrations")
      .select("id, status")
      .eq("company_id", companyId)
      .eq("vendor", vendor)
      .maybeSingle();
    if (error) return { status: "unknown", note: `Could not check: ${error.message}` };
    if (!data) {
      return {
        status: "missing",
        note: `Connect ${vendor} in Settings → API Center before approving.`,
      };
    }
    if (data.status === "broken") {
      return {
        status: "missing",
        note: `${vendor} credentials are invalid — reconnect in API Center before approving.`,
      };
    }
    if (data.status === "inactive") {
      return {
        status: "missing",
        note: `${vendor} is currently disabled — re-enable in API Center before approving.`,
      };
    }
    return { status: "ready" };
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    return { status: "unknown", note: `Could not check: ${m}` };
  }
}

async function buildPreflight(
  supabase: SupabaseClient,
  companyId: string,
  type: WorkOrderType
): Promise<WorkOrderProposal["preflight"]> {
  const required = REQUIRED_INTEGRATIONS[type] || [];
  const checks: WorkOrderProposal["preflight"] = [];
  for (const req of required) {
    if (req.source === "native") {
      const result = await checkNativeIntegrationConnected(supabase, companyId, req.vendor);
      checks.push({ tool: req.vendor, status: result.status, note: result.note });
    } else {
      const status = await checkComposioConnected(req.vendor);
      const note =
        status === "missing"
          ? `Connect ${req.vendor} (Composio) before approving.`
          : status === "unknown"
          ? `Could not verify ${req.vendor} connection.`
          : undefined;
      checks.push({ tool: req.vendor, status, note });
    }
  }
  return checks;
}

function tryParseWorkOrderJson(rawJson: string): Partial<WorkOrderProposal> | null {
  try {
    return JSON.parse(rawJson);
  } catch {
    // Try to recover: strip code-fence backticks and surrounding text
    const cleaned = rawJson.replace(/```(json)?/g, "").trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl =
    process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !supabaseKey)
    return res.status(500).json({ error: "Supabase not configured" });
  if (!anthropicKey)
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { conversation_id, company_id, message, attachments } = req.body || {};
  if (!conversation_id || !company_id || !message)
    return res
      .status(400)
      .json({ error: "conversation_id, company_id, and message are required" });

  if (!checkRateLimit(company_id))
    return res.status(429).json({ error: "Rate limit exceeded. Max " + RATE_LIMIT_MAX + " requests per minute." });

  const attachmentList: Array<{ name: string; url: string; type: string; size: number }> =
    Array.isArray(attachments) ? attachments : [];

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const [agentsRes, companyRes, historyRes, goalsRes, tasksRes] =
      await Promise.all([
        supabase
          .from("agent_definitions")
          .select("id, slug, system_prompt, model")
          .eq("slug", "orchestrator")
          .eq("company_id", company_id),
        supabase
          .from("companies")
          .select("name, brief")
          .eq("id", company_id)
          .single(),
        supabase
          .from("chat_messages")
          .select("role, content, metadata")
          .eq("conversation_id", conversation_id)
          .order("created_at", { ascending: false })
          .limit(30),
        supabase
          .from("company_goals")
          .select(
            "title, target_metric, current_value, target_value, timeframe"
          )
          .eq("company_id", company_id)
          .eq("status", "active")
          .order("priority", { ascending: true }),
        supabase
          .from("tasks")
          .select("title, status, completed_at")
          .eq("company_id", company_id)
          .in("status", ["pending", "running", "completed"])
          .order("created_at", { ascending: false })
          .limit(10),
      ]);

    const orchestrator = agentsRes.data?.[0] || null;

    let systemPrompt =
      orchestrator?.system_prompt ||
      "You are the Orchestrator of a Cyber Business OS. Be direct and concise.";

    const company = companyRes.data;
    if (company?.brief) {
      const b = company.brief as Record<string, string>;
      const parts: string[] = [];
      if (b.what_we_do) parts.push("Business: " + b.what_we_do);
      if (b.stage) parts.push("Stage: " + b.stage);
      if (b.target_customers) parts.push("Customers: " + b.target_customers);
      if (b.tone_of_voice) parts.push("Tone: " + b.tone_of_voice);
      if (b.context_notes) parts.push("Notes: " + b.context_notes);
      if (parts.length)
        systemPrompt +=
          "\n\n## Company Context (" + company.name + ")\n" + parts.join("\n");
    }

    if (goalsRes.data?.length) {
      const lines = goalsRes.data.map(
        (g: Record<string, unknown>, i: number) =>
          i +
          1 +
          ". " +
          g.title +
          (g.target_metric
            ? " (" +
              (g.current_value ?? 0) +
              "/" +
              (g.target_value ?? "?") +
              " " +
              g.target_metric +
              ")"
            : "") +
          (g.timeframe ? " — " + g.timeframe : "")
      );
      systemPrompt += "\n\n## Active Goals\n" + lines.join("\n");
    }

    if (tasksRes.data?.length) {
      const lines = tasksRes.data.map(
        (t: Record<string, string>) => `- [${t.status}] ${t.title}`
      );
      systemPrompt +=
        "\n\n## Recent Tasks (background only — do NOT bring these up unless asked)\n" +
        lines.join("\n");
    }

    systemPrompt += ROUTING_ADDENDUM;

    const rawHistory = [...(historyRes.data || [])].reverse();

    const filtered = rawHistory
      .filter((m: Record<string, unknown>) => {
        if (!m.content) return false;
        const meta = m.metadata as Record<string, unknown> | null;
        if (meta?.notification === true) return false;
        if (meta?.error === true) return false;
        if (meta?.progress === true) return false;
        return true;
      })
      .map((m: Record<string, string>, i: number, arr: Record<string, string>[]) => ({
        role: m.role === "user" ? ("user" as const) : ("assistant" as const),
        content:
          i < arr.length - 8
            ? (m.content || "").slice(0, 100) + ((m.content || "").length > 100 ? "..." : "")
            : m.content,
      }));

    const messages: Message[] = [];
    for (const m of filtered) {
      const prev = messages[messages.length - 1];
      if (prev && prev.role === m.role && typeof prev.content === "string") {
        prev.content = (prev.content as string) + "\n" + m.content;
      } else {
        messages.push({ ...m });
      }
    }

    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== "user" || lastMsg.content !== message) {
      if (attachmentList.length > 0) {
        const imageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
        const contentBlocks: ContentBlock[] = [];
        for (const att of attachmentList) {
          if (imageTypes.has(att.type)) {
            contentBlocks.push({
              type: "image",
              source: { type: "url", url: att.url },
            });
          } else {
            contentBlocks.push({
              type: "text",
              text: `[Attached file: ${att.name} (${att.type}, ${Math.round(att.size / 1024)}KB) — ${att.url}]`,
            });
          }
        }
        contentBlocks.push({ type: "text", text: message });
        messages.push({ role: "user", content: contentBlocks });
      } else {
        messages.push({ role: "user", content: message });
      }
    }

    // ── Tool-use loop ───────────────────────────────────────────────────────
    const model = orchestrator?.model || "claude-opus-4-6";
    let reply = "";
    let toolTurns = 0;

    while (toolTurns <= MAX_TOOL_TURNS) {
      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          temperature: 0.3,
          system: systemPrompt,
          tools: CHAT_TOOLS,
          messages,
        }),
      });

      if (!anthropicRes.ok) {
        const errBody = await anthropicRes.text().catch(() => "");
        const errMsg = `Anthropic ${anthropicRes.status}: ${errBody.slice(0, 300)}`;
        await supabase.from("chat_messages").insert({
          conversation_id,
          role: "system",
          kind: "error",
          content: `Chat error: ${errMsg.slice(0, 500)}`,
          timestamp: new Date().toISOString(),
          metadata: { kind: "error", source: "anthropic", original_error: errMsg },
        }).then(() => {}, () => {});
        return res.status(502).json({ error: errMsg });
      }

      const anthropicData = await anthropicRes.json();
      const contentBlocks = (anthropicData.content || []) as ContentBlock[];
      const stopReason = anthropicData.stop_reason;

      const toolUses = contentBlocks.filter(
        (b): b is ToolUseBlock => b.type === "tool_use"
      );
      const textBlocks = contentBlocks.filter(
        (b): b is TextBlock => b.type === "text"
      );
      const assistantText = textBlocks.map(b => b.text).join("\n").trim();

      // If no tool calls or we've hit the cap, finalize
      if (
        stopReason !== "tool_use" ||
        toolUses.length === 0 ||
        toolTurns >= MAX_TOOL_TURNS
      ) {
        reply = assistantText || "Sorry, I couldn't generate a reply.";
        break;
      }

      // Record assistant's tool-use message
      messages.push({ role: "assistant", content: contentBlocks });

      // Run each tool
      const toolResults: ContentBlock[] = [];
      for (const tu of toolUses) {
        const result = await runChatTool(supabase, company_id, tu.name, tu.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: result.slice(0, 8000), // safety cap on tool output
        });
      }

      messages.push({ role: "user", content: toolResults });
      toolTurns++;
    }

    // ── Integration proposal detection (API Center conversational add) ──────
    const intMatch = extractIntegrationProposal(reply);
    if (intMatch) {
      const { preamble, rawJson } = intMatch;
      let parsedInt: { vendor?: string } | null = null;
      try {
        parsedInt = JSON.parse(rawJson);
      } catch {
        parsedInt = null;
      }

      // Look up the vendor in the registry — same source of truth as the API Center
      const { getVendor } = await import("./lib/vendor-registry.js");
      const vendorDef = parsedInt?.vendor ? getVendor(parsedInt.vendor) : null;

      if (!vendorDef) {
        await supabase.from("chat_messages").insert({
          conversation_id,
          role: "system",
          kind: "error",
          content:
            `I can't add "${parsedInt?.vendor || "that"}" via the API Center — it's not in the known-vendors list. ` +
            `Currently supported: openai, anthropic, github, resend, serper, exa. ` +
            `For a vendor not in this list, a custom integration needs a code change.`,
          timestamp: new Date().toISOString(),
          metadata: {
            kind: "error",
            source: "quick-reply",
            original_error: `Unknown vendor: ${parsedInt?.vendor}`,
          },
        });
        return res.status(200).json({ mode: "unknown_integration_vendor" });
      }

      // Check whether it's already connected — useful for the UI to render "edit" mode
      const { data: existingInt } = await supabase
        .from("integrations")
        .select("id, status, credential_preview")
        .eq("company_id", company_id)
        .eq("vendor", vendorDef.vendor)
        .maybeSingle();

      const ackContent =
        preamble ||
        (existingInt
          ? `Updating ${vendorDef.display_name} — paste a new key (or leave blank to keep current).`
          : `Let's get ${vendorDef.display_name} connected. Paste your key below.`);

      await supabase.from("chat_messages").insert({
        conversation_id,
        role: "assistant",
        kind: "integration_proposal",
        content: ackContent,
        timestamp: new Date().toISOString(),
        metadata: {
          kind: "integration_proposal",
          vendor: vendorDef.vendor,
          // Trim the registry entry down to what the UI needs to render the form
          vendor_def: {
            vendor: vendorDef.vendor,
            display_name: vendorDef.display_name,
            description: vendorDef.description,
            docs_url: vendorDef.docs_url,
            credentials: vendorDef.credentials,
            config: vendorDef.config,
          },
          existing: existingInt
            ? {
                id: existingInt.id,
                status: existingInt.status,
                credential_preview: existingInt.credential_preview,
              }
            : null,
        },
      });

      return res.status(200).json({
        mode: "integration_proposed",
        vendor: vendorDef.vendor,
        existing: !!existingInt,
      });
    }

    // ── Schedule proposal detection (Stage 5: recurring policies) ───────────
    const schedMatch = extractScheduleProposal(reply);
    if (schedMatch) {
      const { preamble, rawJson } = schedMatch;
      let parsed: {
        name?: string;
        description?: string;
        cadence?: { type?: string;[k: string]: unknown };
        work_order?: { type?: string; title?: string; description?: string };
      } | null = null;
      try { parsed = JSON.parse(rawJson); } catch { parsed = null; }

      if (!parsed?.cadence?.type || !parsed?.work_order?.type || !parsed?.name) {
        await supabase.from("chat_messages").insert({
          conversation_id, role: "system", kind: "error",
          content: "Schedule proposal was malformed — missing name, cadence.type, or work_order.type.",
          timestamp: new Date().toISOString(),
          metadata: { kind: "error", source: "quick-reply", original_error: rawJson.slice(0, 500) },
        });
        return res.status(200).json({ mode: "malformed_schedule_proposal" });
      }

      const cadenceType = parsed.cadence.type;
      const cadenceSpec: Record<string, unknown> = { ...parsed.cadence };
      delete (cadenceSpec as { type?: unknown }).type;

      // Validate via the shared helper so we catch bad cron exprs / out-of-range fields here
      // instead of blowing up at fire time.
      const sched = await import("./lib/schedule.mjs");
      const cadErr = sched.validateCadence(cadenceType, cadenceSpec);
      if (cadErr) {
        await supabase.from("chat_messages").insert({
          conversation_id, role: "system", kind: "error",
          content: `Schedule cadence is invalid: ${cadErr}`,
          timestamp: new Date().toISOString(),
          metadata: { kind: "error", source: "quick-reply", original_error: cadErr },
        });
        return res.status(200).json({ mode: "invalid_schedule_cadence", error: cadErr });
      }

      const woType = parsed.work_order.type;
      if (!WORK_ORDER_TYPES.includes(woType as WorkOrderType)) {
        await supabase.from("chat_messages").insert({
          conversation_id, role: "system", kind: "error",
          content: `Schedule's work_order.type "${woType}" is not a valid type.`,
          timestamp: new Date().toISOString(),
          metadata: { kind: "error", source: "quick-reply" },
        });
        return res.status(200).json({ mode: "invalid_schedule_work_order_type" });
      }

      const tmplWoType = woType as WorkOrderType;
      const cadenceHuman = sched.describeCadence(cadenceType, cadenceSpec);
      let nextRuns: string[] = [];
      try {
        nextRuns = sched.previewNextRuns(cadenceType, cadenceSpec, 3, new Date()).map((d: Date) => d.toISOString());
      } catch (e: unknown) {
        const m = e instanceof Error ? e.message : String(e);
        await supabase.from("chat_messages").insert({
          conversation_id, role: "system", kind: "error",
          content: `Schedule cadence cannot compute next run: ${m}`,
          timestamp: new Date().toISOString(),
          metadata: { kind: "error", source: "quick-reply", original_error: m },
        });
        return res.status(200).json({ mode: "schedule_cadence_unfulfillable" });
      }

      // Build the proposal payload the UI renders
      const proposal = {
        name: String(parsed.name).slice(0, 60),
        description: parsed.description ? String(parsed.description).slice(0, 500) : "",
        cadence_type: cadenceType,
        cadence_spec: cadenceSpec,
        cadence_human: cadenceHuman,
        next_runs_preview: nextRuns,
        work_order_template: {
          type: tmplWoType,
          agent: AGENT_FOR_TYPE[tmplWoType],
          title: String(parsed.work_order.title || parsed.name).slice(0, 60),
          description: String(parsed.work_order.description || parsed.description || "").slice(0, 2000),
          estimated_cost_usd: COST_CAP_USD[tmplWoType],
          estimated_minutes: TIME_CAP_MIN[tmplWoType],
          output_target: OUTPUT_TARGET[tmplWoType],
        },
      };

      const ackContent = preamble || `I've drafted a schedule for your approval — review the cadence and click Approve.`;

      await supabase.from("chat_messages").insert({
        conversation_id, role: "assistant", kind: "schedule_proposal",
        content: ackContent,
        timestamp: new Date().toISOString(),
        metadata: { kind: "schedule_proposal", proposal },
      });

      return res.status(200).json({ mode: "schedule_proposed", proposal });
    }

    // ── Work order proposal detection ───────────────────────────────────────
    const woMatch = extractJsonAfterMarker(reply);

    if (woMatch) {
      const { preamble, rawJson } = woMatch;

      const parsed = tryParseWorkOrderJson(rawJson);

      // If the LLM emitted the marker but bad JSON, fail clearly.
      if (!parsed || !parsed.type || !WORK_ORDER_TYPES.includes(parsed.type as WorkOrderType)) {
        await supabase.from("chat_messages").insert({
          conversation_id,
          role: "system",
          kind: "error",
          content:
            "Work order proposal was malformed — couldn't parse type. Try rephrasing your request, or ask me to clarify.",
          timestamp: new Date().toISOString(),
          metadata: { kind: "error", source: "quick-reply", original_error: rawJson.slice(0, 500) },
        });
        return res.status(200).json({ mode: "malformed_proposal" });
      }

      // Fill in canonical fields from type registry. The LLM only chooses type +
      // title + description; everything else is determined by the system so it
      // can't propose its way around our cost / agent constraints.
      const type = parsed.type as WorkOrderType;
      const proposal: WorkOrderProposal = {
        type,
        agent: AGENT_FOR_TYPE[type],
        title: (parsed.title || "Work order").slice(0, 60),
        description: (parsed.description || message).slice(0, 2000),
        estimated_cost_usd: COST_CAP_USD[type],
        estimated_minutes: TIME_CAP_MIN[type],
        output_target: OUTPUT_TARGET[type],
        preflight: await buildPreflight(supabase, company_id, type),
      };

      // Resolve agent_definition_id for the chosen agent
      const { data: agentDef } = await supabase
        .from("agent_definitions")
        .select("id")
        .eq("slug", proposal.agent)
        .eq("company_id", company_id)
        .maybeSingle();

      const taskInput: Record<string, unknown> = {
        instruction: proposal.description,
        context: message,
      };
      if (attachmentList.length > 0) {
        taskInput.attachments = attachmentList;
      }

      // Insert proposed task with work_order metadata. Status stays 'proposed'
      // until the user approves via /api/approve-work-order.
      const { data: taskRow } = await supabase
        .from("tasks")
        .insert({
          conversation_id,
          agent_definition_id: agentDef?.id || null,
          company_id,
          status: "proposed",
          title: proposal.title,
          description: proposal.description,
          input_data: taskInput,
          source: "chat",
          metadata: {
            work_order: {
              type: proposal.type,
              agent: proposal.agent,
              estimated_cost_usd: proposal.estimated_cost_usd,
              estimated_minutes: proposal.estimated_minutes,
              output_target: proposal.output_target,
              preflight: proposal.preflight,
            },
          },
        })
        .select("id")
        .single();

      // Render-friendly chat message: the UI looks at metadata.kind to render
      // the work-order card with Approve / Cancel buttons.
      const ackContent =
        preamble ||
        `Proposed: ${proposal.title}. Click Approve below to run, or Cancel to skip.`;

      await supabase.from("chat_messages").insert({
        conversation_id,
        role: "assistant",
        kind: "work_order_proposal",
        content: ackContent,
        timestamp: new Date().toISOString(),
        metadata: {
          kind: "work_order_proposal",
          task_id: taskRow?.id,
          proposal,
        },
      });

      return res.status(200).json({
        mode: "work_order_proposed",
        task_id: taskRow?.id,
        proposal,
      });
    }

    await supabase.from("chat_messages").insert({
      conversation_id,
      role: "assistant",
      kind: "reply",
      content: reply,
      timestamp: new Date().toISOString(),
      metadata: { kind: "reply" },
    });

    return res.status(200).json({ mode: "direct", tool_turns: toolTurns });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("quick-reply error:", msg);
    // Persist the actual error in the conversation so the user sees what failed,
    // not "Something went wrong." The UI renders kind=error distinctly.
    try {
      await supabase.from("chat_messages").insert({
        conversation_id,
        role: "system",
        kind: "error",
        content: `Chat error: ${msg.slice(0, 500)}`,
        timestamp: new Date().toISOString(),
        metadata: { kind: "error", source: "quick-reply", original_error: msg },
      });
    } catch {
      // If we can't even write the error, surface via the response and console
    }
    return res.status(500).json({ error: msg });
  }
}
