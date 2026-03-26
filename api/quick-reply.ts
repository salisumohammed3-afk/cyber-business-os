import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const DELEGATION_MARKER = "[NEEDS_DELEGATION]";

const ROUTING_ADDENDUM = `

## Quick-Reply Mode

You are answering in quick-reply mode. You do NOT have access to any tools right now.

- For greetings, status checks, clarifying questions, simple factual answers, or coordinating plans: answer the user directly. Be concise and helpful.
- If the request requires real work — research, building, designing, outreach, analysis, deep dives, or anything that needs a sub-agent — respond with EXACTLY the marker \`${DELEGATION_MARKER}\` on the FIRST line, followed by a short task title on the second line, and a one-sentence description on the third line.

Example delegation response:
${DELEGATION_MARKER}
Competitive landscape analysis for fintech payments
Research the top 10 competitors in the fintech payments space, their funding, and differentiation.

Example direct response:
All agents are idle right now. Your last completed task was the unit converter app — it's live at unit-converter.vercel.app. Want me to kick off something new?`;

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
    const [orchestratorRes, companyRes, historyRes, goalsRes, tasksRes] =
      await Promise.all([
        supabase
          .from("agent_definitions")
          .select("id, system_prompt")
          .eq("slug", "orchestrator")
          .eq("company_id", company_id)
          .single(),
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
          .select("title, target_metric, current_value, target_value, timeframe")
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

    let systemPrompt =
      orchestratorRes.data?.system_prompt ||
      "You are the Orchestrator of a Cyber Business OS. Be direct and concise.";
    const orchestratorId = orchestratorRes.data?.id;

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
      return res
        .status(502)
        .json({ error: `Anthropic ${anthropicRes.status}: ${errBody.slice(0, 300)}` });
    }

    const anthropicData = await anthropicRes.json();
    const reply =
      anthropicData.content?.[0]?.text || "Sorry, I couldn't generate a reply.";

    if (reply.trim().startsWith(DELEGATION_MARKER)) {
      const lines = reply.trim().split("\n").filter(Boolean);
      const taskTitle = lines[1] || "Respond to user message";
      const taskDescription = lines.slice(2).join("\n") || message;

      const ackContent =
        "Got it — I'm delegating this now. I'll notify you when it's done.";

      const inserts: Promise<unknown>[] = [
        supabase.from("chat_messages").insert({
          conversation_id,
          role: "assistant",
          content: ackContent,
          timestamp: new Date().toISOString(),
        }),
      ];

      const taskInsert = await supabase
        .from("tasks")
        .insert({
          conversation_id,
          agent_definition_id: orchestratorId || null,
          company_id,
          status: "pending",
          title: taskTitle,
          description: taskDescription,
          source: "internal",
        })
        .select("id")
        .single();

      await Promise.all(inserts);

      const taskId = taskInsert.data?.id;
      if (taskId) {
        fetch(
          `${req.headers.origin || "https://" + req.headers.host}/api/run-agent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ task_id: taskId, conversation_id }),
          }
        ).catch(() => {});
      }

      return res.status(200).json({ mode: "delegated", task_id: taskId });
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
