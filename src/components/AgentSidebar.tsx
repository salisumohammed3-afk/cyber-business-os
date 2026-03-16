import { useAgents, type AgentStatus } from "@/hooks/useSupabaseData";
import { Bot, Cpu, Globe, Maximize2, Megaphone, Rocket, Search, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

const iconMap: Record<string, React.ElementType> = {
  "eng-01": Cpu,
  "browser-01": Globe,
  "meta-01": Megaphone,
  "growth-01": Rocket,
  "research-01": Search,
};

const statusColor: Record<AgentStatus, string> = {
  active: "bg-emerald pulse-active",
  thinking: "bg-amber pulse-thinking",
  idle: "bg-idle",
};

const statusLabel: Record<AgentStatus, string> = {
  active: "Active",
  thinking: "Thinking",
  idle: "Idle",
};

const AgentSidebar = () => {
  const { data: agents = [], isLoading } = useAgents();
  const navigate = useNavigate();

  const handleSurpriseMe = () => {
    toast("🔍 Business Opportunity Search initiated", {
      description: "Research Agent scanning for untapped market segments...",
      duration: 4000,
    });
  };

  return (
    <div className="w-full border-r border-border bg-background flex flex-col h-full">
      <div className="p-3 border-b border-border flex items-center justify-between">
        <span className="font-mono text-[10px] text-muted-foreground tracking-widest uppercase">
          Agent Grid
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
        {isLoading ? (
          <div className="p-4 text-xs text-muted-foreground">Loading agents...</div>
        ) : (
          agents.map((agent) => {
            const Icon = iconMap[agent.id] || Bot;
            return (
              <div
                key={agent.id}
                className="p-2.5 rounded-sm border border-border hover:border-foreground/20 hover:bg-secondary transition-colors cursor-pointer group"
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <Icon size={14} className="text-muted-foreground group-hover:text-foreground transition-colors" />
                  <span className="text-xs font-medium text-foreground">{agent.name}</span>
                  <div className={`w-1.5 h-1.5 rounded-full ml-auto ${statusColor[agent.status]}`} />
                </div>
                <p className="text-[10px] text-muted-foreground leading-tight">{agent.role}</p>
                <div className="flex items-center justify-between mt-2">
                  <span className="font-mono text-[9px] text-muted-foreground">
                    {statusLabel[agent.status]}
                  </span>
                  <span className="font-mono text-[9px] text-muted-foreground">
                    {agent.tasks_completed} runs
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="p-3 border-t border-border">
        <button
          onClick={handleSurpriseMe}
          className="w-full py-2 px-3 rounded-sm bg-primary text-primary-foreground text-xs font-mono font-medium hover:bg-primary/90 transition-colors flex items-center justify-center gap-1.5"
        >
          <Sparkles size={12} />
          Surprise Me
        </button>
      </div>
    </div>
  );
};

export default AgentSidebar;
