import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// ── Tool definitions ────────────────────────────────────────────────────────

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

// Built-in tools every agent can access
function getBuiltinTools(): ToolDef[] {
  return [
    {
      name: "web_search",
      description:
        "Search the web for current information. Use for market research, competitor analysis, news, and any real-time data.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
    },
    {
      name: "database_query",
      description:
        "Query the business database. Tables: agents, tasks, chat_messages, conversations, metrics, agent_definitions, memories, users. Returns JSON rows.",
      input_schema: {
        type: "object",
        properties: {
          table: { type: "string", description: "Table name to query" },
          select: {
            type: "string",
            description: 'Columns to select (default: "*")',
          },
          filters: {
            type: "array",
            description:
              'Array of filter objects: { column, operator, value }. Operators: eq, neq, gt, lt, gte, lte, like, ilike',
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
          ascending: {
            type: "boolean",
            description: "Sort direction (default: true)",
          },
          limit: {
            type: "number",
            description: "Max rows to return (default: 25)",
          },
        },
        required: ["table"],
      },
    },
    {
      name: "create_task",
      description:
        "Create a new task for an agent. Use this to delegate work to specialist agents (engineering, growth, sales, research).",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title" },
          description: {
            type: "string",
            description: "Detailed task description",
          },
          agent_slug: {
            type: "string",
            description:
              "Target agent slug: orchestrator, engineering, growth, sales, research",
          },
          priority: {
            type: "number",
            description: "Priority 0-10 (default: 5)",
          },
        },
        required: ["title", "description", "agent_slug"],
      },
    },
    {
      name: "store_memory",
      description:
        "Store an important fact, preference, or insight for future reference. Memories persist across conversations.",
      input_schema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The fact/insight to remember",
          },
          category: {
            type: "string",
            description:
              "Category: business_context, user_preference, market_intel, decision, contact, metric",
          },
          importance: {
            type: "number",
            description: "Importance 0-10 (default: 5)",
          },
        },
        required: ["content", "category"],
      },
    },
    {
      name: "recall_memories",
      description:
        "Search stored memories for relevant context. Use before answering questions about the business, user preferences, or past decisions.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for in memories",
          },
          category: {
            type: "string",
            description: "Optional category filter",
          },
          limit: {
            type: "number",
            description: "Max memories to return (default: 10)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "delegate_task",
      description:
        "Delegate a task to a specialist sub-agent and wait for the result. The sub-agent will execute the task autonomously and return its output.",
      input_schema: {
        type: "object",
        properties: {
          agent_slug: {
            type: "string",
            description:
              "Target agent: engineering, growth, sales, research, outreach",
          },
          instruction: {
            type: "string",
            description: "Detailed instruction for the sub-agent",
          },
          context: {
            type: "string",
            description:
              "Additional context from the current conversation to pass along",
          },
        },
        required: ["agent_slug", "instruction"],
      },
    },
  ];
}

// ── Tool execution ──────────────────────────────────────────────────────────

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
  }
): Promise<string> {
  switch (toolName) {
    case "web_search":
      return await executeWebSearch(toolInput.query as string);

    case "database_query":
      return await executeDatabaseQuery(supabase, toolInput);

    case "create_task":
      return await executeCreateTask(supabase, toolInput, context);

    case "store_memory":
      return await executeStoreMemory(supabase, toolInput);

    case "recall_memories":
      return await executeRecallMemories(supabase, toolInput);

    case "delegate_task":
      return await executeDelegateTask(supabase, toolInput, context);

    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

async function executeWebSearch(query: string): Promise<string> {
  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey) {
    return JSON.stringify({
      error: "Web search not configured (SERPER_API_KEY missing)",
      suggestion:
        "Add SERPER_API_KEY to environment variables. Get one at serper.dev",
    });
  }

  try {
    const resp = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": serperKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num: 5 }),
    });

    if (!resp.ok) {
      return JSON.stringify({ error: `Search failed: ${resp.status}` });
    }

    const data = await resp.json();
    const results = (data.organic || [])
      .slice(0, 5)
      .map(
        (r: { title: string; snippet: string; link: string }) =>
          `**${r.title}**\n${r.snippet}\n${r.link}`
      )
      .join("\n\n");

    return results || "No results found.";
  } catch (e) {
    return JSON.stringify({
      error: `Search error: ${e instanceof Error ? e.message : "unknown"}`,
    });
  }
}

