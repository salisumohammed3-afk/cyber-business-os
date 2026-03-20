import Anthropic from "@anthropic-ai/sdk";
import { Resend } from "resend";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 120;

// ── Activity gathering ──────────────────────────────────────────────────────

interface ActivityData {
  companyName: string;
  tasksCompleted: Array<{ title: string; agent: string; summary: string }>;
  tasksFailed: Array<{ title: string; agent: string; reason: string }>;
  tasksRunning: Array<{ title: string; agent: string }>;
  tasksProposed: Array<{ title: string; agent: string }>;
  goalsProgress: Array<{ title: string; metric: string; current: number; target: number; timeframe: string }>;
  newProjects: Array<{ name: string; status: string; description: string }>;
  newMemories: number;
  keyEvents: string[];
}

async function gatherActivity(
  supabase: SupabaseClient,
  companyId: string,
  companyName: string
): Promise<ActivityData> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const agentMap: Record<string, string> = {};
  const { data: agents } = await supabase
    .from("agent_definitions")
    .select("id, name")
    .eq("company_id", companyId);
  for (const a of (agents || []) as Array<{ id: string; name: string }>) {
    agentMap[a.id] = a.name;
  }

  const { data: completed } = await supabase
    .from("tasks")
    .select("title, agent_definition_id, id")
    .eq("company_id", companyId)
    .eq("status", "completed")
    .gte("completed_at", since)
    .order("completed_at", { ascending: false })
    .limit(20);

  const completedTasks: ActivityData["tasksCompleted"] = [];
  for (const t of (completed || []) as Array<{ title: string; agent_definition_id: string; id: string }>) {
    const { data: result } = await supabase
      .from("task_results")
      .select("data")
      .eq("task_id", t.id)
      .limit(1)
      .single();
    const summary = (result?.data as Record<string, string>)?.response?.slice(0, 200) || "Completed";
    completedTasks.push({
      title: t.title || "Untitled",
      agent: agentMap[t.agent_definition_id] || "Unknown",
      summary,
    });
  }

  const { data: failed } = await supabase
    .from("tasks")
    .select("title, agent_definition_id, error_message")
    .eq("company_id", companyId)
    .eq("status", "failed")
    .gte("completed_at", since)
    .order("completed_at", { ascending: false })
    .limit(10);

  const failedTasks = ((failed || []) as Array<{ title: string; agent_definition_id: string; error_message: string | null }>).map(t => ({
    title: t.title || "Untitled",
    agent: agentMap[t.agent_definition_id] || "Unknown",
    reason: t.error_message || "Unknown error",
  }));

  const { data: running } = await supabase
    .from("tasks")
    .select("title, agent_definition_id")
    .eq("company_id", companyId)
    .eq("status", "running");

  const runningTasks = ((running || []) as Array<{ title: string; agent_definition_id: string }>).map(t => ({
    title: t.title || "Untitled",
    agent: agentMap[t.agent_definition_id] || "Unknown",
  }));

  const { data: proposed } = await supabase
    .from("tasks")
    .select("title, agent_definition_id")
    .eq("company_id", companyId)
    .eq("status", "proposed")
    .gte("created_at", since)
    .limit(10);

  const proposedTasks = ((proposed || []) as Array<{ title: string; agent_definition_id: string }>).map(t => ({
    title: t.title || "Untitled",
    agent: agentMap[t.agent_definition_id] || "Unknown",
  }));

  const { data: goals } = await supabase
    .from("company_goals")
    .select("title, target_metric, target_value, current_value, timeframe")
    .eq("company_id", companyId)
    .eq("status", "active");

  const goalsProgress = ((goals || []) as Array<{ title: string; target_metric: string | null; target_value: number | null; current_value: number; timeframe: string | null }>).map(g => ({
    title: g.title,
    metric: g.target_metric || "",
    current: g.current_value ?? 0,
    target: g.target_value ?? 0,
    timeframe: g.timeframe || "ongoing",
  }));

  const { data: projects } = await supabase
    .from("projects")
    .select("name, status, description")
    .eq("company_id", companyId)
    .gte("created_at", since);

  const newProjects = ((projects || []) as Array<{ name: string; status: string; description: string | null }>).map(p => ({
    name: p.name,
    status: p.status,
    description: p.description || "",
  }));

  const { count: memCount } = await supabase
    .from("memories")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .gte("created_at", since);

  const { data: keyLogs } = await supabase
    .from("terminal_logs")
    .select("message, log_type")
    .eq("company_id", companyId)
    .gte("created_at", since)
    .in("log_type", ["error", "task_complete", "task_failed", "review_accepted", "review_rejected", "review_retry"])
    .order("created_at", { ascending: false })
    .limit(15);

  const keyEvents = ((keyLogs || []) as Array<{ message: string }>).map(l => l.message);

  return {
    companyName,
    tasksCompleted: completedTasks,
    tasksFailed: failedTasks,
    tasksRunning: runningTasks,
    tasksProposed: proposedTasks,
    goalsProgress,
    newProjects,
    newMemories: memCount ?? 0,
    keyEvents,
  };
}

// ── Email generation ────────────────────────────────────────────────────────

