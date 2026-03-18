import Anthropic from "@anthropic-ai/sdk";
import { Composio } from "@composio/core";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 60;

// ── SDK type aliases ────────────────────────────────────────────────────────

type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaTool = Anthropic.Beta.Messages.BetaTool;
type BetaToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;
type BetaTextBlock = Anthropic.Beta.Messages.BetaTextBlock;
type BetaMCPToolUseBlock = Anthropic.Beta.Messages.BetaMCPToolUseBlock;
type BetaMCPToolResultBlock = Anthropic.Beta.Messages.BetaMCPToolResultBlock;
type McpServerDef = Anthropic.Beta.Messages.BetaRequestMCPServerURLDefinition;

interface ToolContext {
  conversationId: string;
  parentTaskId: string;
  supabaseUrl: string;
  supabaseKey: string;
  anthropic: Anthropic;
}

// ── Local tool definitions (always available to every agent) ────────────────

function getLocalToolDefs(): BetaTool[] {
  return [
    {
      name: "web_search",
      description: "Search the web for current information. Use for market research, competitor analysis, news, and any real-time data.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "The search query" } },
        required: ["query"],
      },
    },
    {
      name: "database_query",
      description: "Query the business database. Tables: agents, tasks, chat_messages, conversations, metrics, agent_definitions, memories, users. Returns JSON rows.",
      input_schema: {
        type: "object",
        properties: {
          table: { type: "string", description: "Table name to query" },
          select: { type: "string", description: 'Columns to select (default: "*")' },
          filters: {
            type: "array",
            description: "Array of filter objects: { column, operator, value }",
            items: {
              type: "object",
              properties: {
                column: { type: "string" },
                operator: { type: "string" },
                value: { type: "string" },
              },
              required: ["column", "operator", "value"],
            },
          },
          order_by: { type: "string", description: "Column to order by" },
          ascending: { type: "boolean", description: "Sort direction (default: true)" },
          limit: { type: "number", description: "Max rows to return (default: 25)" },
        },
        required: ["table"],
      },
    },
    {
      name: "create_task",
      description: "Propose a new task for an agent. The task enters the pipeline as 'proposed' and requires user approval before execution.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title" },
          description: { type: "string", description: "Detailed task description" },
          agent_slug: { type: "string", description: "Target agent slug: orchestrator, engineering, growth, sales, research, outreach" },
          priority: { type: "number", description: "Priority 0-10 (default: 5)" },
        },
        required: ["title", "description", "agent_slug"],
      },
    },
    {
      name: "store_memory",
      description: "Store an important fact, preference, or insight for future reference. Memories persist across conversations.",
      input_schema: {
        type: "object",
        properties: {
          content: { type: "string", description: "The fact/insight to remember" },
          category: { type: "string", description: "Category: business_context, user_preference, market_intel, decision, contact, metric" },
          importance: { type: "number", description: "Importance 0-10 (default: 5)" },
        },
        required: ["content", "category"],
      },
    },
    {
      name: "recall_memories",
      description: "Search stored memories for relevant context. Use before answering questions about the business, user preferences, or past decisions.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for in memories" },
          category: { type: "string", description: "Optional category filter" },
          limit: { type: "number", description: "Max memories to return (default: 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "delegate_task",
      description: "Propose a task for a specialist sub-agent. The task will appear in the user's task pipeline for approval before execution.",
      input_schema: {
        type: "object",
        properties: {
          agent_slug: { type: "string", description: "Target agent: engineering, growth, sales, research, outreach" },
          instruction: { type: "string", description: "Detailed instruction for the sub-agent" },
          context: { type: "string", description: "Additional context from the current conversation to pass along" },
        },
        required: ["agent_slug", "instruction"],
      },
    },
  ];
}

// ── Agent-specific tool definitions ──────────────────────────────────────────
// Returns extra tools available only to specific agents.

const DESIGNER_AGENT_ID = "5858f260-e794-482f-aead-ae3650e6d4a6";