async function executeDatabaseQuery(
  supabase: SupabaseClient,
  input: Record<string, unknown>
): Promise<string> {
  try {
    const table = input.table as string;
    const select = (input.select as string) || "*";
    const filters = (input.filters as Array<Record<string, string>>) || [];
    const orderBy = input.order_by as string | undefined;
    const ascending = (input.ascending as boolean) ?? true;
    const limit = (input.limit as number) || 25;

    let query = supabase.from(table).select(select);

    for (const f of filters) {
      const method = f.operator as
        | "eq"
        | "neq"
        | "gt"
        | "lt"
        | "gte"
        | "lte"
        | "like"
        | "ilike";
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
    return JSON.stringify({
      error: `DB query error: ${e instanceof Error ? e.message : "unknown"}`,
    });
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
      })
      .select("id")
      .single();

    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify({
      success: true,
      task_id: task.id,
      assigned_to: agentDef.name,
    });
  } catch (e) {
    return JSON.stringify({
      error: `Create task error: ${e instanceof Error ? e.message : "unknown"}`,
    });
  }
}

async function executeStoreMemory(
  supabase: SupabaseClient,
  input: Record<string, unknown>
): Promise<string> {
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
    return JSON.stringify({
      error: `Store memory error: ${e instanceof Error ? e.message : "unknown"}`,
    });
  }
}

