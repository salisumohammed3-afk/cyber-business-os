import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 60;

// Work order proposals are emitted by the orchestrator in this format:
// [PROPOSE_WORK_ORDER]
// { ...JSON conforming to WorkOrderProposal... }
// We match the marker then capture the JSON object that follows. The regex is
// permissive (handles single-line JSON, multi-line JSON, JSON wrapped in code
// fences) — extractJsonAfterMarker() does the heavy lifting.
const WORK_ORDER_MARKER = "[PROPOSE_WORK_ORDER]";

function extractJsonAfterMarker(text: string): { preamble: string; rawJson: string } | null {
  const idx = text.indexOf(WORK_ORDER_MARKER);
  if (idx < 0) return null;
  const preamble = text.slice(0, idx).trim();
  const after = text.slice(idx + WORK_ORDER_MARKER.length);
  // Find the first '{' and the matching last '}' (greedy — assumes proposal is
  // the only top-level object after the marker, which the prompt enforces).
  const firstBrace = after.indexOf("{");
  if (firstBrace < 0) return null;
  const lastBrace = after.lastIndexOf("}");
  if (lastBrace <= firstBrace) return null;
  const rawJson = after.slice(firstBrace, lastBrace + 1);
  return { preamble, rawJson };
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
] as const;

type WorkOrderType = (typeof WORK_ORDER_TYPES)[number];

const AGENT_FOR_TYPE: Record<WorkOrderType, string> = {
  research: "research",
  build_static_site: "engineering",
  edit_project: "engineering",
  send_outreach: "growth",
  design_mockup: "designer",
  meeting_admin: "executive-assistant",
};

// Default cost/time caps. Stage 3 moves these to the runner registry.
const COST_CAP_USD: Record<WorkOrderType, number> = {
  research: 0.5,
  build_static_site: 2.0,
  edit_project: 1.5,
  send_outreach: 0.5,
  design_mockup: 1.0,
  meeting_admin: 0.3,
};

const TIME_CAP_MIN: Record<WorkOrderType, number> = {
  research: 5,
  build_static_site: 15,
  edit_project: 10,
  send_outreach: 5,
  design_mockup: 10,
  meeting_admin: 5,
};

const OUTPUT_TARGET: Record<WorkOrderType, string> = {
  research: "memo",
  build_static_site: "project",
  edit_project: "project",
  send_outreach: "email_draft",
  design_mockup: "mockup_file",
  meeting_admin: "calendar_event",
};

// Tools each work order type requires for preflight checks.
// Composio app names are lowercase (matches Composio API).
const REQUIRED_INTEGRATIONS: Record<WorkOrderType, string[]> = {
  research: [],
  build_static_site: ["github"],
  edit_project: ["github"],
  send_outreach: ["gmail"],
  design_mockup: [],
  meeting_admin: ["googlecalendar"],
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

**Default: answer in this message.** You have tools (\`fetch_url\`, \`query_state\`) to help you answer directly. Only propose a work order when the request genuinely needs minutes of agent execution and tools you don't have access to in chat.

**Answer directly** for:
- Questions, opinions, ideas, status checks, clarifications, pushback
- Quick reviews of a URL — use \`fetch_url\` and reply
- Looking up tasks / memories / goals — use \`query_state\`
- Summaries, recaps, brainstorms — your own knowledge is enough
- Anything conversational

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

If the request is ambiguous, just ask Sal what he means — don't guess and propose.`;

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
    description: "Look up current business state (tasks, memories, or goals) when the user asks about status, history, or what's happening. Returns JSON.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["tasks", "memories", "goals"],
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
    return JSON.stringify({ error: `Unknown type: ${type}` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: msg });
  }
}

async function runChatTool(
  supabase: SupabaseClient,
  companyId: string,
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  if (name === "fetch_url") return runFetchUrl(input);
  if (name === "query_state") return runQueryState(supabase, companyId, input);
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

async function buildPreflight(type: WorkOrderType): Promise<WorkOrderProposal["preflight"]> {
  const required = REQUIRED_INTEGRATIONS[type] || [];
  const checks: WorkOrderProposal["preflight"] = [];
  for (const tool of required) {
    const status = await checkComposioConnected(tool);
    const note =
      status === "missing"
        ? `Connect ${tool} in Integrations before approving.`
        : status === "unknown"
        ? `Could not verify ${tool} connection.`
        : undefined;
    checks.push({ tool, status, note });
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
        preflight: await buildPreflight(type),
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