function getAgentSpecificToolDefs(agentSlug: string): BetaTool[] {
  if (agentSlug === "designer") {
    return [
      {
        name: "design_system_search",
        description:
          "Search the design knowledge base for UI styles, color palettes, typography pairings, industry-specific design rules, landing page patterns, chart recommendations, and UX guidelines. Use this before proposing any design.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query (e.g. 'fintech dashboard', 'glassmorphism', 'serif elegant', 'spa wellness')",
            },
            domain: {
              type: "string",
              enum: ["style", "palette", "typography", "product_rule", "reasoning", "chart", "ux_guideline", "landing_pattern"],
              description: "Narrow search to a specific domain",
            },
          },
          required: ["query"],
        },
      },
    ];
  }
  return [];
}

// ── Composio toolkit lookup from agent_tools table ──────────────────────────
// Returns toolkit slugs (e.g. ["apollo", "gmail"]) for agents that have
// external tool access via Composio.

async function getAgentToolkits(
  supabase: SupabaseClient,
  agentDefId: string
): Promise<string[]> {
  const { data: rows } = await supabase
    .from("agent_tools")
    .select("tool_name")
    .eq("agent_id", agentDefId)
    .eq("is_enabled", true)
    .eq("connection_source", "composio");

  if (!rows || rows.length === 0) return [];
  return rows.map((r: { tool_name: string }) => r.tool_name);
}

// ── Build MCP servers config via Composio SDK ───────────────────────────────
// Creates a Composio Tool Router session scoped to the agent's toolkits,
// then returns the session's MCP URL for Anthropic's MCP connector.

async function buildComposioMcp(
  toolkits: string[]
): Promise<McpServerDef[] | undefined> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey || toolkits.length === 0) return undefined;

  const composio = new Composio({ apiKey });
  const session = await composio.create("ubs_agent", {
    toolkits,
  });

  return [
    {
      type: "url",
      url: session.mcp.url,
      name: "composio",
      authorization_token: apiKey,
    },
  ];
}

// ── Local tool execution ────────────────────────────────────────────────────

async function executeLocalTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  supabase: SupabaseClient,
  context: ToolContext
): Promise<string> {
  switch (toolName) {
    case "web_search":
      return executeWebSearch(toolInput.query as string);
    case "database_query":
      return executeDatabaseQuery(supabase, toolInput);
    case "create_task":
      return executeCreateTask(supabase, toolInput, context);
    case "store_memory":
      return executeStoreMemory(supabase, toolInput);
    case "recall_memories":
      return executeRecallMemories(supabase, toolInput);
    case "delegate_task":
      return executeDelegateTask(supabase, toolInput, context);
    case "design_system_search":
      return executeDesignSystemSearch(supabase, toolInput);
    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

// ── Individual tool implementations ─────────────────────────────────────────

async function executeWebSearch(query: string): Promise<string> {
  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey) {
    return JSON.stringify({
      error: "Web search not configured (SERPER_API_KEY missing)",
      suggestion: "Add SERPER_API_KEY to environment variables. Get one at serper.dev",
    });
  }

  try {
    const resp = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": serperKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 5 }),
    });

    if (!resp.ok) {
      return JSON.stringify({ error: `Search failed: ${resp.status}` });
    }

    const data = await resp.json();
    const results = (data.organic || [])
      .slice(0, 5)
      .map((r: { title: string; snippet: string; link: string }) => `**${r.title}**\n${r.snippet}\n${r.link}`)
      .join("\n\n");

    return results || "No results found.";
  } catch (e) {
    return JSON.stringify({ error: `Search error: ${e instanceof Error ? e.message : "unknown"}` });
  }
}

async function executeDatabaseQuery(supabase: SupabaseClient, input: Record<string, unknown>): Promise<string> {
  try {
    const table = input.table as string;
    const select = (input.select as string) || "*";
    const filters = (input.filters as Array<Record<string, string>>) || [];
    const orderBy = input.order_by as string | undefined;
    const ascending = (input.ascending as boolean) ?? true;
    const limit = (input.limit as number) || 25;

    let query = supabase.from(table).select(select);
    for (const f of filters) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const method = f.operator as string;
      if (typeof (query as any)[method] === "function") {
        query = (query as any)[method](f.column, f.value);
      }
    }
    if (orderBy) query = query.order(orderBy, { ascending });
    query = query.limit(limit);

    const { data, error } = await query;
    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify(data, null, 2);
  } catch (e) {
    return JSON.stringify({ error: `DB query error: ${e instanceof Error ? e.message : "unknown"}` });
  }
}