async function executeRecallMemories(
  supabase: SupabaseClient,
  input: Record<string, unknown>
): Promise<string> {
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

    // Text-based search (will upgrade to vector search in Phase 2)
    q = q.ilike("content", `%${query}%`);

    const { data, error } = await q;
    if (error) return JSON.stringify({ error: error.message });
    if (!data || data.length === 0) {
      return JSON.stringify({ memories: [], note: "No matching memories found" });
    }
    return JSON.stringify({ memories: data });
  } catch (e) {
    return JSON.stringify({
      error: `Recall error: ${e instanceof Error ? e.message : "unknown"}`,
    });
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

    // Create a child task
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
      })
      .select("id")
      .single();

    if (taskErr) return JSON.stringify({ error: taskErr.message });

    // Execute the sub-agent inline
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
    const result = anthropicData.content
      ?.filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("") || "No response from sub-agent.";

    // Store result
    await supabase.from("task_results").insert({
      task_id: childTask.id,
      result_type: "text",
      data: { content: result, model: agentDef.model, usage: anthropicData.usage },
    });

    await supabase.from("tasks").update({
      status: "completed",
      completed_at: new Date().toISOString(),
    }).eq("id", childTask.id);

    return JSON.stringify({
      agent: agentDef.name,
      task_id: childTask.id,
      result,
    });
  } catch (e) {
    return JSON.stringify({
      error: `Delegation error: ${e instanceof Error ? e.message : "unknown"}`,
    });
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
    // Non-critical — don't let logging failures break the agent
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

    // Simple keyword matching (upgraded to vector search in Phase 2)
    const lowerMsg = userMessage.toLowerCase();
    const relevant = data.filter((m: { content: string }) =>
      keywords.some(kw => m.content.toLowerCase().includes(kw.toLowerCase())) ||
      m.content.toLowerCase().split(/\s+/).some((w: string) => lowerMsg.includes(w))
    );

    if (relevant.length === 0) return "";

    return "\n\n## Relevant Memories\n" +
      relevant.map((m: { content: string; category: string }) =>
        `- [${m.category}] ${m.content}`
      ).join("\n");
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

  if (!supabaseUrl || !supabaseKey) {
    return res
      .status(500)
      .json({ error: "Supabase credentials not configured" });
  }
  if (!anthropicKey) {
    return res
      .status(500)
      .json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { task_id, conversation_id } = req.body;
    if (!task_id || !conversation_id) {
      return res
        .status(400)
        .json({ error: "task_id and conversation_id are required" });
    }

    // 1. Read the task
    const { data: task, error: taskErr } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", task_id)
      .single();
    if (taskErr)
      return res
        .status(404)
        .json({ error: `Task not found: ${taskErr.message}` });

    await supabase
      .from("tasks")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", task_id);

    const agentSlugForLog = "orchestrator";

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

        await termLog(supabase, `Agent loaded: ${agentDef.name} (${agentDef.slug}) — model: ${model}`, {
          taskId: task_id, agentSlug: agentDef.slug, logType: "agent_loaded",
        });
      }
    }

    // 3. Read conversation history
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

    // 4. Inject relevant memories into system prompt
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

    // 5. Build tool list
    const tools = getBuiltinTools();

    // 6. Agentic loop: call Anthropic, handle tool_use, repeat
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

      const anthropicRes = await fetch(
        "https://api.anthropic.com/v1/messages",
        {
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
        }
      );

      if (!anthropicRes.ok) {
        const errBody = await anthropicRes.text();
        await supabase
          .from("tasks")
          .update({
            status: "failed",
            error_message: errBody,
            completed_at: new Date().toISOString(),
          })
          .eq("id", task_id);
        return res
          .status(502)
          .json({ error: `Anthropic API error: ${errBody}` });
      }

      const anthropicData = await anthropicRes.json();

      // Check if the model wants to use tools
      if (anthropicData.stop_reason === "tool_use") {
        // Add assistant's response (with tool_use blocks) to messages
        messages.push({
          role: "assistant",
          content: anthropicData.content,
        });

        // Execute each tool call
        const toolResults: ToolResult[] = [];
        for (const block of anthropicData.content) {
          if (block.type === "tool_use") {
            const inputSummary = JSON.stringify(block.input).slice(0, 120);
            await termLog(supabase, `Using tool: ${block.name} — ${inputSummary}`, {
              taskId: task_id, agentSlug: agentSlugForLog, logType: "tool_call",
            });

            const output = await executeTool(
              block.name,
              block.input as Record<string, unknown>,
              supabase,
              {
                conversationId: conversation_id,
                parentTaskId: task_id,
                anthropicKey,
                supabaseUrl,
                supabaseKey,
              }
            );

            const outputPreview = output.slice(0, 100);
            await termLog(supabase, `Tool result (${block.name}): ${outputPreview}${output.length > 100 ? "..." : ""}`, {
              taskId: task_id, agentSlug: agentSlugForLog, logType: "tool_result",
            });

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: output,
            });

            allToolCalls.push({
              tool: block.name,
              input: block.input,
              output,
            });
          }
        }

        // Add tool results as a user message
        messages.push({
          role: "user",
          content: toolResults as unknown as string,
        });

        continue;
      }

      // Model is done (stop_reason === "end_turn" or similar)
      const assistantContent =
        anthropicData.content
          ?.filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text)
          .join("") || "I received your message but had no response.";

      // 7. Insert assistant reply
      const { error: insertErr } = await supabase
        .from("chat_messages")
        .insert({
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
        await supabase
          .from("tasks")
          .update({
            status: "failed",
            error_message: insertErr.message,
            completed_at: new Date().toISOString(),
          })
          .eq("id", task_id);
        return res
          .status(500)
          .json({ error: `Failed to save reply: ${insertErr.message}` });
      }

      // 8. Mark task completed
      await supabase
        .from("tasks")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", task_id);

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

    await supabase
      .from("tasks")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", task_id);

    return res.status(200).json({
      ok: true,
      content: finalContent,
      max_turns_reached: true,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Internal server error";
    return res.status(500).json({ error: message });
  }
}
