import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { decryptCredentials, encryptCredentials, maskCredential } from "./lib/crypto.js";

export const maxDuration = 300;

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

// Translate Anthropic API errors into messages that tell Sal what to actually
// do. The raw upstream body is still kept in metadata.original_error so we can
// debug, but the user-facing chat row gets the humanized version.
function humanizeAnthropicError(status: number, body: string): string {
  const lower = (body || "").toLowerCase();
  if (lower.includes("credit balance is too low") || lower.includes("billing")) {
    return "🪫 Anthropic credits are out — top up at https://console.anthropic.com/settings/billing then send the message again.";
  }
  if (status === 401 || lower.includes("invalid_api_key") || lower.includes("authentication")) {
    return "🔑 Anthropic API key is invalid or revoked. Rotate it on console.anthropic.com and update the ANTHROPIC_API_KEY env var (Vercel project settings).";
  }
  if (status === 429 || lower.includes("rate_limit") || lower.includes("rate limit")) {
    return "⏱️ Anthropic rate limit hit. Wait ~60s and try again. If it keeps happening, raise org-level limits in console.anthropic.com.";
  }
  if (lower.includes("model_not_found") || lower.includes("model not found")) {
    return "🤖 The model id this orchestrator is configured to use isn't available on your Anthropic plan. Check Settings → Agents → Orchestrator → Model.";
  }
  if (lower.includes("overloaded")) {
    return "🌪️ Anthropic is overloaded. Try again in a few seconds.";
  }
  // Default: extract the first useful line of the upstream JSON message.
  try {
    const parsed = JSON.parse(body);
    const m = parsed?.error?.message || parsed?.message;
    if (typeof m === "string" && m.length > 0) {
      return `⚠️ Anthropic ${status}: ${m.slice(0, 280)}`;
    }
  } catch { /* not JSON, fall through */ }
  return `⚠️ Anthropic ${status}: ${body.slice(0, 280) || "no body"}`;
}

// In-memory rate limiter (resets on cold start / redeploy)
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10;

// Tool-use loop cap — chat mode answers in a few turns, not a research project.
// Bumped from 3 to 5 so the orchestrator can chain e.g.
//   query_state -> call_integration -> reply
// without hitting the cap on a multi-step admin question.
const MAX_TOOL_TURNS = 5;

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

// Heuristic: does this message ask the orchestrator to do strategic / briefing
// work that warrants Opus 4.7 over Sonnet 4.6? The bar is "thinking that, if
// botched, would have downstream cost across the team or a long-running task."
//
// Not a classifier — just patterns. Cheap (no model call) and biased toward
// over-escalating, since the asymmetry favours that. A user can always
// downgrade for an obvious chat-only turn by phrasing it as a question.
const AGENT_SLUGS_RE = /\b(growth|research|engineering|designer|design|sales|outreach|browser|task[\s-]?management|executive[\s-]?assistant|orchestrator)\b/i;

const STRATEGIC_INTENT_PATTERNS: RegExp[] = [
  // Modifying / briefing another agent — anything that touches the team itself
  /\b(update|modify|tweak|adjust|improve|sharpen|rewrite|fix|brief|reconfigure|configure|train|teach|coach|repurpose|repurpos|retune)\s+(the\s+)?(\w+\s+)?(agent|prompt|growth|research|engineering|designer|design|sales|outreach|browser|task[\s-]?management|executive[\s-]?assistant|orchestrator)/i,
  // Multi-agent or system-level reasoning
  /\b(reorg|restructure|reshape|reorganise|reorganize|rewire|redesign|overhaul)\b/i,
  // Strategic planning / briefing language
  /\b(plan\s+(a|the|our)\s+(campaign|launch|rollout|roadmap|strategy|approach)|kick\s*off|outline\s+a\s+plan|design\s+a\s+(strategy|workflow|process|pipeline))\b/i,
  // Complex research/analysis briefing (vs. quick lookup)
  /\b(deep\s*dive|long[-\s]form|comprehensive\s+(brief|analysis|report)|in[-\s]depth|full\s+analysis)\b/i,
  // Explicit asks for substantive thinking
  /\b(think\s+(carefully|hard|deeply)|figure\s+out\s+how|come\s+up\s+with\s+a\s+(plan|strategy|approach))\b/i,
];