async function executeCreateTask(
  supabase: SupabaseClient,
  input: Record<string, unknown>,
  context: { conversationId: string; parentTaskId: string }
): Promise<string> {
  try {
    const agentSlug = input.agent_slug as string;
    const { data: agentDef } = await supabase
      .from("agent_definitions")
      .select("id, name")
      .eq("slug", agentSlug)
      .single();

    if (!agentDef) {
      return JSON.stringify({ error: `Agent '${agentSlug}' not found` });
    }

    const { data: task, error } = await supabase
      .from("tasks")
      .insert({
        title: input.title as string,
        description: input.description as string,
        agent_definition_id: agentDef.id,
        conversation_id: context.conversationId,
        parent_task_id: context.parentTaskId,
        priority: (input.priority as number) || 5,
        status: "proposed",
        source: "chat",
      })
      .select("id")
      .single();

    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify({ success: true, task_id: task.id, assigned_to: agentDef.name, status: "proposed", note: "Task proposed — awaiting user approval in the task pipeline." });
  } catch (e) {
    return JSON.stringify({ error: `Create task error: ${e instanceof Error ? e.message : "unknown"}` });
  }
}

async function executeStoreMemory(supabase: SupabaseClient, input: Record<string, unknown>): Promise<string> {
  try {
    const { error } = await supabase.from("memories").insert({
      content: input.content as string,
      category: input.category as string,
      importance: (input.importance as number) || 5,
      user_id: "00000000-0000-0000-0000-000000000000",
      metadata: { source: "agent" },
    });

    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify({ success: true, stored: input.content });
  } catch (e) {
    return JSON.stringify({ error: `Store memory error: ${e instanceof Error ? e.message : "unknown"}` });
  }
}

async function executeRecallMemories(supabase: SupabaseClient, input: Record<string, unknown>): Promise<string> {
  try {
    const query = input.query as string;
    const category = input.category as string | undefined;
    const limit = (input.limit as number) || 10;

    let q = supabase
      .from("memories")
      .select("content, category, importance, created_at")
      .order("importance", { ascending: false })
      .limit(limit);

    if (category) q = q.eq("category", category);
    q = q.ilike("content", `%${query}%`);

    const { data, error } = await q;
    if (error) return JSON.stringify({ error: error.message });
    if (!data || data.length === 0) {
      return JSON.stringify({ memories: [], note: "No matching memories found" });
    }
    return JSON.stringify({ memories: data });
  } catch (e) {
    return JSON.stringify({ error: `Recall error: ${e instanceof Error ? e.message : "unknown"}` });
  }
}

// design_system_search queries the designer agent's knowledge base (loaded from
// UI UX Pro Max skill data: 798 chunks across styles, palettes, typography,
// product rules, reasoning, UX guidelines, charts, and landing patterns).

const DOMAIN_SOURCE_MAP: Record<string, string> = {
  style: "uiux-pro-max/styles",
  palette: "uiux-pro-max/palettes",
  typography: "uiux-pro-max/typography",
  product_rule: "uiux-pro-max/product-rules",
  reasoning: "uiux-pro-max/reasoning",
  chart: "uiux-pro-max/charts",
  ux_guideline: "uiux-pro-max/ux-guidelines",
  landing_pattern: "uiux-pro-max/landing-patterns",
};

async function executeDesignSystemSearch(
  supabase: SupabaseClient,
  input: Record<string, unknown>
): Promise<string> {
  try {
    const query = input.query as string;
    const domain = input.domain as string | undefined;

    let q = supabase
      .from("knowledge_chunks")
      .select("source_name, content")
      .eq("agent_definition_id", DESIGNER_AGENT_ID)
      .eq("source_type", "skill-data")
      .ilike("content", `%${query}%`)
      .limit(10);

    if (domain && DOMAIN_SOURCE_MAP[domain]) {
      q = q.eq("source_name", DOMAIN_SOURCE_MAP[domain]);
    }

    const { data, error } = await q;
    if (error) return JSON.stringify({ error: error.message });
    if (!data || data.length === 0) {
      return JSON.stringify({
        results: [],
        note: `No design data found for "${query}". Try broader keywords.`,
      });
    }
    return JSON.stringify({
      results: data.map((r: { source_name: string; content: string }) => ({
        domain: r.source_name.replace("uiux-pro-max/", ""),
        content: r.content,
      })),
    });
  } catch (e) {
    return JSON.stringify({
      error: `Design search error: ${e instanceof Error ? e.message : "unknown"}`,
    });
  }
}

