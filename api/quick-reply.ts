import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 60;

const DELEGATION_RE = /\[NEEDS_DELEGATION\]/;

// In-memory rate limiter (resets on cold start / redeploy)
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10;

// Tool-use loop cap — chat mode should answer quickly, not do a research project
const MAX_TOOL_TURNS = 3;

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

You're Sal's AI colleague. Talk naturally like a smart teammate — not a chatbot, not a dispatcher.

**Default: answer in this message.** You have tools to help you answer directly. Only delegate when the work genuinely can't fit in a short chat turn.

**Answer directly** (no delegation):
- Questions, opinions, ideas, status checks, pushback, clarifications
- Quick reviews — use \`fetch_url\` to grab a page and tell Sal what you think
- "What's running / what did we do / what are our goals" — use \`query_state\` to check
- Summaries, recaps, brainstorms — your own knowledge is usually enough
- Anything conversational

**Delegate with [NEEDS_DELEGATION]** only when the work requires:
- Multi-step execution across external services (sending emails, building/deploying software, creating Monday boards)
- Deep research that needs multiple scraping rounds (not just reading one URL)
- Producing a substantial deliverable (a report, a designed mockup, a campaign)
- Actions that change the world (outreach, posting, scheduling meetings)

If you're unsure, **just answer**. Sal can always explicitly ask you to delegate.

When delegating, format:
[NEEDS_DELEGATION]
Task title
What specifically needs to be done.

Don't delegate to "make sure the task is tracked" or "analyze this." If you can answer it, answer it.`;

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
        return res.status(502).json({
          error: `Anthropic ${anthropicRes.status}: ${errBody.slice(0, 300)}`,
        });
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

    // ── Delegation detection ────────────────────────────────────────────────
    const delegationMatch = reply.match(DELEGATION_RE);

    if (delegationMatch) {
      const markerIdx = reply.indexOf(delegationMatch[0]);
      const afterMarker = reply.slice(markerIdx + delegationMatch[0].length);
      const afterLines = afterMarker.split("\n").filter(Boolean);
      const taskTitle = afterLines[0]?.trim() || "Respond to user message";
      const taskDescription =
        afterLines.slice(1).join("\n").trim() || message;

      const preamble = reply.slice(0, markerIdx).trim();
      const ackContent = preamble
        ? preamble
        : "I've queued that as a proposed task. You can review and approve it in the task pipeline.";

      const taskInput: Record<string, unknown> = {
        instruction: taskDescription,
        context: message,
      };
      if (attachmentList.length > 0) {
        taskInput.attachments = attachmentList;
      }

      const taskInsert = await supabase
        .from("tasks")
        .insert({
          conversation_id,
          agent_definition_id: orchestrator?.id || null,
          company_id,
          status: "proposed",
          title: taskTitle,
          description: taskDescription,
          input_data: taskInput,
          source: "chat",
        })
        .select("id")
        .single();

      await supabase.from("chat_messages").insert({
        conversation_id,
        role: "assistant",
        content: ackContent,
        timestamp: new Date().toISOString(),
      });

      return res.status(200).json({ mode: "proposed", task_id: taskInsert.data?.id });
    }

    await supabase.from("chat_messages").insert({
      conversation_id,
      role: "assistant",
      content: reply,
      timestamp: new Date().toISOString(),
    });

    return res.status(200).json({ mode: "direct", tool_turns: toolTurns });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("quick-reply error:", msg);
    return res.status(500).json({ error: msg });
  }
}