function detectStrategicIntent(message: string): boolean {
  if (!message || message.length < 12) return false;
  const text = message.trim();

  // Pattern 1: any of the strategic-intent regexes
  for (const re of STRATEGIC_INTENT_PATTERNS) {
    if (re.test(text)) return true;
  }

  // Pattern 2: an agent slug + a verb suggesting strategic action on it
  // ("growth keeps using flat subject lines, can you do something about that")
  const VERBS_NEAR_AGENT = /(make|teach|coach|train|tune|configure|fix|improve|push|brief|update|tweak|adjust)/i;
  if (AGENT_SLUGS_RE.test(text) && VERBS_NEAR_AGENT.test(text)) return true;

  // Pattern 3: long-form ask (300+ chars) — usually means real briefing work
  // rather than quick chat. Same threshold the runner uses for "this is
  // probably a real ask" routing.
  if (text.length > 300) return true;

  return false;
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

## Operating model — read this first

You are Sal's AI colleague and the master agent for this company. Sal owns the keys, the data, the consequences. Your default posture is **act, don't ask.** You have full read AND write access to every part of state, every connected vendor, every other agent, and your own configuration.

There is exactly **one** decision to make before any action:

> **Is this materially severe AND did Sal NOT explicitly ask for it in this conversation?**

If yes → emit \`[PROPOSE_WORK_ORDER]\` with status="proposed" so Sal can approve.
If no → just do it. Right now. In this turn.

### What "materially severe" means

A small, conservative carve-out — everything else is just "do it":

- **Money movement.** Charges, refunds, payments, paid ad spend.
- **Mass external send.** Email blasts to >20 recipients, paid SMS, public social posts on the company's accounts.
- **Irreversible deletion of someone else's data.** Customer rows, third-party records, force-pushing over a default branch.
- **Production deploys with no test signal.** Pushing to a live customer-facing service with no staging or test step.

That's it. **Everything else is fair game.** Reading anything, writing internal state, connecting integrations, calling any vendor API (POST, DELETE, whatever), modifying any agent — including yourself — pushing code to feature branches, single-recipient outreach: just do it.

### Sal-initiated overrides the carve-out

If Sal said "send the email blast", "post this on LinkedIn", "deploy to prod", "delete those rows" — then it's authorized. The carve-out is for when YOU initiated something severe on your own. If Sal asked for it, do it.

### What you can do that you might forget you can

- **Modify any agent's system_prompt, including your own.** When you notice your own behaviour is wrong (asking too many permissions, hallucinating a tool you don't have, refusing pasted keys), call \`update_agent({agent_slug:'orchestrator', system_prompt:'...', system_prompt_mode:'append', reason:'...'})\`. Versioned, reversible, no opt-in needed.
- **Modify any other agent.** Same tool, same lack of gates. \`is_safe_auto_modify\` is no longer a wall.
- **Push code.** GitHub is connected. Use \`call_vendor_http({vendor:'github', method:'PUT', path:'/repos/{owner}/{repo}/contents/{path}', body:{message:'...', content:'<base64>', sha:'...'}})\` to commit a file. Or trigger the engineering agent for bigger changes.
- **Connect anything.** \`add_integration\` accepts any vendor — registered or custom (just supply auth_type + config.base_url). When Sal pastes a key, call this in the same turn.
- **Call any HTTP method on any vendor.** \`call_vendor_http\` and \`call_integration\` both allow POST/PUT/DELETE now. No GET-only restriction.
- **Self-modify in response to feedback.** If Sal corrects your behaviour, you can append the correction to your own prompt so future turns absorb it. Don't wait for him to do it manually.

### Tool reference

**Reading (just call them):**
- \`fetch_url\` — any URL.
- \`query_state\` — tasks, memories, goals, schedules, agents.
- \`read_agent_output\` — the full deliverable a specialist wrote.
- \`call_integration\` — any registered vendor action (POST/GET/etc, no method restriction).

**Writing (just call them — no approval cards needed):**
- \`cancel_tasks\` — always pass a one-line \`reason\` paraphrasing Sal's instruction (e.g. \`reason: "clear failed list"\`). Stored on each cancelled row for future audits.
- \`manage_schedule\`, \`run_schedule_now\`, \`update_goal\`, \`store_memory\`
- \`update_agent\` / \`revert_agent\` — modify ANY agent including yourself
- \`add_integration\` — wire any vendor, registered or custom
- \`call_vendor_http\` — generic HTTP through any connected vendor

**Proposing (only for the severity carve-out):**
- \`[PROPOSE_WORK_ORDER]\` block — emit when (a) action is in the severity list AND (b) Sal didn't ask for it.

\`\`\`
[PROPOSE_WORK_ORDER]
{ "type": "research|build_static_site|edit_project|send_outreach|design_mockup|meeting_admin|summary",
  "title": "...", "description": "..." }
\`\`\`

### Critical anti-patterns — never do these

- ❌ "Want me to set it up?" / "Should I proceed?" / "Do you want me to..." after Sal already authorized. He told you to do something — DO IT.
- ❌ "Best practice is to regenerate the key" when Sal just pasted one. The key is authorized. Use it.
- ❌ "I don't have access to X" — check your tools. If a tool covers it, you have access. If no tool covers it, say "I don't have a tool for that yet — should I add one?" and then add it.
- ❌ "Let me propose a work order to..." for non-severe action. Just do it.
- ❌ "Agent X needs to be opted in before I can modify it" — that gate is gone. Modify it.
- ❌ Saying "I'll do it" without actually calling the tool in the same turn.
- ❌ Asking which tool to use, asking which vendor to use, asking which value to use — make a reasonable choice and report what you did. Sal will correct if wrong.`;

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
    description: "Look up current business state (tasks, memories, goals, schedules, or agents) when the user asks about status, history, what's happening, or the team's current configuration. Returns JSON. For agents, returns each one's slug, system_prompt, model, description, and is_safe_auto_modify — read this BEFORE calling update_agent so you know what you're about to change.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["tasks", "memories", "goals", "schedules", "agents"],
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
      "REQUIRES either status (filters by status) or task_ids (specific tasks). Hard cap of 500 per call. " +
      "Reports back how many were cancelled. ALWAYS pass a one-line `reason` paraphrasing Sal's instruction — " +
      "it's stored on each cancelled row so future audits show real context, not 'Cancelled by orchestrator at user request'.",
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
          description: "Safety cap on number to cancel. Default 500, max 500. Iterate if more.",
        },
        reason: {
          type: "string",
          description: "One-line paraphrase of why Sal asked you to cancel (e.g. \"clear failed list\" or \"cancel App Store research, was wrong direction\"). Stored on each cancelled row.",
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
  // ── External-service read access (App Store Connect, GitHub, Resend, etc.) ─
  // Sal expects "all-knowing" — when he asks "how many builds today" or "show me
  // last week's reviews," call the relevant integration directly. NEVER tell him
  // to connect something that's already in the Connected External Services list.
  {
    name: "call_integration",
    description:
      "Call a connected external service. READ-ONLY in chat (only GET actions allowed). " +
      "See the 'Connected External Services' block in your system prompt for exact vendors and " +
      "actions available. Examples: appstoreconnect/list_apps, appstoreconnect/list_builds, " +
      "github/list_repos. For WRITE actions (sending email, creating repos, posting outreach), " +
      "propose a work order instead — those need approval cards because of side-effects.",
    input_schema: {
      type: "object",
      properties: {
        vendor: { type: "string", description: "Vendor slug, e.g. 'appstoreconnect', 'github'" },
        action: { type: "string", description: "Action name (must be GET-method)" },
        params: { type: "object", description: "Action params (see system prompt for shapes)" },
      },
      required: ["vendor", "action"],
    },
  },
  {
    name: "update_goal",
    description:
      "Update a company goal's current_value, status, or target_value. Match by goal title (case-insensitive substring).",
    input_schema: {
      type: "object",
      properties: {
        title_match: { type: "string", description: "Substring of the goal title" },
        current_value: { type: "number" },
        target_value: { type: "number" },
        status: { type: "string", enum: ["active", "achieved", "paused", "abandoned"] },
      },
      required: ["title_match"],
    },
  },
  {
    name: "run_schedule_now",
    description:
      "Manually fire a scheduled work order RIGHT NOW (without affecting its cadence). Useful when Sal " +
      "wants to test a schedule or get a one-off run. Match by schedule_id or name_match.",
    input_schema: {
      type: "object",
      properties: {
        schedule_id: { type: "string" },
        name_match: { type: "string" },
      },
    },
  },
  {
    name: "read_agent_output",
    description:
      "Read the full deliverable a specialist wrote for a completed task. Use this when Sal asks 'what did " +
      "research find?', 'show me the brief', 'pull up that report', or any time you need the actual content " +
      "a specialist produced. Pass either task_id (specific task) or agent_slug (most-recent completed task " +
      "by that agent: research, engineering, designer, growth, etc.). NEVER tell Sal you can't see a result " +
      "without trying this tool first — the deliverable is in task_results, you just have to fetch it.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Specific task UUID — preferred when known" },
        agent_slug: {
          type: "string",
          description: "Agent slug (e.g. 'research', 'engineering') — returns latest completed task by that agent",
        },
      },
    },
  },
  {
    name: "update_agent",
    description:
      "Modify ANY agent's system_prompt, model, or description — including yourself (the orchestrator). " +
      "Use when you spot a pattern an agent consistently misses, needs sharper context, or has an instruction " +
      "that's actively misfiring. Self-mod is encouraged when you notice your own behaviour is wrong. " +
      "Every change is versioned in agent_definition_versions and reversible via revert_agent — that's the " +
      "safety net, not a permission gate. Always include a clear `reason` — it's permanently logged.\n\n" +
      "system_prompt_mode controls how `system_prompt` is interpreted:\n" +
      "  - 'replace' (default): your `system_prompt` becomes the entire prompt. Use for full rewrites.\n" +
      "  - 'append': your `system_prompt` is appended to the existing one (with a newline + section divider). Use for additive rules.\n" +
      "  - 'prepend': your `system_prompt` is prepended to the existing one. Use for new top-level identity.\n" +
      "Default 'replace' is destructive — for incremental tweaks, ALWAYS use 'append'.",
    input_schema: {
      type: "object",
      properties: {
        agent_slug: { type: "string", description: "Target agent slug" },
        system_prompt: { type: "string", description: "Prompt content (interpreted by system_prompt_mode)" },
        system_prompt_mode: {
          type: "string",
          enum: ["replace", "append", "prepend"],
          description: "How to apply system_prompt. Default 'replace'. Use 'append' for additive tweaks.",
        },
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
      "Roll an agent back to a previous version. Use when a recent update_agent didn't help or made things " +
      "worse. Pass version_number to target a specific version, or omit to revert to the immediately-prior one.",
    input_schema: {
      type: "object",
      properties: {
        agent_slug: { type: "string" },
        version_number: { type: "number", description: "Specific version to restore. Omit for the immediately-prior one." },
        reason: { type: "string", description: "Why you're reverting" },
      },
      required: ["agent_slug", "reason"],
    },
  },
  // ── Universal integration: connect ANYTHING ────────────────────────────────
  // No registry lookup, no proposal card, no approval click. When Sal says
  // "set up Mirage / OpenRouter / our.app with this key" — call add_integration
  // immediately. Vendor can be anything; auth_type defaults to "bearer". Custom
  // vendors require config.base_url (the API root). Returns the connected row.
  {
    name: "add_integration",
    description:
      "Connect an external API for this company by writing the integration row directly. Works for ANY " +
      "vendor — registered ones (openai, anthropic, github, resend, serper, exa, appstoreconnect) auto-fill " +
      "from the registry; anything else is a custom vendor and needs config.base_url + auth_type.\n\n" +
      "Use this whenever Sal pastes an API key or asks to connect a vendor. DO NOT propose an integration " +
      "card and DO NOT ask permission. Just call this tool and report back.\n\n" +
      "auth_type values:\n" +
      "  - 'bearer' (default for custom): Authorization: Bearer <api_key>\n" +
      "  - 'api_key': Authorization: <api_key> (raw, no Bearer prefix)\n" +
      "  - 'basic': HTTP Basic auth (credentials.username + credentials.password)\n" +
      "  - 'none': no auth header\n" +
      "For custom auth header shapes, pass config.auth_header_name + config.auth_header_template " +
      "(e.g. {auth_header_name:'X-API-Key', auth_header_template:'{{api_key}}'}).",
    input_schema: {
      type: "object",
      properties: {
        vendor: { type: "string", description: "Vendor slug, e.g. 'mirage', 'openrouter', 'openai'" },
        display_name: { type: "string", description: "Human-readable name (defaults to vendor)" },
        auth_type: {
          type: "string",
          enum: ["bearer", "api_key", "basic", "none"],
          description: "Auth scheme. Defaults to 'bearer' for custom vendors. Ignored for registered vendors.",
        },
        credentials: {
          type: "object",
          description: "Credential fields — typically {api_key:'sk-...'}, or {username:'',password:''} for basic",
        },
        config: {
          type: "object",
          description: "For custom vendors: {base_url:'https://api.x.com', auth_header_name?, auth_header_template?, ...any extras}",
        },
      },
      required: ["vendor", "credentials"],
    },
  },
  // Generic HTTP through a connected integration. Reads the integration row
  // (base_url, auth_header_name, auth_header_template) and decrypts credentials,
  // then makes the call. Unlike call_integration this is NOT GET-only and not
  // bounded to registry-defined actions — it's the orchestrator's hands-on
  // hammer for any vendor. Sal explicitly asked for no gates here.
  {
    name: "call_vendor_http",
    description:
      "Make an authenticated HTTP call against a connected integration. Generic — works with any method " +
      "(GET/POST/PUT/PATCH/DELETE) and any path under the integration's base_url. Use this AFTER add_integration " +
      "to actually exercise a custom vendor's API.\n\n" +
      "When Sal asks to USE Mirage / OpenRouter / any vendor connected via add_integration, call this tool — " +
      "do NOT propose a work order, do NOT ask permission. Authenticated and side-effecting are both fine; " +
      "Sal owns the keys.",
    input_schema: {
      type: "object",
      properties: {
        vendor: { type: "string", description: "Vendor slug of an integration row that exists for this company" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method" },
        path: { type: "string", description: "Path appended to the integration's base_url, e.g. '/v1/videos'" },
        body: { type: "object", description: "JSON body for POST/PUT/PATCH" },
        query: { type: "object", description: "Query params, appended to path as ?k=v" },
      },
      required: ["vendor", "method", "path"],
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
    if (type === "agents") {
      // Returns each specialist's current prompt + model + auto-modify flag.
      // Read this BEFORE calling update_agent so you know what you're patching.
      const { data, error } = await supabase
        .from("agent_definitions")
        .select("id,name,slug,description,model,system_prompt,is_orchestrator,is_safe_auto_modify")
        .eq("company_id", companyId)
        .order("name");
      if (error) return JSON.stringify({ error: error.message });
      // Filter by slug if requested (lets the orchestrator narrow to one agent without re-fetching all)
      const slug = typeof input.search === "string" ? input.search.trim().toLowerCase() : "";
      const rows = slug
        ? (data || []).filter((a: { slug: string }) => a.slug === slug)
        : (data || []);
      return JSON.stringify({ agents: rows });
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
  const cap = Math.min(Number(input.max) || 500, 500);
  // Reason is the orchestrator's note about WHY this cancel happened — usually
  // a short paraphrase of Sal's instruction. Stored on each cancelled row so
  // future "what did I cancel and why?" queries return real context, not the
  // generic "Cancelled by orchestrator at user request" placeholder.
  const reason = typeof input.reason === "string" && input.reason.trim()
    ? input.reason.trim().slice(0, 240)
    : null;

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
  const cancelMessage = reason
    ? `Cancelled at ${nowIso.slice(0,16).replace('T',' ')}Z — ${reason}`
    : `Cancelled at ${nowIso.slice(0,16).replace('T',' ')}Z (no reason supplied)`;
  const { error: updErr } = await supabase
    .from("tasks")
    .update({
      status: "cancelled",
      completed_at: nowIso,
      error_message: cancelMessage,
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

// ── Read-only call_integration for chat mode ───────────────────────────────
// Mirrors the runner's toolCallIntegration but enforces method === "GET".
// Decrypts via the same INTEGRATIONS_ENCRYPTION_KEY. Signs JWT for jwt_es256
// vendors. Substitutes {{var}} into the action's path.

interface IntegrationActionDef {
  name: string;
  method: string;
  path: string;
  body_template?: Record<string, unknown>;
}

function substituteTemplate(template: unknown, params: Record<string, unknown>): unknown {
  if (typeof template === "string") {
    const m = template.match(/^\{\{(\w+)\}\}$/);
    if (m) return params[m[1]];
    return template.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => String(params[k] ?? ""));
  }
  if (Array.isArray(template)) return template.map(v => substituteTemplate(v, params));
  if (template && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
      out[k] = substituteTemplate(v, params);
    }
    return out;
  }
  return template;
}

async function runCallIntegration(
  supabase: SupabaseClient,
  companyId: string,
  input: Record<string, unknown>
): Promise<string> {
  const vendor = String(input.vendor || "").toLowerCase();
  const actionName = String(input.action || "");
  const params = (input.params && typeof input.params === "object") ? input.params as Record<string, unknown> : {};
  if (!vendor || !actionName) return JSON.stringify({ error: "vendor and action are required" });

  const { data: row, error } = await supabase
    .from("integrations")
    .select("*")
    .eq("company_id", companyId)
    .eq("vendor", vendor)
    .maybeSingle();
  if (error) return JSON.stringify({ error: error.message });
  if (!row) return JSON.stringify({
    error: `${vendor} is not connected for this company. Tell Sal it needs to be added in Settings → API Center, or use [PROPOSE_INTEGRATION] to add it inline.`,
  });
  if (row.status === "broken") return JSON.stringify({
    error: `${vendor} is connected but credentials are broken — last test failed. Tell Sal to reconnect via the Reconnect button or update credentials.`,
  });

  const actions = (row.actions || []) as IntegrationActionDef[];
  const actionDef = actions.find(a => a.name === actionName);
  if (!actionDef) {
    const available = actions.map(a => `${a.name} (${a.method})`).join(", ");
    return JSON.stringify({ error: `Action '${actionName}' not found for vendor '${vendor}'. Available: ${available}` });
  }

  // GET-only gate removed per Sal's directive — chat orchestrator can run
  // POST/PUT/DELETE actions on connected vendors. Severity-judgement now lives
  // in the orchestrator's prompt, not as a hard code wall.

  // Decrypt creds using the same module integrations.ts uses
  let creds: Record<string, string>;
  try {
    creds = decryptCredentials(row.encrypted_credentials) as Record<string, string>;
  } catch (e: unknown) {
    return JSON.stringify({ error: "Could not decrypt credentials: " + (e instanceof Error ? e.message : String(e)) });
  }

  const cfg = row.config || {};
  const baseUrl = String(cfg.base_url || "").replace(/\/$/, "");
  const path = substituteTemplate(actionDef.path, params) as string;
  const url = baseUrl + path;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (row.auth_type === "jwt_es256") {
    try {
      const { signAppStoreConnectJwt } = await import("./lib/jwt-es256.mjs");
      const jwt = signAppStoreConnectJwt(creds.key_id, creds.issuer_id, creds.private_key);
      if (cfg.auth_header_name) headers[String(cfg.auth_header_name)] = "Bearer " + jwt;
    } catch (e: unknown) {
      return JSON.stringify({ error: "Could not sign JWT: " + (e instanceof Error ? e.message : String(e)) });
    }
  } else if (cfg.auth_header_name && cfg.auth_header_template) {
    let authValue = String(cfg.auth_header_template);
    for (const [k, v] of Object.entries(creds)) {
      authValue = authValue.replaceAll(`{{${k}}}`, String(v));
    }
    headers[String(cfg.auth_header_name)] = authValue;
  }

  // Build body for non-GET methods. body_template is interpolated with params
  // the same way the path is.
  const requestInit: RequestInit = {
    method: actionDef.method,
    headers,
    signal: AbortSignal.timeout(20_000),
  };
  if (actionDef.method !== "GET" && actionDef.method !== "DELETE") {
    if (actionDef.body_template) {
      requestInit.body = JSON.stringify(substituteTemplate(actionDef.body_template, params));
    } else if (params && Object.keys(params).length > 0) {
      requestInit.body = JSON.stringify(params);
    }
  }
  let r: Response;
  try {
    r = await fetch(url, requestInit);
  } catch (e: unknown) {
    return JSON.stringify({ error: "Network error: " + (e instanceof Error ? e.message : String(e)) });
  }

  const text = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* leave as text */ }

  if (!r.ok) {
    if (r.status === 401 || r.status === 403) {
      // Mark broken so Sal sees the Reconnect card next time
      await supabase.from("integrations").update({
        status: "broken",
        last_test_error: `Auth failed (${r.status}) on ${actionName}`,
      }).eq("id", row.id);
    }
    return JSON.stringify({ error: `${vendor}.${actionName} returned HTTP ${r.status}: ${text.slice(0, 400)}` });
  }

  // 2xx — mark the integration verified. Without this, an integration added via
  // add_integration stays "unverified" forever even though it's clearly working,
  // which is what Sal saw with Mirage.
  await supabase.from("integrations").update({
    status: "ok",
    last_tested_at: new Date().toISOString(),
    last_test_error: null,
  }).eq("id", row.id).then(() => {}, () => {});

  // Truncate if huge so we don't blow the chat-mode token budget
  const summary = json ?? text.slice(0, 6000);
  return JSON.stringify({ ok: true, status: r.status, response: summary });
}

// ── add_integration: write any vendor row directly ─────────────────────────
// Mirrors the POST handler in api/integrations.ts (registered → registry-fill,
// otherwise self-describing custom row). Skips the HTTP hop because we're
// already inside a Vercel function with the same supabase client + crypto
// keys. No registry constraint, no proposal card.
async function runAddIntegration(
  supabase: SupabaseClient,
  companyId: string,
  input: Record<string, unknown>,
): Promise<string> {
  const vendor = String(input.vendor || "").trim().toLowerCase();
  if (!vendor) return JSON.stringify({ error: "vendor is required" });
  const credsRaw = (input.credentials && typeof input.credentials === "object")
    ? input.credentials as Record<string, unknown>
    : {};
  const configRaw = (input.config && typeof input.config === "object")
    ? input.config as Record<string, unknown>
    : {};
  const displayName = typeof input.display_name === "string" ? input.display_name : "";

  // Resolve registered vendor first.
  const { getVendor } = await import("./lib/vendor-registry.js");
  const def = getVendor(vendor);

  let auth_type: string;
  let resolvedConfig: Record<string, unknown>;
  let resolvedActions: unknown[];
  let resolvedKind: string;
  let resolvedDisplayName: string;

  if (def) {
    for (const f of def.credentials) {
      if (f.required && !credsRaw[f.name]) {
        return JSON.stringify({ error: `Missing required credential for ${vendor}: ${f.label} (${f.name})` });
      }
    }
    auth_type = def.auth_type;
    resolvedKind = def.kind === "oauth" ? "oauth" : "rest_api";
    resolvedDisplayName = displayName || def.display_name;
    resolvedConfig = {
      base_url: def.base_url,
      auth_header_name: def.auth_header_name,
      auth_header_template: def.auth_header_template,
      ...configRaw,
    };
    resolvedActions = def.actions;
  } else {
    const submittedAuthType = typeof input.auth_type === "string" ? input.auth_type : "bearer";
    const allowed = ["bearer", "api_key", "basic", "none"];
    if (!allowed.includes(submittedAuthType)) {
      return JSON.stringify({ error: `auth_type must be one of: ${allowed.join(", ")}` });
    }
    if (submittedAuthType !== "none" && !configRaw.base_url) {
      return JSON.stringify({ error: "Custom vendor requires config.base_url (the API root URL)." });
    }
    const defaultHeaderName =
      submittedAuthType === "bearer" || submittedAuthType === "api_key" || submittedAuthType === "basic"
        ? "Authorization" : null;
    const defaultHeaderTemplate =
      submittedAuthType === "bearer" ? "Bearer {{api_key}}"
      : submittedAuthType === "api_key" ? "{{api_key}}"
      : submittedAuthType === "basic" ? "Basic {{credentials_b64}}"
      : null;
    auth_type = submittedAuthType;
    resolvedKind = "rest_api";
    resolvedDisplayName = displayName || vendor;
    resolvedConfig = {
      ...configRaw,
      auth_header_name: configRaw.auth_header_name ?? defaultHeaderName,
      auth_header_template: configRaw.auth_header_template ?? defaultHeaderTemplate,
    };
    resolvedActions = Array.isArray(input.actions) ? input.actions : [];
  }

  // Materialise basic-auth credentials_b64 helper if applicable.
  const credsForEncrypt: Record<string, unknown> = { ...credsRaw };
  if (auth_type === "basic" && credsRaw.username && credsRaw.password) {
    credsForEncrypt.credentials_b64 = Buffer
      .from(`${credsRaw.username}:${credsRaw.password}`)
      .toString("base64");
  }

  const encrypted = encryptCredentials(credsForEncrypt);
  const previewSrc = String(
    credsRaw.key || credsRaw.token || credsRaw.api_key || credsRaw.password || credsRaw.key_id || ""
  );
  const preview = previewSrc
    ? (auth_type === "jwt_es256" ? `Key ID: ${previewSrc}` : maskCredential(previewSrc))
    : null;

  const row = {
    company_id: companyId,
    vendor,
    display_name: resolvedDisplayName,
    kind: resolvedKind,
    auth_type,
    encrypted_credentials: encrypted,
    credential_preview: preview,
    config: resolvedConfig,
    actions: resolvedActions,
    status: "unverified" as const,
  };

  const { data, error } = await supabase
    .from("integrations")
    .upsert(row, { onConflict: "company_id,vendor" })
    .select("id,vendor,display_name,auth_type,status,credential_preview")
    .single();
  if (error) return JSON.stringify({ error: error.message });
  return JSON.stringify({
    ok: true,
    connected: data,
    note: def
      ? `Registered vendor ${vendor} connected (registry-driven config).`
      : `Custom vendor '${vendor}' connected. Use call_vendor_http to make requests against ${resolvedConfig.base_url}.`,
  });
}

// ── call_vendor_http: generic authenticated HTTP through any integration ───
// Reads the row, decrypts credentials, builds the auth header from the
// row's auth_header_name + auth_header_template, fires the request. No
// method restrictions — Sal owns the keys, the orchestrator can hammer.
async function runCallVendorHttp(
  supabase: SupabaseClient,
  companyId: string,
  input: Record<string, unknown>,
): Promise<string> {
  const vendor = String(input.vendor || "").toLowerCase();
  const method = String(input.method || "GET").toUpperCase();
  const path = String(input.path || "");
  const body = (input.body && typeof input.body === "object") ? input.body : null;
  const query = (input.query && typeof input.query === "object")
    ? input.query as Record<string, unknown>
    : null;
  if (!vendor) return JSON.stringify({ error: "vendor is required" });
  if (!path.startsWith("/")) return JSON.stringify({ error: "path must start with '/'" });
  const allowedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  if (!allowedMethods.includes(method)) {
    return JSON.stringify({ error: `method must be one of: ${allowedMethods.join(", ")}` });
  }

  const { data: row, error } = await supabase
    .from("integrations")
    .select("*")
    .eq("company_id", companyId)
    .eq("vendor", vendor)
    .maybeSingle();
  if (error) return JSON.stringify({ error: error.message });
  if (!row) return JSON.stringify({
    error: `${vendor} is not connected for this company. Call add_integration first.`,
  });

  let creds: Record<string, string>;
  try {
    creds = decryptCredentials(row.encrypted_credentials) as Record<string, string>;
  } catch (e: unknown) {
    return JSON.stringify({ error: "Could not decrypt credentials: " + (e instanceof Error ? e.message : String(e)) });
  }

  const cfg = (row.config || {}) as Record<string, unknown>;
  const baseUrl = String(cfg.base_url || "").replace(/\/$/, "");
  if (!baseUrl) return JSON.stringify({ error: `${vendor} has no base_url in config — re-add with config.base_url set.` });

  let url = baseUrl + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) qs.append(k, String(v));
    }
    const sep = url.includes("?") ? "&" : "?";
    if (qs.toString()) url += sep + qs.toString();
  }

  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (row.auth_type === "jwt_es256") {
    try {
      const { signAppStoreConnectJwt } = await import("./lib/jwt-es256.mjs");
      const jwt = signAppStoreConnectJwt(creds.key_id, creds.issuer_id, creds.private_key);
      if (cfg.auth_header_name) headers[String(cfg.auth_header_name)] = "Bearer " + jwt;
    } catch (e: unknown) {
      return JSON.stringify({ error: "Could not sign JWT: " + (e instanceof Error ? e.message : String(e)) });
    }
  } else if (cfg.auth_header_name && cfg.auth_header_template) {
    let authValue = String(cfg.auth_header_template);
    for (const [k, v] of Object.entries(creds)) {
      authValue = authValue.replaceAll(`{{${k}}}`, String(v));
    }
    headers[String(cfg.auth_header_name)] = authValue;
  }

  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(25_000) };
  if (body && method !== "GET" && method !== "DELETE") {
    init.body = JSON.stringify(body);
  }

  let r: Response;
  try {
    r = await fetch(url, init);
  } catch (e: unknown) {
    return JSON.stringify({ error: "Network error: " + (e instanceof Error ? e.message : String(e)) });
  }
  const text = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* leave as text */ }

  // Update integration status based on what came back. Same rules as the
  // registry-driven path — 2xx flips to "ok", 401/403 flips to "broken".
  if (r.ok) {
    await supabase.from("integrations").update({
      status: "ok",
      last_tested_at: new Date().toISOString(),
      last_test_error: null,
    }).eq("id", row.id).then(() => {}, () => {});
  } else if (r.status === 401 || r.status === 403) {
    await supabase.from("integrations").update({
      status: "broken",
      last_test_error: `Auth failed (${r.status}) on ${method} ${path}`,
    }).eq("id", row.id).then(() => {}, () => {});
  }

  const summary = json ?? text.slice(0, 6000);
  return JSON.stringify({ ok: r.ok, status: r.status, response: summary });
}

