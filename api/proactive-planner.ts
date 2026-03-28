import Anthropic from "@anthropic-ai/sdk";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { finishJobRun, startJobRun } from "./job-run-ledger";

export const maxDuration = 120;

const PLANNER_SYSTEM_PROMPT = `You are the Proactive Planner for a Cyber Business Operating System. Your job is to review the current state of the business — recent tasks, agent capabilities, stored memories, active goals, and ongoing work — then propose 1-5 high-value tasks that should be done next.

Each task you propose should be:
- Actionable and specific (not vague like "improve things")
- Assigned to the most appropriate specialist agent
- Prioritized by business impact
- Aligned with the company's active goals
- **NOT a duplicate of any task already in the "Existing Proposed Tasks" list** — if a similar task is already proposed, skip it entirely. Only propose genuinely new ideas.

Available agents and their strengths:
- orchestrator: Overall coordination, strategy, user communication
- growth: Full revenue lifecycle — user acquisition, sales pipeline, outreach, pricing, campaigns, retention (has Apollo, LinkedIn, AgentMail, Meta Ads, ElevenLabs)
- research: Market research, competitive intelligence, trend analysis (has Exa, Firecrawl)
- engineering: Technical development, architecture, code review
- designer: UI/UX design, mockups, design system
- executive-assistant: Email management, meeting notes to actions, Monday.com boards, client reporting, scheduling (has Monday.com, AgentMail, Gmail, Google Calendar)

Respond ONLY with a JSON array of task objects. Each object must have:
- "title": short task title
- "description": detailed description of what the agent should do
- "agent_slug": which agent to assign it to
- "priority": 1-10 (10 = highest)
- "tags": array of relevant tags

Example:
[
  {
    "title": "Research competitor pricing changes",
    "description": "Scan the top 5 competitors' pricing pages and identify any changes in the last 30 days. Summarize findings with impact analysis.",
    "agent_slug": "research",
    "priority": 7,
    "tags": ["competitive-intel", "pricing"]
  }
]`;

