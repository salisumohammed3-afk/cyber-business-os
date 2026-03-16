import { useNavigate } from "react-router-dom";
import { ArrowLeft, Bot, Brain, Cpu, Globe, Megaphone, Rocket, Search, Mail, Wrench, Zap, Database, MessageSquare, BookOpen, FileSearch } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAgentDefinitions } from "@/hooks/useSupabaseData";

interface ToolInfo {
  name: string;
  icon: React.ElementType;
  description: string;
}

interface AgentConfig {
  icon: React.ElementType;
  color: string;
  tools: ToolInfo[];
  skills: string[];
}

const allTools: Record<string, ToolInfo> = {
  web_search: { name: "Web Search", icon: Globe, description: "Search the web for real-time data, market research, and news" },
  database_query: { name: "Database Query", icon: Database, description: "Query the business database for metrics, agents, tasks, and history" },
  create_task: { name: "Create Task", icon: Zap, description: "Create and assign tasks to specialist agents" },
  store_memory: { name: "Store Memory", icon: BookOpen, description: "Save important facts and decisions for future reference" },
  recall_memories: { name: "Recall Memories", icon: FileSearch, description: "Search stored memories for relevant context" },
  delegate_task: { name: "Delegate Task", icon: MessageSquare, description: "Delegate work to specialist sub-agents and collect results" },
};

const agentConfigs: Record<string, AgentConfig> = {
  orchestrator: {
    icon: Brain,
    color: "text-emerald-400",
    tools: [allTools.web_search, allTools.database_query, allTools.create_task, allTools.store_memory, allTools.recall_memories, allTools.delegate_task],
    skills: [
      "Receive and interpret CEO directives",
      "Coordinate specialist sub-agents",
      "Synthesize results from multiple agents",
      "Provide concise, actionable responses",
      "Surface insights and propose next steps",
      "Store and recall business context across conversations",
    ],
  },
  engineering: {
    icon: Cpu,
    color: "text-blue-400",
    tools: [allTools.web_search, allTools.database_query, allTools.store_memory, allTools.recall_memories],
    skills: [
      "Software architecture and system design",
      "Code review and technical debt assessment",
      "Infrastructure and deployment strategy",
      "Performance optimization",
      "Security best practices",
      "Effort estimation in hours/days",
    ],
  },
  growth: {
    icon: Rocket,
    color: "text-purple-400",
    tools: [allTools.web_search, allTools.database_query, allTools.store_memory, allTools.recall_memories],
    skills: [
      "User acquisition and activation strategies",
      "Retention and churn analysis",
      "Product-market fit assessment",
      "Growth experiment design (A/B tests)",
      "Funnel optimization and conversion rates",
      "ICE scoring (Impact, Confidence, Ease)",
    ],
  },
  sales: {
    icon: Megaphone,
    color: "text-amber-400",
    tools: [allTools.web_search, allTools.database_query, allTools.store_memory, allTools.recall_memories],
    skills: [
      "Pipeline management and deal qualification",
      "Pricing strategy and packaging",
      "Outbound outreach and email sequences",
      "Discovery calls and demo preparation",
      "Competitive positioning",
      "Revenue forecasting",
    ],
  },
  research: {
    icon: Search,
    color: "text-cyan-400",
    tools: [allTools.web_search, allTools.database_query, allTools.store_memory, allTools.recall_memories],
    skills: [
      "Market size estimation (TAM/SAM/SOM)",
      "Competitive landscape analysis",
      "Industry trend identification",
      "Customer and user research synthesis",
      "Technology scouting",
      "Structured frameworks (PESTLE, Porter's 5, SWOT)",
    ],
  },
  outreach: {
    icon: Mail,
    color: "text-orange-400",
    tools: [allTools.web_search, allTools.database_query, allTools.store_memory, allTools.recall_memories],
    skills: [
      "Cold email and LinkedIn outreach",
      "Lead scoring and qualification",
      "Personalization at scale",
      "Follow-up sequences and cadence design",
      "ICP (Ideal Customer Profile) refinement",
      "Response handling and objection management",
    ],
  },
};

const specialistSlugs = ["engineering", "growth", "sales", "research", "outreach"];

