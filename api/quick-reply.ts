import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const DELEGATION_RE = /\[NEEDS_DELEGATION\]/;

const ROUTING_ADDENDUM = `

## How to respond

You're in chat mode — no tools available. Talk like a sharp, helpful colleague.

- **Answer directly** when you can: status updates, questions, ideas, plans, opinions, quick facts from what you already know.
- **Delegate** when the request needs real work (research, building, designing, outreach, analysis). Include a brief acknowledgment then the marker:

[NEEDS_DELEGATION]
Task title
What needs to be done.

- If the user corrects you or says no, listen and move on.
- Don't bring up old tasks or goals unless asked.
- Be honest about what you can and can't do right now — but keep it brief, not a disclaimer.`;

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

  const attachmentList: Array<{ name: string; url: string; type: string; size: number }> =
    Array.isArray(attachments) ? attachments : [];

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
          .select("role, content, metadata")
          .eq("conversation_id", conversation_id)
          .order("created_at", { ascending: false })
          .limit(12),
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
        return true;
      })
      .map((m: Record<string, string>) => ({
        role: m.role === "user" ? ("user" as const) : ("assistant" as const),
        content: m.content,
      }));

    const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [];
    for (const m of filtered) {
      const prev = messages[messages.length - 1];
      if (prev && prev.role === m.role) {
        prev.content = (prev.content as string) + "\n" + m.content;
      } else {
        messages.push({ ...m });
      }
    }

    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== "user" || lastMsg.content !== message) {
      if (attachmentList.length > 0) {
        const imageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
        const contentBlocks: Array<Record<string, unknown>> = [];

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
        temperature: 0.3,
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