const DIGEST_SYSTEM_PROMPT = `You write daily briefing emails for a business CEO about their AI agent team's activity. Your tone is conversational and first-person, as if you're a trusted advisor briefing the CEO over morning coffee.

Rules:
- Write in a warm, direct style. Use "we" and "your team" — not "the system".
- Group by theme, not just a data dump. Lead with what matters most.
- Highlight what shipped, what's stuck, what needs attention.
- If there are proposed tasks, mention them as "coming up next".
- Keep it scannable: short paragraphs, bold headers, bullet points where helpful.
- End with a personality sign-off — something encouraging or witty.
- Output clean HTML suitable for an email body. Use inline styles for basic formatting.
- Use a clean, minimal design: dark text on white, subtle borders, good spacing.
- Keep the email concise — aim for 30 seconds of reading time.
- If there's nothing to report, say so briefly and encouragingly.`;

async function generateDigestHtml(
  anthropic: Anthropic,
  activity: ActivityData
): Promise<string> {
  const dataBlock = `
Company: ${activity.companyName}
Date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}

Tasks completed (last 24h): ${activity.tasksCompleted.length}
${activity.tasksCompleted.map(t => `  - "${t.title}" by ${t.agent}: ${t.summary.slice(0, 100)}`).join("\n")}

Tasks failed: ${activity.tasksFailed.length}
${activity.tasksFailed.map(t => `  - "${t.title}" by ${t.agent}: ${t.reason.slice(0, 80)}`).join("\n")}

Currently running: ${activity.tasksRunning.length}
${activity.tasksRunning.map(t => `  - "${t.title}" (${t.agent})`).join("\n")}

Newly proposed: ${activity.tasksProposed.length}
${activity.tasksProposed.map(t => `  - "${t.title}" for ${t.agent}`).join("\n")}

Goals:
${activity.goalsProgress.map(g => `  - ${g.title}: ${g.current}/${g.target} ${g.metric} (${g.timeframe})`).join("\n") || "  No active goals"}

New projects registered: ${activity.newProjects.length}
${activity.newProjects.map(p => `  - ${p.name} (${p.status}): ${p.description.slice(0, 80)}`).join("\n")}

New memories stored: ${activity.newMemories}

Key events:
${activity.keyEvents.slice(0, 10).map(e => `  - ${e.slice(0, 120)}`).join("\n") || "  No notable events"}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    temperature: 0.7,
    system: DIGEST_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Generate the daily briefing email HTML for this activity:\n\n${dataBlock}` }],
  });

  const text = response.content
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { type: string; text?: string }) => b.text || "")
    .join("");

  const htmlMatch = text.match(/<html[\s\S]*<\/html>/i) ||
    text.match(/<div[\s\S]*<\/div>/i) ||
    text.match(/<body[\s\S]*<\/body>/i);

  return htmlMatch ? htmlMatch[0] : text;
}

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.DIGEST_FROM_EMAIL || "digest@salos.app";

  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: "Supabase not configured" });
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  if (!resendKey) return res.status(500).json({ error: "RESEND_API_KEY not configured" });

  const supabase = createClient(supabaseUrl, supabaseKey);
  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const resend = new Resend(resendKey);

  const { data: companies, error: compErr } = await supabase
    .from("companies")
    .select("id, name, digest_email, digest_enabled")
    .eq("is_active", true)
    .eq("digest_enabled", true);

  if (compErr || !companies?.length) {
    return res.status(200).json({ sent: 0, note: "No companies with digest enabled" });
  }

  const results: Array<{ company: string; status: string; email?: string }> = [];

  for (const comp of companies as Array<{ id: string; name: string; digest_email: string | null; digest_enabled: boolean }>) {
    if (!comp.digest_email) {
      results.push({ company: comp.name, status: "skipped_no_email" });
      continue;
    }

    try {
      await supabase.from("terminal_logs").insert({
        message: `Daily digest: gathering activity for ${comp.name}...`,
        source: "daily-digest",
        log_type: "digest_start",
        company_id: comp.id,
      });

      const activity = await gatherActivity(supabase, comp.id, comp.name);

      const hasActivity = activity.tasksCompleted.length > 0 ||
        activity.tasksFailed.length > 0 ||
        activity.tasksRunning.length > 0 ||
        activity.tasksProposed.length > 0 ||
        activity.newProjects.length > 0;

      const html = await generateDigestHtml(anthropic, activity);

      const today = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const subject = hasActivity
        ? `[${comp.name}] Daily Briefing — ${today}`
        : `[${comp.name}] All quiet — ${today}`;

      const { error: sendErr } = await resend.emails.send({
        from: fromEmail,
        to: comp.digest_email,
        subject,
        html,
      });

      if (sendErr) {
        await supabase.from("terminal_logs").insert({
          message: `Daily digest FAILED for ${comp.name}: ${sendErr.message}`,
          source: "daily-digest",
          log_type: "digest_error",
          company_id: comp.id,
        });
        results.push({ company: comp.name, status: "send_failed", email: comp.digest_email });
        continue;
      }

      await supabase.from("terminal_logs").insert({
        message: `Daily digest sent to ${comp.digest_email} for ${comp.name}`,
        source: "daily-digest",
        log_type: "digest_sent",
        company_id: comp.id,
      });

      results.push({ company: comp.name, status: "sent", email: comp.digest_email });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      await supabase.from("terminal_logs").insert({
        message: `Daily digest error for ${comp.name}: ${msg}`,
        source: "daily-digest",
        log_type: "digest_error",
        company_id: comp.id,
      });
      results.push({ company: comp.name, status: "error" });
    }
  }

  const sent = results.filter(r => r.status === "sent").length;
  return res.status(200).json({ sent, total: companies.length, results });
}