function OrgChart({ agents }: { agents: Array<{ slug: string; name: string | null; description: string | null; model: string | null }> }) {
  const orchestrator = agents.find(a => a.slug === "orchestrator");
  const specialists = agents.filter(a => specialistSlugs.includes(a.slug));

  return (
    <div className="flex flex-col items-center gap-0 py-8 px-4">
      <p className="text-sm text-muted-foreground mb-8 text-center max-w-lg">
        The Orchestrator receives your directives and coordinates specialist agents as needed. Each agent has its own system prompt, tools, and expertise.
      </p>

      {/* Orchestrator card */}
      <Card className="w-80 border-emerald-500/30 bg-emerald-500/5">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <Brain size={20} className="text-emerald-400" />
            </div>
            <div>
              <CardTitle className="text-sm">{orchestrator?.name || "Orchestrator"}</CardTitle>
              <CardDescription className="text-xs">CEO's right-hand AI</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex flex-wrap gap-1 mt-1">
            <Badge variant="outline" className="text-[10px] font-mono">{orchestrator?.model || "claude-sonnet"}</Badge>
            <Badge variant="secondary" className="text-[10px]">6 tools</Badge>
            <Badge variant="secondary" className="text-[10px]">Delegates work</Badge>
          </div>
        </CardContent>
      </Card>

      {/* Connector lines */}
      <svg width="100%" height="60" className="max-w-3xl" viewBox="0 0 800 60" preserveAspectRatio="xMidYMid meet">
        <line x1="400" y1="0" x2="400" y2="30" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
        <line x1="80" y1="30" x2="720" y2="30" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
        {specialists.map((_, i) => {
          const x = 80 + (i * (640 / Math.max(specialists.length - 1, 1)));
          return <line key={i} x1={x} y1="30" x2={x} y2="60" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />;
        })}
      </svg>

      {/* Specialist agent cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 w-full max-w-4xl">
        {specialists.map(agent => {
          const config = agentConfigs[agent.slug] || { icon: Bot, color: "text-muted-foreground", tools: [], skills: [] };
          const Icon = config.icon;
          return (
            <Card key={agent.slug} className="hover:border-foreground/20 transition-colors">
              <CardHeader className="pb-2 px-3 pt-3">
                <div className="flex items-center gap-2">
                  <div className={`w-8 h-8 rounded-lg bg-secondary flex items-center justify-center`}>
                    <Icon size={16} className={config.color} />
                  </div>
                  <div className="min-w-0">
                    <CardTitle className="text-xs truncate">{agent.name}</CardTitle>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="px-3 pb-3 pt-0">
                <p className="text-[10px] text-muted-foreground leading-snug line-clamp-2">{agent.description}</p>
                <div className="flex flex-wrap gap-1 mt-2">
                  <Badge variant="outline" className="text-[9px] font-mono">{config.tools.length} tools</Badge>
                  <Badge variant="outline" className="text-[9px] font-mono">{config.skills.length} skills</Badge>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Data flow explanation */}
      <div className="mt-10 max-w-2xl w-full">
        <h3 className="font-mono text-[10px] text-muted-foreground tracking-widest uppercase mb-3">How It Works</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-3 rounded-sm border border-border">
            <div className="text-xs font-medium mb-1">1. You direct</div>
            <p className="text-[10px] text-muted-foreground">Send a message in the CEO chat. The Orchestrator receives it.</p>
          </div>
          <div className="p-3 rounded-sm border border-border">
            <div className="text-xs font-medium mb-1">2. Agents execute</div>
            <p className="text-[10px] text-muted-foreground">The Orchestrator uses tools or delegates to specialists who have domain expertise.</p>
          </div>
          <div className="p-3 rounded-sm border border-border">
            <div className="text-xs font-medium mb-1">3. Results synthesized</div>
            <p className="text-[10px] text-muted-foreground">Results flow back to you as a clear, actionable response with memories stored for context.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentDetail({ agent, config }: {
  agent: { name: string | null; slug: string; description: string | null; model: string | null; temperature: number; max_turns: number };
  config: AgentConfig;
}) {
  const Icon = config.icon;

  return (
    <div className="py-6 px-4">
      {/* Agent header */}
      <div className="flex items-center gap-4 mb-6">
        <div className={`w-12 h-12 rounded-lg bg-secondary flex items-center justify-center`}>
          <Icon size={24} className={config.color} />
        </div>
        <div>
          <h2 className="text-lg font-medium">{agent.name}</h2>
          <p className="text-sm text-muted-foreground">{agent.description}</p>
        </div>
        <div className="ml-auto flex gap-2">
          <Badge variant="outline" className="font-mono text-xs">{agent.model}</Badge>
          <Badge variant="secondary" className="text-xs">temp: {agent.temperature}</Badge>
          <Badge variant="secondary" className="text-xs">max turns: {agent.max_turns}</Badge>
        </div>
      </div>

      {/* Tools and Skills columns */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Tools column */}
        <div>
          <div className="flex items-center gap-2 mb-4 pb-2 border-b border-border">
            <Wrench size={14} className="text-muted-foreground" />
            <h3 className="font-mono text-xs tracking-widest uppercase text-muted-foreground">Tools</h3>
          </div>
          <div className="space-y-2">
            {config.tools.map(tool => (
              <div key={tool.name} className="flex items-start gap-3 p-3 rounded-sm border border-border hover:border-foreground/20 transition-colors">
                <div className="w-8 h-8 rounded bg-secondary flex items-center justify-center shrink-0 mt-0.5">
                  <tool.icon size={14} className="text-muted-foreground" />
                </div>
                <div>
                  <div className="text-xs font-medium">{tool.name}</div>
                  <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">{tool.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Skills column */}
        <div>
          <div className="flex items-center gap-2 mb-4 pb-2 border-b border-border">
            <Zap size={14} className="text-muted-foreground" />
            <h3 className="font-mono text-xs tracking-widest uppercase text-muted-foreground">Skills</h3>
          </div>
          <div className="space-y-2">
            {config.skills.map((skill, i) => (
              <div key={i} className="flex items-center gap-3 p-3 rounded-sm border border-border">
                <div className="w-2 h-2 rounded-full bg-foreground/20 shrink-0" />
                <span className="text-xs">{skill}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const Agents = () => {
  const navigate = useNavigate();
  const { data: agentDefs = [], isLoading } = useAgentDefinitions();

  const typedAgents = (agentDefs as Array<{
    id: string;
    name: string | null;
    slug: string;
    description: string | null;
    system_prompt: string | null;
    model: string | null;
    temperature: number;
    max_turns: number;
    is_orchestrator: boolean;
  }>) || [];

  const tabAgents = typedAgents.filter(a => specialistSlugs.includes(a.slug));

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Header */}
      <div className="h-12 border-b border-border flex items-center px-4 gap-3 shrink-0">
        <button
          onClick={() => navigate("/")}
          className="p-1.5 rounded-sm hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-muted-foreground" />
          <span className="font-mono text-sm font-medium">Agent Dashboard</span>
        </div>
        {!isLoading && (
          <Badge variant="secondary" className="ml-2 text-[10px]">{typedAgents.length} agents</Badge>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-sm text-muted-foreground">Loading agents...</span>
          </div>
        ) : (
          <Tabs defaultValue="overview" className="w-full">
            <div className="border-b border-border bg-secondary/30 px-4">
              <TabsList className="bg-transparent h-10 gap-0">
                <TabsTrigger value="overview" className="font-mono text-xs data-[state=active]:bg-background rounded-b-none">
                  Overview
                </TabsTrigger>
                {tabAgents.map(agent => {
                  const config = agentConfigs[agent.slug];
                  const Icon = config?.icon || Bot;
                  return (
                    <TabsTrigger key={agent.slug} value={agent.slug} className="font-mono text-xs data-[state=active]:bg-background rounded-b-none gap-1.5">
                      <Icon size={12} className={config?.color || "text-muted-foreground"} />
                      {agent.name}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </div>

            <TabsContent value="overview" className="mt-0">
              <OrgChart agents={typedAgents} />
            </TabsContent>

            {tabAgents.map(agent => {
              const config = agentConfigs[agent.slug] || { icon: Bot, color: "text-muted-foreground", tools: [], skills: [] };
              return (
                <TabsContent key={agent.slug} value={agent.slug} className="mt-0">
                  <AgentDetail agent={agent} config={config} />
                </TabsContent>
              );
            })}
          </Tabs>
        )}
      </div>
    </div>
  );
};

export default Agents;
