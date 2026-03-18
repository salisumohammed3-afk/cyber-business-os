import Anthropic from "@anthropic-ai/sdk";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 60;

const PLANNER_SYSTEM_PROMPT = `You are the Proactive Planner for a Cyber Business Operating System. Your job is to review the current state of the business — recent tasks, agent capabilities, stored memories, and ongoing work — then propose 1-5 high-value tasks that should be done next.

Each task you propose should be:
- Actionable and specific (not vague like "improve things")
- Assigned to the most appropriate specialist agent
- Prioritized by business impact

Available agents and their strengths:
- orchestrator: Overall coordination, strategy, user communication
- sales: Revenue generation, pipeline management, lead research (has Apollo, LinkedIn)
- outreach: Cold email, campaigns, relationship building (has AgentMail, LinkedIn)
- research: Market research, competitive intelligence, trend analysis (has Exa, Firecrawl)
- growth: User acquisition, ad campaigns, growth experiments (has Meta Ads, ElevenLabs)
- engineering: Technical development, architecture, code review
- designer: UI/UX design, mockups, design system
- browser: Web automation, scraping, form filling (has Firecrawl)
- taskmaster: Project management, board management

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

async function getBusinessContext(supabase: SupabaseClient): Promise<string> {
  const sections: string[] = [];

  const { data: recentTasks } = await supabase
    .from("tasks")
    .select("title, status, source, created_at")
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
    .select("slug, name, description");

  if (agents?.length) {
    sections.push(
      "## Available Agents\n" +
        agents.map((a: Record<string, string | null>) => `- **${a.name}** (${a.slug}): ${a.description || "No description"}`).join("\n")
    );
  }

  const { count: activeCount } = await supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
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

  try {
    await supabase.from("terminal_logs").insert({
      message: "Proactive planner triggered — gathering business context...",
      source: "proactive-planner",
      log_type: "planner_start",
    });

    const context = await getBusinessContext(supabase);

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      temperature: 0.8,
      system: PLANNER_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Here is the current business state. Based on this, propose 1-5 high-value tasks that should be done next.\n\n${context}`,
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
        message: `Planner returned unparseable response: ${rawText.slice(0, 200)}`,
        source: "proactive-planner",
        log_type: "planner_error",
      });
      return res.status(200).json({ proposed: 0, error: "Failed to parse planner response" });
    }

    const { data: agentDefs } = await supabase.from("agent_definitions").select("id, slug");
    const slugToId: Record<string, string> = {};
    for (const a of (agentDefs || []) as Array<{ id: string; slug: string }>) slugToId[a.slug] = a.id;

    let proposed = 0;
    for (const t of tasks) {
      const agentId = slugToId[t.agent_slug];
      if (!agentId) continue;

      const { error } = await supabase.from("tasks").insert({
        title: t.title,
        description: t.description,
        agent_definition_id: agentId,
        status: "proposed",
        priority: t.priority || 5,
        source: "proactive",
        tags: JSON.stringify(t.tags || []),
      });

      if (!error) proposed++;
    }

    await supabase.from("terminal_logs").insert({
      message: `Proactive planner completed — proposed ${proposed} task(s)`,
      source: "proactive-planner",
      log_type: "planner_complete",
    });

    return res.status(200).json({ proposed, tasks: tasks.map((t) => t.title) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await supabase.from("terminal_logs").insert({
      message: `Proactive planner error: ${msg}`,
      source: "proactive-planner",
      log_type: "planner_error",
    });
    return res.status(500).json({ error: msg });
  }
}
