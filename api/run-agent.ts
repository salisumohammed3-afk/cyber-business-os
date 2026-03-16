import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// ── Types ───────────────────────────────────────────────────────────────────

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface ToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

interface AgentToolRow {
  id: string;
  tool_name: string;
  connection_source: string;
  composio_action_id: string | null;
  tool_schema: ToolDef | null;
  is_enabled: boolean;
}

// ── Fallback tools (used when agent has no rows in agent_tools) ─────────────

function getDefaultTools(): ToolDef[] {
  return [
    {
      name: "web_search",
      description: "Search the web for current information. Use for market research, competitor analysis, news, and any real-time data.",
      input_schema: { type: "object", properties: { query: { type: "string", description: "The search query" } }, required: ["query"] },
    },
    {
      name: "database_query",
      description: "Query the business database. Tables: agents, tasks, chat_messages, conversations, metrics, agent_definitions, memories, users. Returns JSON rows.",
      input_schema: {
        type: "object",
        properties: {
          table: { type: "string", description: "Table name to query" },
          select: { type: "string", description: 'Columns to select (default: "*")' },
          filters: { type: "array", description: "Array of filter objects: { column, operator, value }", items: { type: "object", properties: { column: { type: "string" }, operator: { type: "string" }, value: { type: "string" } }, required: ["column", "operator", "value"] } },
          order_by: { type: "string", description: "Column to order by" },
          ascending: { type: "boolean", description: "Sort direction (default: true)" },
          limit: { type: "number", description: "Max rows to return (default: 25)" },
        },
        required: ["table"],
      },
    },
    {
      name: "create_task",
      description: "Create a new task for an agent. Use this to delegate work to specialist agents (engineering, growth, sales, research, outreach).",
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
      description: "Delegate a task to a specialist sub-agent and wait for the result. The sub-agent will execute the task autonomously and return its output.",
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

// ── Dynamic tool loading from agent_tools table ─────────────────────────────

async function getToolsForAgent(
  supabase: SupabaseClient,
  agentDefId: string
): Promise<{ tools: ToolDef[]; toolMap: Map<string, AgentToolRow> }> {
  const { data: rows, error } = await supabase
    .from("agent_tools")
    .select("id, tool_name, connection_source, composio_action_id, tool_schema, is_enabled")
    .eq("agent_id", agentDefId)
    .eq("is_enabled", true);

  if (error || !rows || rows.length === 0) {
    const defaults = getDefaultTools();
    const fallbackMap = new Map<string, AgentToolRow>();
    for (const t of defaults) {
      fallbackMap.set(t.name, {
        id: "",
        tool_name: t.name,
        connection_source: "internal",
        composio_action_id: null,
        tool_schema: t,
        is_enabled: true,
      });
    }
    return { tools: defaults, toolMap: fallbackMap };
  }

  const tools: ToolDef[] = [];
  const toolMap = new Map<string, AgentToolRow>();

  for (const row of rows as AgentToolRow[]) {
    if (!row.tool_schema || !row.tool_name) continue;
    const schema = row.tool_schema as ToolDef;
    tools.push(schema);
    toolMap.set(schema.name, row);
  }

  if (tools.length === 0) {
    const defaults = getDefaultTools();
    const fallbackMap = new Map<string, AgentToolRow>();
    for (const t of defaults) {
      fallbackMap.set(t.name, {
        id: "",
        tool_name: t.name,
        connection_source: "internal",
        composio_action_id: null,
        tool_schema: t,
        is_enabled: true,
      });
    }
    return { tools: defaults, toolMap: fallbackMap };
  }

  return { tools, toolMap };
}

// ── Composio execution ──────────────────────────────────────────────────────

async function executeComposioAction(
  actionId: string,
  input: Record<string, unknown>,
  entityId?: string
): Promise<string> {
  const composioKey = process.env.COMPOSIO_API_KEY;
  if (!composioKey) {
    return JSON.stringify({
      error: "Composio not configured (COMPOSIO_API_KEY missing)",
      suggestion: "Add COMPOSIO_API_KEY to environment variables from your Rube/Composio dashboard.",
    });
  }

  try {
    const resp = await fetch(
      `https://backend.composio.dev/api/v2/actions/${encodeURIComponent(actionId)}/execute`,
      {
        method: "POST",
        headers: {
          "x-api-key": composioKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input,
          entityId: entityId || "default",
        }),
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return JSON.stringify({ error: `Composio API error (${resp.status}): ${errText.slice(0, 500)}` });
    }

    const result = await resp.json();

    if (result.error) {
      return JSON.stringify({ error: result.error });
    }

    const data = result.data ?? result;
    return typeof data === "string" ? data : JSON.stringify(data, null, 2);
  } catch (e) {
    return JSON.stringify({
      error: `Composio execution error: ${e instanceof Error ? e.message : "unknown"}`,
    });
  }
}

// ── Tool routing ────────────────────────────────────────────────────────────

async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  supabase: SupabaseClient,
  context: {
    conversationId: string;
    parentTaskId: string;
    anthropicKey: string;
    supabaseUrl: string;
    supabaseKey: string;
  },
  toolMap: Map<string, AgentToolRow>
): Promise<string> {
  const toolRow = toolMap.get(toolName);

  if (!toolRow) {
    return executeInternalTool(toolName, toolInput, supabase, context);
  }

  switch (toolRow.connection_source) {
    case "composio":
      if (!toolRow.composio_action_id) {
        return JSON.stringify({ error: `No composio_action_id configured for tool: ${toolName}` });
      }
      return executeComposioAction(toolRow.composio_action_id, toolInput);

    case "direct":
      return executeDirectTool(toolName, toolInput);

    case "internal":
    default:
      return executeInternalTool(toolName, toolInput, supabase, context);
  }
}

// ── Direct API tools (API-key based, no Composio) ───────────────────────────

async function executeDirectTool(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<string> {
  switch (toolName) {
    case "web_search":
      return executeWebSearch(toolInput.query as string);
    default:
      return JSON.stringify({ error: `Unknown direct tool: ${toolName}` });
  }
}

// ── Internal tools (run inside the runner) ──────────────────────────────────

async function executeInternalTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  supabase: SupabaseClient,
  context: {
    conversationId: string;
    parentTaskId: string;
    anthropicKey: string;
    supabaseUrl: string;
    supabaseKey: string;
  }
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
    default:
      return JSON.stringify({ error: `Unknown internal tool: ${toolName}` });
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
      const method = f.operator as "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "like" | "ilike";
      if (typeof query[method] === "function") {
        query = query[method](f.column, f.value);
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
        status: "pending",
        source: "chat",
      })
      .select("id")
      .single();

    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify({ success: true, task_id: task.id, assigned_to: agentDef.name });
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

async function executeDelegateTask(
  supabase: SupabaseClient,
  input: Record<string, unknown>,
  context: {
    conversationId: string;
    parentTaskId: string;
    anthropicKey: string;
    supabaseUrl: string;
    supabaseKey: string;
  }
): Promise<string> {
  try {
    const agentSlug = input.agent_slug as string;
    const instruction = input.instruction as string;
    const extraContext = (input.context as string) || "";

    const { data: agentDef } = await supabase
      .from("agent_definitions")
      .select("*")
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
        status: "running",
        started_at: new Date().toISOString(),
        input_data: { instruction, context: extraContext },
        source: "agent",
      })
      .select("id")
      .single();

    if (taskErr) return JSON.stringify({ error: taskErr.message });

    // Load the sub-agent's tools from agent_tools
    const { tools: subTools, toolMap: subToolMap } = await getToolsForAgent(supabase, agentDef.id);

    const subSystemPrompt = agentDef.system_prompt ||
      `You are the ${agentDef.name} agent. ${agentDef.description || ""}`;

    const subMessages: AnthropicMessage[] = [
      {
        role: "user",
        content: extraContext
          ? `Context: ${extraContext}\n\nTask: ${instruction}`
          : instruction,
      },
    ];

    // Sub-agent gets its own agentic loop with its own tools
    let subTurnCount = 0;
    const subMaxTurns = agentDef.max_turns || 5;

    while (subTurnCount < subMaxTurns) {
      subTurnCount++;

      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": context.anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: agentDef.model || "claude-sonnet-4-20250514",
          max_tokens: 4096,
          temperature: parseFloat(agentDef.temperature) || 0.7,
          system: subSystemPrompt,
          messages: subMessages,
          ...(subTools.length > 0 ? { tools: subTools } : {}),
        }),
      });

      if (!anthropicRes.ok) {
        const errBody = await anthropicRes.text();
        await supabase.from("tasks").update({
          status: "failed",
          error_message: errBody,
          completed_at: new Date().toISOString(),
        }).eq("id", childTask.id);
        return JSON.stringify({ error: `Sub-agent failed: ${errBody}` });
      }

      const anthropicData = await anthropicRes.json();

      if (anthropicData.stop_reason === "tool_use") {
        subMessages.push({ role: "assistant", content: anthropicData.content });

        const toolResults: ToolResult[] = [];
        for (const block of anthropicData.content) {
          if (block.type === "tool_use") {
            await termLog(supabase, `[${agentDef.slug}] Using tool: ${block.name}`, {
              taskId: childTask.id, agentSlug: agentDef.slug, logType: "tool_call",
            });

            const output = await executeTool(
              block.name,
              block.input as Record<string, unknown>,
              supabase,
              context,
              subToolMap
            );

            await termLog(supabase, `[${agentDef.slug}] Tool result (${block.name}): ${output.slice(0, 100)}...`, {
              taskId: childTask.id, agentSlug: agentDef.slug, logType: "tool_result",
            });

            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: output });
          }
        }

        subMessages.push({ role: "user", content: toolResults as unknown as string });
        continue;
      }

      // Sub-agent done
      const result = anthropicData.content
        ?.filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("") || "No response from sub-agent.";

      await supabase.from("task_results").insert({
        task_id: childTask.id,
        result_type: "text",
        data: { content: result, model: agentDef.model, usage: anthropicData.usage, turns: subTurnCount },
      });

      await supabase.from("tasks").update({
        status: "completed",
        completed_at: new Date().toISOString(),
      }).eq("id", childTask.id);

      return JSON.stringify({ agent: agentDef.name, task_id: childTask.id, result });
    }

    return JSON.stringify({ agent: agentDef.name, task_id: childTask.id, result: "Sub-agent hit max turns." });
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

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { task_id, conversation_id } = req.body;
    if (!task_id || !conversation_id) {
      return res.status(400).json({ error: "task_id and conversation_id are required" });
    }

    // 1. Read the task
    const { data: task, error: taskErr } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", task_id)
      .single();
    if (taskErr)
      return res.status(404).json({ error: `Task not found: ${taskErr.message}` });

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

    // 3. Load tools for this agent from agent_tools table
    const { tools, toolMap } = agentDefId
      ? await getToolsForAgent(supabase, agentDefId)
      : { tools: getDefaultTools(), toolMap: new Map<string, AgentToolRow>() };

    const composioToolCount = [...toolMap.values()].filter(t => t.connection_source === "composio").length;

    await termLog(supabase, `Loaded ${tools.length} tools (${composioToolCount} via Composio)`, {
      taskId: task_id, agentSlug: agentSlugForLog, logType: "tools_loaded",
    });

    // 4. Read conversation history
    const { data: history } = await supabase
      .from("chat_messages")
      .select("role, content, tool_calls")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: true });

    const messages: AnthropicMessage[] = (history ?? []).map(
      (m: { role: string; content: string }) => ({
        role: m.role === "user" ? "user" : "assistant",
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

    // 6. Agentic loop
    let turnCount = 0;
    const allToolCalls: Array<{ tool: string; input: unknown; output: string }> = [];

    await termLog(supabase, `Starting agentic loop — ${tools.length} tools available, max ${maxTurns} turns`, {
      taskId: task_id, agentSlug: agentSlugForLog, logType: "loop_start",
    });

    while (turnCount < maxTurns) {
      turnCount++;

      await termLog(supabase, `Turn ${turnCount}/${maxTurns} — calling ${model}...`, {
        taskId: task_id, agentSlug: agentSlugForLog, logType: "llm_call",
      });

      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          temperature,
          system: systemPrompt,
          messages,
          tools,
        }),
      });

      if (!anthropicRes.ok) {
        const errBody = await anthropicRes.text();
        await supabase.from("tasks").update({
          status: "failed",
          error_message: errBody,
          completed_at: new Date().toISOString(),
        }).eq("id", task_id);
        return res.status(502).json({ error: `Anthropic API error: ${errBody}` });
      }

      const anthropicData = await anthropicRes.json();

      if (anthropicData.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: anthropicData.content });

        const toolResults: ToolResult[] = [];
        for (const block of anthropicData.content) {
          if (block.type === "tool_use") {
            const inputSummary = JSON.stringify(block.input).slice(0, 120);
            const toolRow = toolMap.get(block.name);
            const source = toolRow?.connection_source || "internal";

            await termLog(supabase, `Using tool: ${block.name} [${source}] — ${inputSummary}`, {
              taskId: task_id, agentSlug: agentSlugForLog, logType: "tool_call",
            });

            const output = await executeTool(
              block.name,
              block.input as Record<string, unknown>,
              supabase,
              { conversationId: conversation_id, parentTaskId: task_id, anthropicKey, supabaseUrl, supabaseKey },
              toolMap
            );

            const outputPreview = output.slice(0, 100);
            await termLog(supabase, `Tool result (${block.name}): ${outputPreview}${output.length > 100 ? "..." : ""}`, {
              taskId: task_id, agentSlug: agentSlugForLog, logType: "tool_result",
            });

            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: output });
            allToolCalls.push({ tool: block.name, input: block.input, output });
          }
        }

        messages.push({ role: "user", content: toolResults as unknown as string });
        continue;
      }

      // Model is done
      const assistantContent =
        anthropicData.content
          ?.filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text)
          .join("") || "I received your message but had no response.";

      const { error: insertErr } = await supabase.from("chat_messages").insert({
        conversation_id,
        role: "orchestrator",
        content: assistantContent,
        timestamp: new Date().toISOString(),
        tool_calls: allToolCalls.length > 0 ? allToolCalls : null,
        metadata: {
          model,
          usage: anthropicData.usage,
          stop_reason: anthropicData.stop_reason,
          turns: turnCount,
          tools_used: allToolCalls.map((tc) => tc.tool),
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

      await supabase.from("tasks").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", task_id);

      const toolsSummary = allToolCalls.length > 0
        ? ` — used ${allToolCalls.length} tool(s): ${[...new Set(allToolCalls.map(tc => tc.tool))].join(", ")}`
        : "";
      await termLog(supabase, `Task ${task_id.slice(0, 8)} completed in ${turnCount} turn(s)${toolsSummary}`, {
        taskId: task_id, agentSlug: agentSlugForLog, logType: "task_complete",
      });

      return res.status(200).json({
        ok: true,
        content: assistantContent,
        tools_used: allToolCalls.map((tc) => tc.tool),
        turns: turnCount,
      });
    }

    // Max turns reached
    const finalContent =
      "I hit the maximum number of processing steps. Here's what I accomplished so far: " +
      allToolCalls.map((tc) => `Used ${tc.tool}`).join(", ");

    await supabase.from("chat_messages").insert({
      conversation_id,
      role: "orchestrator",
      content: finalContent,
      timestamp: new Date().toISOString(),
      tool_calls: allToolCalls,
      metadata: { model, turns: turnCount, max_turns_reached: true },
    });

    await supabase.from("tasks").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", task_id);

    return res.status(200).json({ ok: true, content: finalContent, max_turns_reached: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Internal server error";
    return res.status(500).json({ error: message });
  }
}