// delegate_task is non-blocking: creates a pending task for the sub-agent and
// returns immediately. The task gets picked up by a separate runner invocation
// (triggered by the frontend or a cron). This avoids Vercel function timeouts
// since MCP tool calls via Composio can take significant time.

async function executeDelegateTask(
  supabase: SupabaseClient,
  input: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  try {
    const agentSlug = input.agent_slug as string;
    const instruction = input.instruction as string;
    const extraContext = (input.context as string) || "";

    const { data: agentDef } = await supabase
      .from("agent_definitions")
      .select("id, name, slug")
      .eq("slug", agentSlug)
      .single();

    if (!agentDef) {
      return JSON.stringify({ error: `Agent '${agentSlug}' not found. Available: engineering, growth, sales, research, outreach` });
    }

    const { data: childTask, error: taskErr } = await supabase
      .from("tasks")
      .insert({
        title: `Delegated: ${instruction.slice(0, 80)}`,
        description: instruction,
        agent_definition_id: agentDef.id,
        conversation_id: context.conversationId,
        parent_task_id: context.parentTaskId,
        status: "proposed",
        input_data: { instruction, context: extraContext },
        source: "agent",
      })
      .select("id")
      .single();

    if (taskErr) return JSON.stringify({ error: taskErr.message });

    await termLog(supabase, `[${agentDef.slug}] Task proposed: ${instruction.slice(0, 80)}`, {
      taskId: childTask.id, agentSlug: agentDef.slug, logType: "task_proposed",
    });

    return JSON.stringify({
      success: true,
      agent: agentDef.name,
      task_id: childTask.id,
      status: "proposed",
      note: "Task has been proposed and is awaiting user approval. It will appear in the Proposed tab of the task pipeline.",
    });
  } catch (e) {
    return JSON.stringify({ error: `Delegation error: ${e instanceof Error ? e.message : "unknown"}` });
  }
}

// ── Terminal logging ────────────────────────────────────────────────────────

async function termLog(
  supabase: SupabaseClient,
  message: string,
  opts: { source?: string; agentSlug?: string; taskId?: string; logType?: string } = {}
) {
  try {
    await supabase.from("terminal_logs").insert({
      message,
      source: opts.source || "agent-runner",
      agent_slug: opts.agentSlug || null,
      task_id: opts.taskId || null,
      log_type: opts.logType || "info",
    });
  } catch {
    // Non-critical
  }
}

// ── Memory injection ────────────────────────────────────────────────────────

