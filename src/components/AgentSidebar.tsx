import { useAgentDefinitions } from "@/hooks/useSupabaseData";
import { Bot, Cpu, Globe, Maximize2, Megaphone, Rocket, Search, Palette, Briefcase } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCompany } from "@/contexts/CompanyContext";

// Maps a slug from agent_definitions to a nicer icon. Falls back to Bot.
const iconBySlug: Record<string, React.ElementType> = {
  orchestrator: Megaphone,
  engineering: Cpu,
  research: Search,
  growth: Rocket,
  designer: Palette,
  "executive-assistant": Briefcase,
  browser: Globe,
};

interface AgentDef {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

const AgentSidebar = () => {
  const { data: agents = [], isLoading } = useAgentDefinitions();
  const { company, loading: companyLoading } = useCompany();
  const navigate = useNavigate();

  // Per-agent live state: how many tasks completed lifetime, and whether one
  // is running RIGHT NOW. Cheap query, refreshes every 8s.
  const [stats, setStats] = useState<Record<string, { completed: number; running: boolean }>>({});

  useEffect(() => {
    if (!company?.id) return;
    let cancelled = false;
    const refresh = async () => {
      const { data: tasks } = await supabase
        .from("tasks")
        .select("agent_definition_id,status")
        .eq("company_id", company.id);
      if (cancelled || !tasks) return;
      const next: Record<string, { completed: number; running: boolean }> = {};
      for (const t of tasks as Array<{ agent_definition_id: string | null; status: string }>) {
        const k = t.agent_definition_id;
        if (!k) continue;
        if (!next[k]) next[k] = { completed: 0, running: false };
        if (t.status === "completed") next[k].completed++;
        if (t.status === "running" || t.status === "pending") next[k].running = true;
      }
      setStats(next);
    };
    refresh();
    const i = setInterval(refresh, 8_000);
    return () => { cancelled = true; clearInterval(i); };
  }, [company?.id]);

  return (
    <div className="w-full border-r border-border bg-background flex flex-col h-full">
      <div className="p-3 border-b border-border flex items-center justify-between">
        <span className="font-mono text-[10px] text-muted-foreground tracking-widest uppercase">
          Agents
        </span>
        <button
          onClick={() => navigate("/agents")}
          className="p-1 rounded-sm hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          title="Open Agent Dashboard"
        >
          <Maximize2 size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {(companyLoading || isLoading) && (
          <div className="p-4 text-xs text-muted-foreground">Loading agents…</div>
        )}
        {!companyLoading && !isLoading && !company && (
          <div className="p-4 text-xs text-muted-foreground italic">
            Select a company to see its team.
          </div>
        )}
        {!companyLoading && !isLoading && company && agents.length === 0 && (
          <div className="p-4 text-xs text-muted-foreground italic">
            No agents configured for this company yet.
          </div>
        )}
        {!isLoading && (agents as AgentDef[]).map((agent) => {
          const Icon = iconBySlug[agent.slug] || Bot;
          const s = stats[agent.id];
          const running = !!s?.running;
          return (
            <div
              key={agent.id}
              onClick={() => navigate("/agents")}
              className="p-2.5 rounded-sm border border-border hover:border-foreground/20 hover:bg-secondary transition-colors cursor-pointer group"
              title={agent.description || agent.slug}
            >
              <div className="flex items-center gap-2 mb-1">
                <Icon size={14} className="text-muted-foreground group-hover:text-foreground transition-colors" />
                <span className="text-xs font-medium text-foreground truncate">{agent.name}</span>
                <div
                  className={
                    "w-1.5 h-1.5 rounded-full ml-auto " +
                    (running ? "bg-amber-500 animate-pulse" : "bg-gray-300")
                  }
                  title={running ? "Has a task pending or running" : "Idle"}
                />
              </div>
              <p className="text-[10px] text-muted-foreground leading-tight font-mono">
                {agent.slug}
              </p>
              {s && s.completed > 0 && (
                <p className="text-[9px] text-muted-foreground mt-1 font-mono">
                  {s.completed} completed
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AgentSidebar;