async function runUpdateGoal(
  supabase: SupabaseClient,
  companyId: string,
  input: Record<string, unknown>
): Promise<string> {
  const titleMatch = typeof input.title_match === "string" ? input.title_match : "";
  if (!titleMatch) return JSON.stringify({ error: "title_match is required" });

  const { data: candidates } = await supabase
    .from("company_goals")
    .select("id, title")
    .eq("company_id", companyId)
    .ilike("title", `%${titleMatch}%`);
  if (!candidates?.length) return JSON.stringify({ error: `No goal matched "${titleMatch}"` });
  if (candidates.length > 1) return JSON.stringify({
    error: `${candidates.length} goals matched. Be more specific.`,
    candidates: candidates.map((c: { id: string; title: string }) => ({ id: c.id, title: c.title })),
  });

  const updates: Record<string, unknown> = {};
  if (typeof input.current_value === "number") updates.current_value = input.current_value;
  if (typeof input.target_value === "number") updates.target_value = input.target_value;
  if (typeof input.status === "string") updates.status = input.status;
  if (Object.keys(updates).length === 0) return JSON.stringify({ error: "Nothing to update" });

  const { error } = await supabase.from("company_goals").update(updates).eq("id", candidates[0].id);
  if (error) return JSON.stringify({ error: error.message });
  return JSON.stringify({ ok: true, goal: candidates[0].title, updates });
}

