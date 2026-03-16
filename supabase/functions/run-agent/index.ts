import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);
  }

  try {
    const { task_id, conversation_id } = await req.json();
    if (!task_id || !conversation_id) {
      return json({ error: "task_id and conversation_id are required" }, 400);
    }

    // 1. Read the task and its agent definition
    const { data: task, error: taskErr } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", task_id)
      .single();
    if (taskErr) return json({ error: `Task not found: ${taskErr.message}` }, 404);

    // Mark task as running
    await supabase
      .from("tasks")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", task_id);

    // 2. Read agent definition
    const agentDefId = task.agent_definition_id;
    let systemPrompt = "You are a helpful AI assistant for a business operating system.";
    let model = "claude-sonnet-4-20250514";

    if (agentDefId) {
      const { data: agentDef } = await supabase
        .from("agent_definitions")
        .select("*")
        .eq("id", agentDefId)
        .single();
      if (agentDef) {
        systemPrompt = agentDef.system_prompt || systemPrompt;
        model = agentDef.model || model;
      }
    }

    // 3. Read conversation history
    const { data: history } = await supabase
      .from("chat_messages")
      .select("role, content")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: true });

    const messages = (history ?? []).map((m: { role: string; content: string }) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content || "",
    }));

    // 4. Call Anthropic
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
        system: systemPrompt,
        messages,
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      await supabase
        .from("tasks")
        .update({ status: "failed", error_message: errBody, completed_at: new Date().toISOString() })
        .eq("id", task_id);
      return json({ error: `Anthropic API error: ${errBody}` }, 502);
    }

    const anthropicData = await anthropicRes.json();
    const assistantContent =
      anthropicData.content
        ?.filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("") || "I received your message but had no response.";

    // 5. Insert assistant reply into chat_messages
    const { error: insertErr } = await supabase.from("chat_messages").insert({
      conversation_id,
      role: "orchestrator",
      content: assistantContent,
      timestamp: new Date().toISOString(),
      metadata: {
        model,
        usage: anthropicData.usage,
        stop_reason: anthropicData.stop_reason,
      },
    });

    if (insertErr) {
      await supabase
        .from("tasks")
        .update({ status: "failed", error_message: insertErr.message, completed_at: new Date().toISOString() })
        .eq("id", task_id);
      return json({ error: `Failed to save reply: ${insertErr.message}` }, 500);
    }

    // 6. Mark task completed
    await supabase
      .from("tasks")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", task_id);

    return json({ ok: true, content: assistantContent });
  } catch (e) {
    return json({ error: e.message || "Internal server error" }, 500);
  }
});