async function getRelevantMemories(supabase: SupabaseClient, userMessage: string): Promise<string> {
  try {
    const keywords = userMessage.split(/\s+/).filter(w => w.length > 3).slice(0, 5);
    if (keywords.length === 0) return "";

    const { data } = await supabase
      .from("memories")
      .select("content, category, importance")
      .order("importance", { ascending: false })
      .limit(10);

    if (!data || data.length === 0) return "";

    const lowerMsg = userMessage.toLowerCase();
    const relevant = data.filter((m: { content: string }) =>
      keywords.some(kw => m.content.toLowerCase().includes(kw.toLowerCase())) ||
      m.content.toLowerCase().split(/\s+/).some((w: string) => lowerMsg.includes(w))
    );

    if (relevant.length === 0) return "";

    return "\n\n## Relevant Memories\n" +
      relevant.map((m: { content: string; category: string }) => `- [${m.category}] ${m.content}`).join("\n");
  } catch {
    return "";
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isToolUseBlock(b: BetaContentBlock): b is BetaToolUseBlock {
  return b.type === "tool_use";
}

function isTextBlock(b: BetaContentBlock): b is BetaTextBlock {
  return b.type === "text";
}

function isMcpToolUseBlock(b: BetaContentBlock): b is BetaMCPToolUseBlock {
  return b.type === "mcp_tool_use";
}

function isMcpToolResultBlock(b: BetaContentBlock): b is BetaMCPToolResultBlock {
  return b.type === "mcp_tool_result";
}

// ── Main handler ────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !supabaseKey)
    return res.status(500).json({ error: "Supabase credentials not configured" });
  if (!anthropicKey)
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const anthropic = new Anthropic({ apiKey: anthropicKey, timeout: 10 * 60 * 1000 });
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { task_id, conversation_id: bodyConvId } = req.body;
    if (!task_id) {
      return res.status(400).json({ error: "task_id is required" });
    }

    // 1. Read the task
    const { data: task, error: taskErr } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", task_id)
      .single();
    if (taskErr)
      return res.status(404).json({ error: `Task not found: ${taskErr.message}` });

    const conversation_id = bodyConvId || task.conversation_id;
    if (!conversation_id) {
      return res.status(400).json({ error: "conversation_id is required (not in body or task record)" });
    }

    await supabase
      .from("tasks")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", task_id);

    let agentSlugForLog = "orchestrator";

    await termLog(supabase, `Task ${task_id.slice(0, 8)} started — loading agent config...`, {
      taskId: task_id, agentSlug: agentSlugForLog, logType: "task_start",
    });

    // 2. Read agent definition
    let systemPrompt =
      "You are the Orchestrator of a Cyber Business Operating System — the CEO's right-hand AI. " +
      "Be direct and concise. Use bullet points for lists. Lead with the headline. Default to action over analysis.";
    let model = "claude-sonnet-4-20250514";
    let temperature = 0.7;
    let maxTurns = 10;
    let agentDefId: string | null = null;

    if (task.agent_definition_id) {
      const { data: agentDef } = await supabase
        .from("agent_definitions")
        .select("*")
        .eq("id", task.agent_definition_id)
        .single();
      if (agentDef) {
        systemPrompt = agentDef.system_prompt || systemPrompt;
        model = agentDef.model || model;
        temperature = parseFloat(agentDef.temperature) || temperature;
        maxTurns = agentDef.max_turns || maxTurns;
        agentDefId = agentDef.id;
        agentSlugForLog = agentDef.slug || agentSlugForLog;

        await termLog(supabase, `Agent loaded: ${agentDef.name} (${agentDef.slug}) — model: ${model}`, {
          taskId: task_id, agentSlug: agentDef.slug, logType: "agent_loaded",
        });
      }
    }

    // 3. Load tools (base local + agent-specific + Composio MCP)
    const localTools = [
      ...getLocalToolDefs(),
      ...getAgentSpecificToolDefs(agentSlugForLog),
    ];
    const composioToolkits = agentDefId ? await getAgentToolkits(supabase, agentDefId) : [];
    let mcpServers: McpServerDef[] | undefined;
    if (composioToolkits.length > 0) {
      try {
        mcpServers = await buildComposioMcp(composioToolkits);
      } catch (mcpErr) {
        await termLog(supabase, `Composio MCP setup failed (${mcpErr instanceof Error ? mcpErr.message : "unknown"}), continuing with local tools only`, {
          taskId: task_id, agentSlug: agentSlugForLog, logType: "error",
        });
      }
    }

    await termLog(supabase, `Loaded ${localTools.length} local tools, ${composioToolkits.length} Composio toolkit(s)${mcpServers ? ` (${composioToolkits.join(", ")})` : " (MCP disabled)"}`, {
      taskId: task_id, agentSlug: agentSlugForLog, logType: "tools_loaded",
    });

    // 4. Read conversation history
    const { data: history } = await supabase
      .from("chat_messages")
      .select("role, content, tool_calls")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: true });

    const messages: BetaMessageParam[] = (history ?? []).map(
      (m: { role: string; content: string }) => ({
        role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
        content: m.content || "",
      })
    );

    await termLog(supabase, `Loaded ${messages.length} messages from conversation history`, {
      taskId: task_id, agentSlug: agentSlugForLog, logType: "context_loaded",
    });

    // 5. Inject relevant memories into system prompt
    const lastUserMsg = messages.filter(m => m.role === "user").pop();
    if (lastUserMsg && typeof lastUserMsg.content === "string") {
      const memoryContext = await getRelevantMemories(supabase, lastUserMsg.content);
      if (memoryContext) {
        systemPrompt += memoryContext;
        await termLog(supabase, `Injected relevant memories into context`, {
          taskId: task_id, agentSlug: agentSlugForLog, logType: "memory_recall",
        });
      }
    }

    // 6. Build context for tool execution
    const toolContext: ToolContext = {
      conversationId: conversation_id,
      parentTaskId: task_id,
      supabaseUrl,
      supabaseKey,
      anthropic,
    };

    // 7. Agentic loop
    let turnCount = 0;
    const allToolCalls: Array<{ tool: string; input: unknown; output: string; source: string }> = [];

    await termLog(supabase, `Starting agentic loop — ${localTools.length} local + ${composioToolkits.length} Composio toolkit(s), max ${maxTurns} turns`, {
      taskId: task_id, agentSlug: agentSlugForLog, logType: "loop_start",
    });

    while (turnCount < maxTurns) {
      turnCount++;

      await termLog(supabase, `Turn ${turnCount}/${maxTurns} — calling ${model}...${mcpServers ? " (with MCP)" : ""}`, {
        taskId: task_id, agentSlug: agentSlugForLog, logType: "llm_call",
      });

      const mcpToolset = mcpServers
        ? [{ type: "mcp_toolset" as const, mcp_server_name: "composio" }]
        : [];

      let response;
      try {
        response = await anthropic.beta.messages.create({
          model,
          max_tokens: 4096,
          temperature,
          system: systemPrompt,
          messages,
          tools: [...localTools, ...mcpToolset],
          ...(mcpServers ? { mcp_servers: mcpServers } : {}),
          ...(mcpServers ? { betas: ["mcp-client-2025-11-20" as const] } : {}),
        });
      } catch (apiErr) {
        if (mcpServers) {
          await termLog(supabase, `Anthropic API error with MCP: ${apiErr instanceof Error ? apiErr.message : "unknown"} — retrying without MCP...`, {
            taskId: task_id, agentSlug: agentSlugForLog, logType: "error",
          });
          mcpServers = undefined;
          response = await anthropic.beta.messages.create({
            model,
            max_tokens: 4096,
            temperature,
            system: systemPrompt,
            messages,
            tools: localTools,
          });
        } else {
          throw apiErr;
        }
      }

      // Log any MCP tool activity (already resolved server-side by Anthropic)
      for (const block of response.content) {
        if (isMcpToolUseBlock(block)) {
          const inputSummary = JSON.stringify(block.input).slice(0, 120);
          await termLog(supabase, `MCP tool: ${block.name} (${block.server_name}) — ${inputSummary}`, {
            taskId: task_id, agentSlug: agentSlugForLog, logType: "tool_call",
          });
          allToolCalls.push({ tool: block.name, input: block.input, output: "(resolved by MCP)", source: "mcp" });
        }
        if (isMcpToolResultBlock(block)) {
          const preview = typeof block.content === "string"
            ? block.content.slice(0, 100)
            : JSON.stringify(block.content).slice(0, 100);
          await termLog(supabase, `MCP result: ${preview}${preview.length >= 100 ? "..." : ""}`, {
            taskId: task_id, agentSlug: agentSlugForLog, logType: "tool_result",
          });
        }
      }

      // Check for local tool calls that need our execution
      const toolUseBlocks = response.content.filter(isToolUseBlock);

      if (response.stop_reason === "tool_use" && toolUseBlocks.length > 0) {
        messages.push({
          role: "assistant",
          content: response.content as unknown as BetaContentBlockParam[],
        });

        const toolResults: BetaContentBlockParam[] = [];
        for (const block of toolUseBlocks) {
          const inputSummary = JSON.stringify(block.input).slice(0, 120);
          await termLog(supabase, `Using tool: ${block.name} — ${inputSummary}`, {
            taskId: task_id, agentSlug: agentSlugForLog, logType: "tool_call",
          });

          const output = await executeLocalTool(
            block.name,
            block.input as Record<string, unknown>,
            supabase,
            toolContext
          );

          const outputPreview = output.slice(0, 100);
          await termLog(supabase, `Tool result (${block.name}): ${outputPreview}${output.length > 100 ? "..." : ""}`, {
            taskId: task_id, agentSlug: agentSlugForLog, logType: "tool_result",
          });

          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: output });
          allToolCalls.push({ tool: block.name, input: block.input, output, source: "local" });
        }

        messages.push({ role: "user", content: toolResults });
        continue;
      }

      // Model is done — extract text response
      const assistantContent =
        response.content
          .filter(isTextBlock)
          .map(b => b.text)
          .join("") || "I received your message but had no response.";

      const { error: insertErr } = await supabase.from("chat_messages").insert({
        conversation_id,
        role: "orchestrator",
        content: assistantContent,
        timestamp: new Date().toISOString(),
        tool_calls: allToolCalls.length > 0 ? allToolCalls : null,
        metadata: {
          model,
          usage: response.usage,
          stop_reason: response.stop_reason,
          turns: turnCount,
          tools_used: allToolCalls.map(tc => tc.tool),
        },
      });

      if (insertErr) {
        await supabase.from("tasks").update({
          status: "failed",
          error_message: insertErr.message,
          completed_at: new Date().toISOString(),
        }).eq("id", task_id);
        return res.status(500).json({ error: `Failed to save reply: ${insertErr.message}` });
      }

      const uniqueTools = [...new Set(allToolCalls.map(tc => tc.tool))];
      const toolsSummary = allToolCalls.length > 0
        ? ` — used ${allToolCalls.length} tool(s): ${uniqueTools.join(", ")}`
        : "";

      await supabase.from("tasks").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", task_id);

      await supabase.from("task_results").insert({
        task_id,
        result_type: "agent_response",
        data: {
          response: assistantContent,
          tools_used: uniqueTools,
          tool_calls: allToolCalls,
          turns: turnCount,
          model,
        },
      });

      await termLog(supabase, `Task ${task_id.slice(0, 8)} completed in ${turnCount} turn(s)${toolsSummary}`, {
        taskId: task_id, agentSlug: agentSlugForLog, logType: "task_complete",
      });

      return res.status(200).json({
        ok: true,
        content: assistantContent,
        tools_used: uniqueTools,
        turns: turnCount,
      });
    }

    // Max turns reached
    const finalContent =
      "I hit the maximum number of processing steps. Here's what I accomplished so far: " +
      allToolCalls.map(tc => `Used ${tc.tool}`).join(", ");

    await supabase.from("chat_messages").insert({
      conversation_id,
      role: "orchestrator",
      content: finalContent,
      timestamp: new Date().toISOString(),
      tool_calls: allToolCalls,
      metadata: { model, turns: turnCount, max_turns_reached: true },
    });

    await supabase.from("tasks").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", task_id);

    await supabase.from("task_results").insert({
      task_id,
      result_type: "agent_response",
      data: {
        response: finalContent,
        tools_used: [...new Set(allToolCalls.map(tc => tc.tool))],
        tool_calls: allToolCalls,
        turns: turnCount,
        model,
        max_turns_reached: true,
      },
    });

    return res.status(200).json({ ok: true, content: finalContent, max_turns_reached: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Internal server error";

    try {
      const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      if (supabaseUrl && supabaseKey) {
        const sb = createClient(supabaseUrl, supabaseKey);
        const { task_id, conversation_id } = req.body || {};

        if (task_id) {
          await sb.from("tasks").update({
            status: "failed",
            error_message: message,
            completed_at: new Date().toISOString(),
          }).eq("id", task_id);
        }

        if (conversation_id) {
          await sb.from("chat_messages").insert({
            conversation_id,
            role: "orchestrator",
            content: `Sorry, I ran into an error: ${message}. Please try again.`,
            timestamp: new Date().toISOString(),
            metadata: { error: true, original_error: message },
          });
        }

        if (task_id) {
          await termLog(sb, `Task ${task_id.slice(0, 8)} FAILED: ${message}`, {
            taskId: task_id, agentSlug: "system", logType: "error",
          });
        }
      }
    } catch (_recovery) {
      // Best-effort recovery; don't throw from error handler
    }

    return res.status(500).json({ error: message });
  }
}