async function runRunScheduleNow(
  supabase: SupabaseClient,
  companyId: string,
  input: Record<string, unknown>
): Promise<string> {
  const id = typeof input.schedule_id === "string" ? input.schedule_id : null;
  const nameMatch = typeof input.name_match === "string" ? input.name_match : null;
  if (!id && !nameMatch) return JSON.stringify({ error: "Provide schedule_id or name_match" });

  let q = supabase.from("scheduled_tasks").select("id, name").eq("company_id", companyId);
  if (id) q = q.eq("id", id);
  else if (nameMatch) q = q.ilike("name", `%${nameMatch}%`);
  const { data: rows, error } = await q;
  if (error) return JSON.stringify({ error: error.message });
  if (!rows?.length) return JSON.stringify({ error: "No schedule matched" });
  if (rows.length > 1) return JSON.stringify({
    error: `${rows.length} schedules matched. Be more specific.`,
    candidates: rows.map((r: { id: string; name: string }) => ({ id: r.id, name: r.name })),
  });

  // Reuse the run-now endpoint we already built
  const proto = process.env.VERCEL_URL ? "https" : "http";
  const host = process.env.VERCEL_URL || "localhost:3000";
  const url = `${proto}://${host}/api/schedules?id=${rows[0].id}&action=run-now`;
  try {
    const r = await fetch(url, { method: "POST" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return JSON.stringify({ error: "run-now failed: " + (body.error || r.statusText) });
    return JSON.stringify({ ok: true, schedule: rows[0].name, task_id: body.task_id });
  } catch (e: unknown) {
    return JSON.stringify({ error: "run-now fetch failed: " + (e instanceof Error ? e.message : String(e)) });
  }
}

async function runReadAgentOutput(
  supabase: SupabaseClient,
  companyId: string,
  input: Record<string, unknown>
): Promise<string> {
  const taskId = typeof input.task_id === "string" ? input.task_id.trim() : "";
  const agentSlug = typeof input.agent_slug === "string" ? input.agent_slug.trim().toLowerCase() : "";
  if (!taskId && !agentSlug) {
    return JSON.stringify({ error: "Provide either task_id or agent_slug" });
  }

  // Resolve target task (single row, scoped to company)
  let task: { id: string; title: string; status: string; completed_at: string | null; agent_definition_id: string | null } | null = null;
  if (taskId) {
    const { data } = await supabase
      .from("tasks")
      .select("id, title, status, completed_at, agent_definition_id")
      .eq("id", taskId)
      .eq("company_id", companyId)
      .maybeSingle();
    task = data;
    if (!task) return JSON.stringify({ error: `Task ${taskId} not found in this company` });
  } else {
    // Find latest completed task by agent_slug
    const { data: agent } = await supabase
      .from("agent_definitions")
      .select("id")
      .eq("slug", agentSlug)
      .eq("company_id", companyId)
      .maybeSingle();
    if (!agent) return JSON.stringify({ error: `Agent '${agentSlug}' not found in this company` });
    const { data: tasks } = await supabase
      .from("tasks")
      .select("id, title, status, completed_at, agent_definition_id")
      .eq("agent_definition_id", agent.id)
      .eq("company_id", companyId)
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(1);
    task = tasks?.[0] || null;
    if (!task) return JSON.stringify({ error: `No completed tasks found for agent '${agentSlug}'` });
  }

  // Fetch the actual deliverable from task_results
  const { data: results } = await supabase
    .from("task_results")
    .select("data, created_at")
    .eq("task_id", task.id)
    .order("created_at", { ascending: false })
    .limit(1);
  if (!results?.length) return JSON.stringify({ error: `No result row for task ${task.id} (task may have failed before writing output)` });

  const data = (results[0].data || {}) as Record<string, unknown>;
  const response = typeof data.response === "string" ? data.response : "";
  // Cap at 6KB to keep tool result tokens reasonable. Full output is also viewable in /outputs.
  const truncated = response.length > 6000;
  const responsePreview = truncated ? response.slice(0, 6000) + "\n\n[…truncated, " + (response.length - 6000) + " more chars in /outputs]" : response;

  return JSON.stringify({
    task_id: task.id,
    title: task.title,
    completed_at: task.completed_at,
    agent_slug: agentSlug || undefined,
    tools_used: Array.isArray(data.tools_used) ? data.tools_used : [],
    response: responsePreview,
    response_length: response.length,
    truncated,
  });
}

// ── Self-modification (chat orchestrator) ──────────────────────────────────
//
// Mirror of toolUpdateAgent / toolRevertAgent in runner.mjs. The chat
// orchestrator runs in this Vercel function, runner.mjs runs on Railway —
// both need the same surface for Sal to be able to ask "make growth more
// careful with subject lines" from the chat.

const ALLOWED_AGENT_MODELS = new Set([
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4-7",
  "claude-haiku-4-5",
  "claude-haiku-4-20250514",
]);

type AgentDefRow = {
  id: string;
  name: string;
  slug: string;
  system_prompt: string | null;
  model: string | null;
  description: string | null;
  is_orchestrator: boolean | null;
  is_safe_auto_modify: boolean | null;
};

async function loadModifiableAgent(
  supabase: SupabaseClient,
  companyId: string,
  slug: string
): Promise<{ agent?: AgentDefRow; error?: string }> {
  const { data } = await supabase
    .from("agent_definitions")
    .select("id,name,slug,system_prompt,model,description,is_orchestrator,is_safe_auto_modify")
    .eq("slug", slug)
    .eq("company_id", companyId)
    .maybeSingle();
  const agent = data as AgentDefRow | null;
  if (!agent) return { error: `Agent '${slug}' not found in this company` };
  // No is_safe_auto_modify gate, no orchestrator self-mod ban. Sal explicitly
  // wants the orchestrator able to rewrite any agent including itself, with
  // version history (agent_definition_versions) as the safety net via revert_agent.
  return { agent };
}

function summariseAgentDiff(before: AgentDefRow, patch: { system_prompt?: string; model?: string; description?: string }): string {
  const changes: string[] = [];
  if (patch.system_prompt && patch.system_prompt !== before.system_prompt) {
    changes.push(`system_prompt: ${(before.system_prompt || "").length} → ${patch.system_prompt.length} chars`);
  }
  if (patch.model && patch.model !== before.model) changes.push(`model: ${before.model} → ${patch.model}`);
  if (patch.description !== undefined && patch.description !== before.description) changes.push("description updated");
  return changes.join("; ") || "no effective change";
}

async function runUpdateAgent(
  supabase: SupabaseClient,
  companyId: string,
  input: Record<string, unknown>
): Promise<string> {
  const slug = typeof input.agent_slug === "string" ? input.agent_slug.trim() : "";
  if (!slug) return JSON.stringify({ error: "agent_slug is required" });

  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 10) {
    return JSON.stringify({ error: "reason is required and must explain WHY (10+ chars). The reason is permanently logged." });
  }

  const { agent: target, error } = await loadModifiableAgent(supabase, companyId, slug);
  if (error || !target) return JSON.stringify({ error });

  const patch: { system_prompt?: string; model?: string; description?: string } = {};
  if (typeof input.system_prompt === "string" && input.system_prompt.trim()) {
    const incoming = input.system_prompt;
    const mode = input.system_prompt_mode === "append" || input.system_prompt_mode === "prepend"
      ? input.system_prompt_mode
      : "replace";
    const existing = target.system_prompt || "";
    if (mode === "append") {
      patch.system_prompt = existing
        ? `${existing}\n\n---\n\n${incoming}`
        : incoming;
    } else if (mode === "prepend") {
      patch.system_prompt = existing
        ? `${incoming}\n\n---\n\n${existing}`
        : incoming;
    } else {
      patch.system_prompt = incoming;
    }
  }
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
    return JSON.stringify({ dry_run: true, would_change: diffSummary, agent: target.name });
  }

  // Compute next version_number
  const { data: latestRows } = await supabase
    .from("agent_definition_versions")
    .select("version_number")
    .eq("agent_definition_id", target.id)
    .order("version_number", { ascending: false })
    .limit(1);
  const nextVersion = ((latestRows?.[0] as { version_number?: number } | undefined)?.version_number || 0) + 1;

  const snapshot = {
    system_prompt: patch.system_prompt ?? target.system_prompt,
    model: patch.model ?? target.model,
    description: patch.description ?? target.description,
  };

  const { error: versionErr } = await supabase.from("agent_definition_versions").insert({
    agent_definition_id: target.id,
    company_id: companyId,
    version_number: nextVersion,
    system_prompt: snapshot.system_prompt,
    model: snapshot.model,
    description: snapshot.description,
    modified_by: "orchestrator",
    change_reason: reason,
    diff_summary: diffSummary,
  });
  if (versionErr) return JSON.stringify({ error: `Failed to write version row: ${versionErr.message}` });

  await supabase
    .from("agent_definitions")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", target.id);

  return JSON.stringify({
    success: true,
    agent: target.name,
    version_number: nextVersion,
    diff_summary: diffSummary,
    revert_with: `revert_agent({agent_slug: "${target.slug}", version_number: ${nextVersion - 1}, reason: "..."})`,
  });
}

