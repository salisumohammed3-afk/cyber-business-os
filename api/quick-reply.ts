import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const DELEGATION_RE = /\[NEEDS_DELEGATION\]/;

const ROUTING_ADDENDUM = `

## Quick-Reply Mode

You are answering in quick-reply mode. You do NOT have access to any tools right now.

- For greetings, status checks, clarifying questions, simple factual answers, or coordinating plans: answer the user directly. Be concise and helpful.
- If the request requires real work — research, building, designing, outreach, analysis, deep dives, or anything that needs a sub-agent — you MUST include the delegation marker on its own line, in this exact format:

[NEEDS_DELEGATION]
Task title here
One-sentence description of what needs to be done.

You may include a brief conversational acknowledgment BEFORE the marker line. The marker MUST appear on its own line.

Example (with preamble):
Sure, I'll queue that up for you.

[NEEDS_DELEGATION]
Competitive landscape analysis for fintech payments
Research the top 10 competitors in the fintech payments space, their funding, and differentiation.

Example (direct reply — no marker needed):
All agents are idle right now. Your last completed task was the unit converter app. Want me to kick off something new?`;

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

  const { conversation_id, company_id, message } = req.body || {};
  if (!conversation_id || !company_id || !message)
    return res
      .status(400)
      .json({ error: "conversation_id, company_id, and message are required" });

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const [agentsRes, companyRes, historyRes, goalsRes, tasksRes] =
      await Promise.all([
        supabase
          .from("agent_definitions")
          .select("id, slug, system_prompt")
          .eq("slug", "orchestrator")
          .eq("company_id", company_id),
        supabase
          .from("companies")
          .select("name, brief")
          .eq("id", company_id)
          .single(),
        supabase
          .from("chat_messages")
          .select("role, content")
          .eq("conversation_id", conversation_id)
          .order("created_at", { ascending: true })
          .limit(20),
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
      systemPrompt += "\n\n## Recent Tasks\n" + lines.join("\n");
    }

    systemPrompt += ROUTING_ADDENDUM;

    const messages = (historyRes.data || [])
      .filter((m: Record<string, string>) => m.content)
      .map((m: Record<string, string>) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      }));

    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== "user" || lastMsg.content !== message) {
      messages.push({ role: "user", content: message });
    }

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 1024,
        temperature: 0.5,
        system: systemPrompt,
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
    const reply =
      anthropicData.content?.[0]?.text ||
      "Sorry, I couldn't generate a reply.";

    // Check for delegation marker ANYWHERE in the response
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

      // Create a proposed task assigned to the orchestrator.
      // The user reviews it in the pipeline and clicks "Approve & Run".
      // The orchestrator then handles delegation to sub-agents.
      const taskInsert = await supabase
        .from("tasks")
        .insert({
          conversation_id,
          agent_definition_id: orchestrator?.id || null,
          company_id,
          status: "proposed",
          title: taskTitle,
          description: taskDescription,
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

      const taskId = taskInsert.data?.id;

      return res.status(200).json({ mode: "proposed", task_id: taskId });
    }

    await supabase.from("chat_messages").insert({
      conversation_id,
      role: "assistant",
      content: reply,
      timestamp: new Date().toISOString(),
    });

    return res.status(200).json({ mode: "direct" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("quick-reply error:", msg);
    return res.status(500).json({ error: msg });
  }
}
