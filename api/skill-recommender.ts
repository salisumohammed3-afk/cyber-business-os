import Anthropic from "@anthropic-ai/sdk";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 120;

const RECOMMENDER_PROMPT = `You are an AI agent reflecting on your recent work. Based on your tasks, failures, and current capabilities, suggest 1-3 skills that would make you significantly more effective.

A "skill" is a markdown instruction document that gets injected into your system prompt. It teaches you HOW to do something specific — patterns, best practices, step-by-step workflows, API usage guides, etc.

For each skill recommendation:
- "title": A short, specific name (e.g. "Supabase RLS Patterns", "Cold Email Playbook for SaaS", "GitHub Actions CI/CD")
- "reason": WHY you need this — reference specific tasks you struggled with or opportunities you missed. Be honest and concrete.
- "suggested_content": Draft starter content for the skill in markdown. Include headers, steps, examples. Make it actionable. 200-500 words.
- "priority": 1-10 (10 = most impactful)

Respond ONLY with a JSON array. Example:
[
  {
    "title": "Apollo API Contact Search",
    "reason": "I was asked to find contacts at Nike but couldn't effectively use Apollo's search filters. 2 of my last 5 tasks involved contact lookup and I returned shallow results.",
    "suggested_content": "# Apollo Contact Search\\n\\n## Finding People\\n1. Use composio_find_actions(\\"apollo\\", \\"search people\\")\\n2. Filter by title, company, location...",
    "priority": 9
  }
]`;

interface AgentContext {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  system_prompt: string | null;
}

async function getAgentContext(
  supabase: SupabaseClient,
  agent: AgentContext,
  companyId: string,
): Promise<string> {
  const sections: string[] = [];

  sections.push(`You are: ${agent.name} (${agent.slug})`);
  if (agent.description) sections.push(`Role: ${agent.description}`);

  const { data: recentTasks } = await supabase
    .from("tasks")
    .select("title, status, error_message, created_at")
    .eq("company_id", companyId)
    .eq("agent_definition_id", agent.id)
    .order("created_at", { ascending: false })
    .limit(15);

  if (recentTasks?.length) {
    sections.push(
      "## Your Recent Tasks (last 7 days)\n" +
        (recentTasks as Array<{ title: string; status: string; error_message: string | null; created_at: string }>)
          .map((t) => {
            let line = `- [${t.status}] ${t.title}`;
            if (t.error_message) line += ` — ERROR: ${t.error_message.slice(0, 100)}`;
            return line;
          })
          .join("\n"),
    );

    const failed = (recentTasks as Array<{ status: string }>).filter((t) => t.status === "failed").length;
    const completed = (recentTasks as Array<{ status: string }>).filter((t) => t.status === "completed").length;
    sections.push(`Completed: ${completed}, Failed: ${failed}, Total: ${recentTasks.length}`);
  } else {
    sections.push("## Your Recent Tasks\nNo tasks in the last 7 days.");
  }

  const { data: skillLinks } = await supabase
    .from("agent_skill_links")
    .select("skills(name, description)")
    .eq("agent_definition_id", agent.id)
    .eq("is_active", true);

  if (skillLinks?.length) {
    sections.push(
      "## Your Current Skills\n" +
        (skillLinks as Array<{ skills: { name: string; description: string | null } | null }>)
          .filter((l) => l.skills)
          .map((l) => `- ${l.skills!.name}${l.skills!.description ? ": " + l.skills!.description : ""}`)
          .join("\n"),
    );
  } else {
    sections.push("## Your Current Skills\nNone installed yet.");
  }

  const { data: tools } = await supabase
    .from("agent_tools")
    .select("tool_name, tool_type")
    .eq("agent_id", agent.id)
    .eq("is_enabled", true);

  if (tools?.length) {
    sections.push(
      "## Your Tools\n" +
        (tools as Array<{ tool_name: string; tool_type: string }>)
          .map((t) => `- ${t.tool_name} (${t.tool_type})`)
          .join("\n"),
    );
  }

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

  const { data: companies } = await supabase
    .from("companies")
    .select("id, name")
    .eq("is_active", true);

  if (!companies?.length) {
    return res.status(200).json({ recommendations: 0, note: "No active companies" });
  }

  let totalRecs = 0;

  for (const comp of companies) {
    try {
      const { data: agents } = await supabase
        .from("agent_definitions")
        .select("id, slug, name, description, system_prompt")
        .eq("company_id", comp.id)
        .eq("is_orchestrator", false);

      if (!agents?.length) continue;

      for (const agent of agents as AgentContext[]) {
        try {
          const context = await getAgentContext(supabase, agent, comp.id);

          const response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            temperature: 0.8,
            system: RECOMMENDER_PROMPT,
            messages: [
              {
                role: "user",
                content: `Reflect on your recent work and suggest skills you need.\n\n${context}`,
              },
            ],
          });

          const textContent = response.content.find((b) => b.type === "text");
          const rawText = textContent?.type === "text" ? textContent.text : "[]";

          let recs: Array<{
            title: string;
            reason: string;
            suggested_content?: string;
            priority: number;
          }>;

          try {
            const jsonMatch = rawText.match(/\[[\s\S]*\]/);
            recs = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
          } catch {
            continue;
          }

          if (!recs.length) continue;

          // Clear old pending recommendations for this agent
          await supabase
            .from("skill_recommendations")
            .delete()
            .eq("agent_definition_id", agent.id)
            .eq("status", "pending");

          for (const rec of recs) {
            const { error } = await supabase.from("skill_recommendations").insert({
              agent_definition_id: agent.id,
              company_id: comp.id,
              title: rec.title,
              reason: rec.reason,
              suggested_content: rec.suggested_content || null,
              priority: Math.min(10, Math.max(1, rec.priority || 5)),
              status: "pending",
            });
            if (!error) totalRecs++;
          }

          await supabase.from("terminal_logs").insert({
            message: `Skill recommender: ${agent.name} suggested ${recs.length} skill(s)`,
            source: "skill-recommender",
            log_type: "recommender",
            company_id: comp.id,
          });
        } catch {
          // Individual agent failure doesn't stop the loop
        }
      }
    } catch {
      // Company-level failure doesn't stop the loop
    }
  }

  return res.status(200).json({ total_recommendations: totalRecs });
}