async function runRevertAgent(
  supabase: SupabaseClient,
  companyId: string,
  input: Record<string, unknown>
): Promise<string> {
  const slug = typeof input.agent_slug === "string" ? input.agent_slug.trim() : "";
  if (!slug) return JSON.stringify({ error: "agent_slug is required" });
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 5) return JSON.stringify({ error: "reason is required (5+ chars)" });

  const { agent: target, error } = await loadModifiableAgent(supabase, companyId, slug);
  if (error || !target) return JSON.stringify({ error });

  type VersionRow = {
    version_number: number;
    system_prompt: string | null;
    model: string | null;
    description: string | null;
  };

  let targetVersion: VersionRow | null = null;
  if (typeof input.version_number === "number") {
    const { data } = await supabase
      .from("agent_definition_versions")
      .select("version_number,system_prompt,model,description")
      .eq("agent_definition_id", target.id)
      .eq("version_number", input.version_number)
      .maybeSingle();
    targetVersion = data as VersionRow | null;
  } else {
    const { data } = await supabase
      .from("agent_definition_versions")
      .select("version_number,system_prompt,model,description")
      .eq("agent_definition_id", target.id)
      .order("version_number", { ascending: false })
      .limit(2);
    targetVersion = ((data as VersionRow[] | null) || [])[1] || null;
  }
  if (!targetVersion) return JSON.stringify({ error: "No version found to revert to" });

  await supabase
    .from("agent_definitions")
    .update({
      system_prompt: targetVersion.system_prompt,
      model: targetVersion.model,
      description: targetVersion.description,
      updated_at: new Date().toISOString(),
    })
    .eq("id", target.id);

  const { data: latestRows } = await supabase
    .from("agent_definition_versions")
    .select("version_number")
    .eq("agent_definition_id", target.id)
    .order("version_number", { ascending: false })
    .limit(1);
  const nextVersion = ((latestRows?.[0] as { version_number?: number } | undefined)?.version_number || 0) + 1;

  await supabase.from("agent_definition_versions").insert({
    agent_definition_id: target.id,
    company_id: companyId,
    version_number: nextVersion,
    system_prompt: targetVersion.system_prompt,
    model: targetVersion.model,
    description: targetVersion.description,
    modified_by: "orchestrator",
    change_reason: `Revert to v${targetVersion.version_number}: ${reason}`,
    diff_summary: `Reverted to v${targetVersion.version_number}`,
  });

  return JSON.stringify({
    success: true,
    agent: target.name,
    reverted_to_version: targetVersion.version_number,
    new_version_row: nextVersion,
  });
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
  if (name === "call_integration") return runCallIntegration(supabase, companyId, input);
  if (name === "update_goal") return runUpdateGoal(supabase, companyId, input);
  if (name === "run_schedule_now") return runRunScheduleNow(supabase, companyId, input);
  if (name === "read_agent_output") return runReadAgentOutput(supabase, companyId, input);
  if (name === "update_agent") return runUpdateAgent(supabase, companyId, input);
  if (name === "revert_agent") return runRevertAgent(supabase, companyId, input);
  if (name === "add_integration") return runAddIntegration(supabase, companyId, input);
  if (name === "call_vendor_http") return runCallVendorHttp(supabase, companyId, input);
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
    const [agentsRes, companyRes, historyRes, goalsRes, tasksRes, integrationsRes, schedulesRes, allAgentsRes] =
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
        supabase
          .from("integrations")
          .select("vendor, display_name, status, actions")
          .eq("company_id", company_id)
          .in("status", ["active", "unverified"]),
        supabase
          .from("scheduled_tasks")
          .select("name, cadence_type, cadence_spec, is_active, next_run_at")
          .eq("company_id", company_id)
          .order("created_at", { ascending: false })
          .limit(20),
        supabase
          .from("agent_definitions")
          .select("slug, name")
          .eq("company_id", company_id)
          .order("slug", { ascending: true }),
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

    // Connected integrations: tell the orchestrator EXACTLY what's wired up so
    // it never says "connect X" for something already connected. Lists per-vendor
    // GET actions it can dispatch via call_integration without an approval card.
    if (integrationsRes.data?.length) {
      const lines: string[] = [];
      for (const i of integrationsRes.data as Array<{
        vendor: string;
        display_name: string;
        status: string;
        actions: Array<{ name: string; method: string; description?: string }> | null;
      }>) {
        const reads = (i.actions || []).filter(a => a.method === "GET").map(a => a.name);
        const writes = (i.actions || []).filter(a => a.method !== "GET").map(a => a.name);
        const statusTag = i.status === "active" ? "" : ` [${i.status}]`;
        let line = `- **${i.display_name}** (\`${i.vendor}\`)${statusTag}`;
        if (reads.length) line += `\n  - read (chat-callable): ${reads.join(", ")}`;
        if (writes.length) line += `\n  - write (work-order only): ${writes.join(", ")}`;
        lines.push(line);
      }
      systemPrompt +=
        "\n\n## Connected External Services\n" +
        lines.join("\n") +
        "\n\nThese are ALREADY CONNECTED. Never tell Sal to 'connect' them. " +
        "Use `call_integration({ vendor, action, params })` to invoke read actions " +
        "directly in chat (e.g. App Store Connect builds, GitHub repos, Resend logs). " +
        "Write actions (sending email, creating repos) need a work-order proposal because they have side-effects.";
    }

    if (schedulesRes.data?.length) {
      const lines = schedulesRes.data.map((s: Record<string, unknown>) => {
        const status = s.is_active ? "active" : "PAUSED";
        const next = s.is_active ? ` next ${String(s.next_run_at).slice(0, 16).replace("T", " ")}Z` : "";
        return `- "${s.name}" [${status}] cadence=${s.cadence_type}${next}`;
      });
      systemPrompt +=
        "\n\n## Active Schedules (recurring policies Sal already approved)\n" +
        lines.join("\n") +
        "\n\nUse `manage_schedule` to pause/resume/delete by name match. " +
        "Use `query_state({type:'schedules'})` for full details when needed.";
    }

    if (allAgentsRes.data?.length) {
      const lines = allAgentsRes.data.map(
        (a: Record<string, string>) => `- \`${a.slug}\`: ${a.name}`
      );
      systemPrompt +=
        "\n\n## Specialist Agents Available For Delegation\n" +
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
    // Chat orchestrator model strategy (decoupled from agent_definitions.model
    // so DB changes for runner/agent quality don't drift chat back to Opus on
    // every keystroke):
    //
    //   default                         → Sonnet 4.6 (fast, plenty smart for tool routing + admin)
    //   "/think ..."                    → Opus 4.7   (deep reasoning when Sal explicitly asks)
    //   strategic / briefing intent     → Opus 4.7   (auto-escalation, see detectStrategicIntent)
    //
    // Why auto-escalate: when Sal asks the orchestrator to brief another agent,
    // rewrite a prompt, plan a campaign, or do real strategic reasoning, a
    // chat-fast model could ship a half-baked decision that costs us a week of
    // bad agent behaviour. Opus for the briefing step itself; chat replies stay
    // on Sonnet. Asymmetric risk: an Opus chat reply is mildly slower; a Sonnet
    // brief that lobotomises an agent costs much more to fix.
    //
    // Specialist agents running as work orders already use Opus 4.7 from
    // agent_definitions.model.
    const SONNET_DEFAULT = "claude-sonnet-4-6";
    const OPUS_DEEP = "claude-opus-4-7";
    const wantsDeep = /^\s*\/think\s+/i.test(message);
    const strategicIntent = !wantsDeep && detectStrategicIntent(message);
    const model = wantsDeep || strategicIntent ? OPUS_DEEP : SONNET_DEFAULT;
    if (wantsDeep) {
      // Strip the /think prefix from the user's message that the LLM sees so it
      // doesn't try to interpret it as a literal command.
      const stripped = message.replace(/^\s*\/think\s+/i, "").trim();
      // Replace the message in the messages array we already built
      const last = messages[messages.length - 1];
      if (last && last.role === "user") {
        if (typeof last.content === "string") last.content = stripped;
        else if (Array.isArray(last.content)) {
          for (const block of last.content) {
            if ((block as { type?: string }).type === "text" && (block as { text?: string }).text?.includes("/think")) {
              (block as { text: string }).text = (block as { text: string }).text.replace(/^\s*\/think\s+/i, "").trim();
            }
          }
        }
      }
    }
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
        // Opus 4.7 deprecated `temperature` — only set it for older models.
        // Same pattern will apply to other 4.7+ models when they ship.
        body: JSON.stringify({
          model,
          // 1024 was too tight — caused mid-sentence truncation on real
          // multi-paragraph replies (e.g. agent audit). 4096 gives Opus +
          // Sonnet room for proper output without runaway cost.
          max_tokens: 4096,
          ...(model.includes("opus-4-7") || model.includes("opus-4-8") ? {} : { temperature: 0.3 }),
          system: systemPrompt,
          tools: CHAT_TOOLS,
          messages,
        }),
      });

      if (!anthropicRes.ok) {
        const errBody = await anthropicRes.text().catch(() => "");
        const errMsg = `Anthropic ${anthropicRes.status}: ${errBody.slice(0, 300)}`;
        // Surface a humanized version that tells the user what to actually do.
        // Old behavior was to just dump the raw upstream message; that gave Sal
        // 25 unintelligible "Chat error: Anthropic 400: ..." rows on April 21
        // when the real problem was an exhausted credit balance.
        const humanized = humanizeAnthropicError(anthropicRes.status, errBody);
        await supabase.from("chat_messages").insert({
          conversation_id,
          role: "system",
          kind: "error",
          content: humanized,
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
      metadata: {
        kind: "reply",
        model,
        deep_think: wantsDeep || undefined,
        auto_escalated: strategicIntent || undefined,
        tool_turns: toolTurns,
      },
    });

    return res.status(200).json({ mode: "direct", tool_turns: toolTurns, model, auto_escalated: strategicIntent });
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