async function getBusinessContext(supabase: SupabaseClient, companyId: string, companyName: string): Promise<string> {
  const sections: string[] = [`# Company: ${companyName}`];

  // Goals
  const { data: goals } = await supabase
    .from("company_goals")
    .select("title, target_metric, target_value, current_value, timeframe, priority, status")
    .eq("company_id", companyId)
    .eq("status", "active")
    .order("priority", { ascending: true });

  if (goals?.length) {
    sections.push(
      "## Active Goals\n" +
        goals.map((g, i) =>
          `${i + 1}. ${g.title} (${g.current_value ?? 0}/${g.target_value ?? "?"} ${g.target_metric || ""}) — ${g.timeframe || "ongoing"}`
        ).join("\n")
    );
  }

  const { data: recentTasks } = await supabase
    .from("tasks")
    .select("title, status, source, created_at")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (recentTasks?.length) {
    sections.push(
      "## Recent Tasks (last 20)\n" +
        recentTasks
          .map((t: Record<string, string | null>) => `- [${t.status}] ${t.title} (${t.source || "unknown"}, ${t.created_at?.slice(0, 10)})`)
          .join("\n")
    );
  }

  const { data: memories } = await supabase
    .from("memories")
    .select("content, category, importance")
    .eq("company_id", companyId)
    .order("importance", { ascending: false })
    .limit(15);

  if (memories?.length) {
    sections.push(
      "## Key Memories\n" +
        memories.map((m: Record<string, string | number | null>) => `- [${m.category}] (importance: ${m.importance}) ${m.content}`).join("\n")
    );
  }

  const { data: agents } = await supabase
    .from("agent_definitions")
    .select("slug, name, description")
    .eq("company_id", companyId);

  if (agents?.length) {
    sections.push(
      "## Available Agents\n" +
        agents.map((a: Record<string, string | null>) => `- **${a.name}** (${a.slug}): ${a.description || "No description"}`).join("\n")
    );
  }

  const { data: proposedTasks } = await supabase
    .from("tasks")
    .select("title")
    .eq("company_id", companyId)
    .eq("status", "proposed")
    .order("created_at", { ascending: false })
    .limit(50);

  if (proposedTasks?.length) {
    sections.push(
      "## Existing Proposed Tasks (DO NOT duplicate these)\n" +
        proposedTasks.map((t: { title: string }) => `- ${t.title}`).join("\n")
    );
  }

  const { count: activeCount } = await supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .in("status", ["proposed", "pending", "running"]);

  sections.push(`## Pipeline Status\n- Active/proposed tasks: ${activeCount ?? 0}`);

  return sections.join("\n\n");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: "Supabase not configured" });
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const supabase = createClient(supabaseUrl, supabaseKey);
  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const jobRunId = await startJobRun(supabase, "proactive_planner", {});

  // Load all active companies
  const { data: companies, error: compErr } = await supabase
    .from("companies")
    .select("id, name")
    .eq("is_active", true);

  if (compErr || !companies?.length) {
    await finishJobRun(supabase, jobRunId, {
      status: "success",
      companies_processed: 0,
      metadata: { note: "No active companies" },
    });
    return res.status(200).json({ proposed: 0, note: "No active companies" });
  }

  const results: Array<{ company: string; proposed: number; tasks: string[] }> = [];
  let companyFailures = 0;

  for (const comp of companies) {
    try {
      await supabase.from("terminal_logs").insert({
        message: `Proactive planner triggered for ${comp.name} — gathering business context...`,
        source: "proactive-planner",
        log_type: "planner_start",
        company_id: comp.id,
      });

      const context = await getBusinessContext(supabase, comp.id, comp.name);

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        temperature: 0.8,
        system: PLANNER_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Here is the current business state for "${comp.name}". Based on this, propose 1-5 high-value tasks that should be done next.\n\n${context}`,
          },
        ],
      });

      const textContent = response.content.find((b) => b.type === "text");
      const rawText = textContent?.type === "text" ? textContent.text : "[]";

      let tasks: Array<{
        title: string;
        description: string;
        agent_slug: string;
        priority: number;
        tags: string[];
      }>;

      try {
        const jsonMatch = rawText.match(/\[[\s\S]*\]/);
        tasks = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
      } catch {
        await supabase.from("terminal_logs").insert({
          message: `Planner returned unparseable response for ${comp.name}: ${rawText.slice(0, 200)}`,
          source: "proactive-planner",
          log_type: "planner_error",
          company_id: comp.id,
        });
        results.push({ company: comp.name, proposed: 0, tasks: [] });
        continue;
      }

      const { data: agentDefs } = await supabase
        .from("agent_definitions")
        .select("id, slug")
        .eq("company_id", comp.id);

      const slugToId: Record<string, string> = {};
      for (const a of (agentDefs || []) as Array<{ id: string; slug: string }>) slugToId[a.slug] = a.id;

      // Load existing proposed/pending titles for dedup
      const { data: existingTasks } = await supabase
        .from("tasks")
        .select("title")
        .eq("company_id", comp.id)
        .in("status", ["proposed", "pending", "running"])
        .limit(100);

      const normalize = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();

      const existingNorms = new Set(
        (existingTasks || []).map((t: { title: string }) => normalize(t.title))
      );

      // Build trigrams for fuzzy matching
      const trigrams = (s: string) => {
        const t = new Set<string>();
        for (let i = 0; i <= s.length - 3; i++) t.add(s.slice(i, i + 3));
        return t;
      };
      const similarity = (a: string, b: string) => {
        const ta = trigrams(a), tb = trigrams(b);
        let shared = 0;
        for (const g of ta) if (tb.has(g)) shared++;
        return shared / Math.max(ta.size, tb.size, 1);
      };
      const isDuplicate = (title: string) => {
        const norm = normalize(title);
        if (existingNorms.has(norm)) return true;
        for (const existing of existingNorms) {
          if (similarity(norm, existing) > 0.6) return true;
        }
        return false;
      };

      let proposed = 0;
      let skipped = 0;
      for (const t of tasks) {
        const agentId = slugToId[t.agent_slug];
        if (!agentId) continue;

        if (isDuplicate(t.title)) {
          skipped++;
          continue;
        }

        const { error } = await supabase.from("tasks").insert({
          title: t.title,
          description: t.description,
          agent_definition_id: agentId,
          company_id: comp.id,
          status: "proposed",
          priority: t.priority || 5,
          source: "proactive",
          tags: JSON.stringify(t.tags || []),
        });

        if (!error) {
          proposed++;
          existingNorms.add(normalize(t.title));
        }
      }

      if (skipped > 0) {
        await supabase.from("terminal_logs").insert({
          message: `Proactive planner skipped ${skipped} duplicate task(s) for ${comp.name}`,
          source: "proactive-planner",
          log_type: "planner_dedup",
          company_id: comp.id,
        });
      }

      await supabase.from("terminal_logs").insert({
        message: `Proactive planner completed for ${comp.name} — proposed ${proposed} task(s)`,
        source: "proactive-planner",
        log_type: "planner_complete",
        company_id: comp.id,
      });

      results.push({ company: comp.name, proposed, tasks: tasks.map((t) => t.title) });
    } catch (e) {
      companyFailures++;
      const msg = e instanceof Error ? e.message : "Unknown error";
      await supabase.from("terminal_logs").insert({
        message: `Proactive planner error for ${comp.name}: ${msg}`,
        source: "proactive-planner",
        log_type: "planner_error",
        company_id: comp.id,
        metadata: { error: msg },
      });
      results.push({ company: comp.name, proposed: 0, tasks: [] });
    }
  }

  const totalProposed = results.reduce((sum, r) => sum + r.proposed, 0);
  const jobStatus =
    companyFailures > 0 && totalProposed === 0 ? "failed" : companyFailures > 0 ? "partial" : "success";
  await finishJobRun(supabase, jobRunId, {
    status: jobStatus,
    companies_processed: companies.length,
    error_summary: companyFailures > 0 ? `${companyFailures} company error(s)` : null,
    metadata: { total_proposed: totalProposed, results },
  });

  return res.status(200).json({ total_proposed: totalProposed, results });
}
