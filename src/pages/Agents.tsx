import { useNavigate } from "react-router-dom";
import { ArrowLeft, Bot, Brain, Cpu, Globe, Rocket, Search, Wrench, Zap, Database, MessageSquare, BookOpen, FileSearch, Link2, Plus, Trash2, ToggleLeft, ToggleRight, Palette, Briefcase, Lightbulb, Download, XCircle, ChevronDown, ChevronRight, Package } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAgentDefinitions, useAgentTools, useAgentSkillLinks, useSkillMutations, useSkillRecommendations, useSkillRecommendationMutations, type AgentToolRow, type SkillLinkRow, type SkillRecommendationRow } from "@/hooks/useSupabaseData";
import { useMemo, useState } from "react";
import AddSkillModal, { type SkillPrefill } from "@/components/AddSkillModal";

interface ToolInfo {
  name: string;
  icon: React.ElementType;
  description: string;
  isExternal?: boolean;
}

interface AgentConfig {
  icon: React.ElementType;
  color: string;
  skills: string[];
}

const localTools: Record<string, ToolInfo> = {
  web_search: { name: "Web Search", icon: Globe, description: "Search the web for real-time data, market research, and news" },
  database_query: { name: "Database Query", icon: Database, description: "Query the business database for metrics, agents, tasks, and history" },
  create_task: { name: "Create Task", icon: Zap, description: "Propose tasks for specialist agents (requires user approval)" },
  store_memory: { name: "Store Memory", icon: BookOpen, description: "Save important facts and decisions for future reference" },
  recall_memories: { name: "Recall Memories", icon: FileSearch, description: "Search stored memories for relevant context" },
  delegate_task: { name: "Delegate Task", icon: MessageSquare, description: "Propose work for specialist sub-agents (requires user approval)" },
  fail_task: { name: "Fail Task", icon: XCircle, description: "Mark a task as failed with an error message when it cannot be completed" },
};

const composioToolMeta: Record<string, { label: string; description: string }> = {
  apollo: { label: "Apollo", description: "People and company search, lead enrichment, contact discovery" },
  linkedin: { label: "LinkedIn", description: "Professional networking, prospect research, connection outreach" },
  agent_mail: { label: "AgentMail", description: "Send and manage emails from the agent's dedicated email address" },
  gmail: { label: "Gmail", description: "Send, read, and manage email campaigns" },
  exa: { label: "Exa", description: "AI-powered web search for deep research and content discovery" },
  firecrawl: { label: "Firecrawl", description: "Web scraping, crawling, and structured data extraction" },
  metaads: { label: "Meta Ads", description: "Create, manage, and optimize Facebook/Instagram ad campaigns" },
  elevenlabs: { label: "ElevenLabs", description: "Text-to-speech, voice generation, and audio content creation" },
  slack: { label: "Slack", description: "Team messaging, channel management, and notifications" },
  instantly: { label: "Instantly", description: "Cold email automation and deliverability optimization" },
  googlecalendar: { label: "Google Calendar", description: "Schedule meetings, manage events, and check availability" },
  monday: { label: "Monday.com", description: "Project boards, task tracking, and team collaboration" },
  figma: { label: "Figma", description: "Design file access, component inspection, and asset export" },
};

const orchestratorLocalTools = ["delegate_task", "create_task", "database_query", "store_memory", "recall_memories", "fail_task"];
const specialistLocalTools = ["web_search", "database_query", "store_memory", "recall_memories"];

const agentConfigs: Record<string, AgentConfig> = {
  orchestrator: {
    icon: Brain,
    color: "text-emerald-400",
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
    skills: [
      "Software architecture and system design",
      "Code review and technical debt assessment",
      "Infrastructure and deployment strategy",
      "Performance optimization",
      "Web scraping and browser automation",
      "Security best practices",
    ],
  },
  growth: {
    icon: Rocket,
    color: "text-purple-400",
    skills: [
      "User acquisition and activation strategies",
      "Growth experiments and funnel optimization",
      "Pipeline management and deal qualification",
      "Pricing strategy and revenue forecasting",
      "Cold email and LinkedIn outreach",
      "Lead scoring and ICP refinement",
      "Follow-up sequences and cadence design",
      "Retention and churn analysis",
    ],
  },
  research: {
    icon: Search,
    color: "text-cyan-400",
    skills: [
      "Market size estimation (TAM/SAM/SOM)",
      "Competitive landscape analysis",
      "Industry trend identification",
      "Customer and user research synthesis",
      "Technology scouting",
      "Structured frameworks (PESTLE, Porter's 5, SWOT)",
    ],
  },
  designer: {
    icon: Palette,
    color: "text-pink-400",
    skills: [
      "UI/UX design review",
      "Design system management",
      "Visual asset creation guidance",
      "Brand consistency verification",
    ],
  },
  "executive-assistant": {
    icon: Briefcase,
    color: "text-teal-400",
    skills: [
      "Email triage and drafting",
      "Meeting notes to action items",
      "Monday.com board management",
      "Client reporting and status updates",
      "Calendar and scheduling coordination",
    ],
  },
};

const specialistSlugs = ["engineering", "growth", "research", "designer", "executive-assistant"];
const allAgentSlugs = ["orchestrator", ...specialistSlugs];

function buildToolList(
  slug: string,
  agentId: string | undefined,
  externalTools: AgentToolRow[]
): ToolInfo[] {
  const localKeys = slug === "orchestrator" ? orchestratorLocalTools : specialistLocalTools;
  const tools: ToolInfo[] = localKeys.map((k) => localTools[k]).filter(Boolean);

  if (agentId) {
    const agentExternal = externalTools.filter((t) => t.agent_id === agentId);
    for (const ext of agentExternal) {
      const meta = composioToolMeta[ext.tool_name] || { label: ext.tool_name, description: `Connected via Composio (${ext.connection_source})` };
      tools.push({
        name: meta.label,
        icon: Link2,
        description: meta.description,
        isExternal: true,
      });
    }
  }

  return tools;
}

function OrgChart({
  agents,
  externalTools,
}: {
  agents: Array<{ id: string; slug: string; name: string | null; description: string | null; model: string | null }>;
  externalTools: AgentToolRow[];
}) {
  const orchestrator = agents.find((a) => a.slug === "orchestrator");
  const specialists = agents.filter((a) => specialistSlugs.includes(a.slug));

  const orchTools = buildToolList("orchestrator", orchestrator?.id, externalTools);

  return (
    <div className="flex flex-col items-center gap-0 py-8 px-4">
      <p className="text-sm text-muted-foreground mb-8 text-center max-w-lg">
        The Orchestrator receives Sal's directives and coordinates specialist agents as needed. Each agent has its own system prompt, tools, and expertise.
      </p>

      <Card className="w-80 border-emerald-500/30 bg-emerald-500/5">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <Brain size={20} className="text-emerald-400" />
            </div>
            <div className="text-left">
              <CardTitle className="text-sm">{orchestrator?.name || "Orchestrator"}</CardTitle>
              <CardDescription className="text-xs">Sal's right-hand AI</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex flex-wrap gap-1 mt-1 justify-center">
            <Badge variant="outline" className="text-[10px] font-mono">{orchestrator?.model || "claude-sonnet"}</Badge>
            <Badge variant="secondary" className="text-[10px]">{orchTools.length} tools</Badge>
            <Badge variant="secondary" className="text-[10px]">Delegates work</Badge>
          </div>
        </CardContent>
      </Card>

      <svg width="100%" height="60" className="max-w-3xl" viewBox="0 0 800 60" preserveAspectRatio="xMidYMid meet">
        <line x1="400" y1="0" x2="400" y2="30" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
        <line x1="80" y1="30" x2="720" y2="30" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
        {specialists.map((_, i) => {
          const x = 80 + i * (640 / Math.max(specialists.length - 1, 1));
          return <line key={i} x1={x} y1="30" x2={x} y2="60" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />;
        })}
      </svg>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 w-full max-w-4xl">
        {specialists.map((agent) => {
          const config = agentConfigs[agent.slug] || { icon: Bot, color: "text-muted-foreground", skills: [] };
          const Icon = config.icon;
          const tools = buildToolList(agent.slug, agent.id, externalTools);
          return (
            <Card key={agent.slug} className="hover:border-foreground/20 transition-colors">
              <CardHeader className="pb-2 px-3 pt-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center">
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
                  <Badge variant="outline" className="text-[9px] font-mono">{tools.length} tools</Badge>
                  <Badge variant="outline" className="text-[9px] font-mono">{config.skills.length} skills</Badge>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="mt-10 max-w-2xl w-full">
        <h3 className="font-mono text-[10px] text-muted-foreground tracking-widest uppercase mb-3">How It Works</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-3 rounded-sm border border-border">
            <div className="text-xs font-medium mb-1">1. Sal directs</div>
            <p className="text-[10px] text-muted-foreground">Sal sends a message in the chat. The Orchestrator receives it and plans the work.</p>
          </div>
          <div className="p-3 rounded-sm border border-border">
            <div className="text-xs font-medium mb-1">2. Agents execute</div>
            <p className="text-[10px] text-muted-foreground">The Orchestrator uses tools or delegates to specialists who have domain expertise.</p>
          </div>
          <div className="p-3 rounded-sm border border-border">
            <div className="text-xs font-medium mb-1">3. Results to Sal</div>
            <p className="text-[10px] text-muted-foreground">Results flow back to Sal as a clear, actionable response with memories stored for context.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function extractRepoName(url: string): string {
  const match = url.replace(/\.git$/, "").match(/github\.com\/([^/]+)\/([^/]+)/);
  return match ? match[2].replace(/[-_]/g, " ") : url;
}

interface SkillGroup {
  key: string;
  label: string;
  sourceUrl: string | null;
  links: SkillLinkRow[];
}

function groupSkillLinks(links: SkillLinkRow[]): SkillGroup[] {
  const grouped = new Map<string, SkillLinkRow[]>();
  const ungrouped: SkillLinkRow[] = [];

  for (const link of links) {
    const src = link.skill?.source_url;
    if (src) {
      const existing = grouped.get(src) || [];
      existing.push(link);
      grouped.set(src, existing);
    } else {
      ungrouped.push(link);
    }
  }

  const result: SkillGroup[] = [];

  for (const [sourceUrl, groupLinks] of grouped) {
    if (groupLinks.length >= 2) {
      result.push({
        key: sourceUrl,
        label: extractRepoName(sourceUrl),
        sourceUrl,
        links: groupLinks,
      });
    } else {
      ungrouped.push(...groupLinks);
    }
  }

  for (const link of ungrouped) {
    result.push({
      key: link.id,
      label: link.skill?.name || "Unknown",
      sourceUrl: link.skill?.source_url || null,
      links: [link],
    });
  }

  return result;
}

function SkillLinkItem({ link }: { link: SkillLinkRow }) {
  const { toggleSkillLink, removeSkillLink } = useSkillMutations();
  return (
    <div
      className={`flex items-start gap-3 p-3 rounded-sm border transition-colors ${
        link.is_active ? "border-border hover:border-foreground/20" : "border-border/50 opacity-60"
      }`}
    >
      <div className={`w-2 h-2 rounded-full shrink-0 mt-1.5 ${link.is_active ? "bg-violet-500" : "bg-foreground/20"}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium truncate">{link.skill?.name || "Unknown"}</span>
          {link.skill?.source_url && (
            <Badge variant="outline" className="text-[8px] px-1 py-0 h-3.5 shrink-0">github</Badge>
          )}
        </div>
        {link.skill?.description && (
          <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug line-clamp-2">{link.skill.description}</p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => toggleSkillLink.mutate({ linkId: link.id, isActive: !link.is_active })}
          className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          title={link.is_active ? "Disable" : "Enable"}
        >
          {link.is_active ? <ToggleRight size={14} className="text-violet-400" /> : <ToggleLeft size={14} />}
        </button>
        <button
          onClick={() => removeSkillLink.mutate(link.id)}
          className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"
          title="Remove"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

function SkillGroupAccordion({ group }: { group: SkillGroup }) {
  const [open, setOpen] = useState(false);
  const activeCount = group.links.filter((l) => l.is_active).length;
  return (
    <div className="border border-border rounded-sm overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 p-3 text-left hover:bg-secondary/50 transition-colors"
      >
        {open ? <ChevronDown size={12} className="text-muted-foreground shrink-0" /> : <ChevronRight size={12} className="text-muted-foreground shrink-0" />}
        <Package size={13} className="text-violet-400 shrink-0" />
        <span className="text-xs font-medium flex-1 truncate capitalize">{group.label}</span>
        <Badge variant="secondary" className="text-[9px] shrink-0">{activeCount}/{group.links.length}</Badge>
        <Badge variant="outline" className="text-[8px] px-1 py-0 h-3.5 shrink-0">github</Badge>
      </button>
      {open && (
        <div className="border-t border-border bg-secondary/20 p-2 space-y-1.5">
          {group.links.map((link) => (
            <SkillLinkItem key={link.id} link={link} />
          ))}
        </div>
      )}
    </div>
  );
}

function SkillsList({ agentLinks, agentId, onAddSkill }: { agentLinks: SkillLinkRow[]; agentId: string; onAddSkill: (id: string) => void }) {
  const groups = useMemo(() => groupSkillLinks(agentLinks), [agentLinks]);

  if (agentLinks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center border border-dashed border-border rounded-md">
        <BookOpen size={20} className="text-muted-foreground/40 mb-2" />
        <p className="text-xs text-muted-foreground">No skills assigned</p>
        <button
          onClick={() => onAddSkill(agentId)}
          className="mt-2 text-[10px] text-violet-400 hover:text-violet-300 transition-colors"
        >
          Add your first skill
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {groups.map((group) =>
        group.links.length > 1 ? (
          <SkillGroupAccordion key={group.key} group={group} />
        ) : (
          <SkillLinkItem key={group.key} link={group.links[0]} />
        )
      )}
    </div>
  );
}

function AgentDetail({
  agent,
  tools,
  config,
  skillLinks,
  recommendations,
  onAddSkill,
  onInstallRecommendation,
}: {
  agent: { id: string; name: string | null; slug: string; description: string | null; model: string | null; temperature: number; max_turns: number };
  tools: ToolInfo[];
  config: AgentConfig;
  skillLinks: SkillLinkRow[];
  recommendations: SkillRecommendationRow[];
  onAddSkill: (agentId: string) => void;
  onInstallRecommendation: (rec: SkillRecommendationRow) => void;
}) {
  const Icon = config.icon;
  const { toggleSkillLink, removeSkillLink } = useSkillMutations();
  const { dismissRecommendation } = useSkillRecommendationMutations();
  const agentLinks = skillLinks.filter((l) => l.agent_definition_id === agent.id);
  const agentRecs = recommendations.filter((r) => r.agent_definition_id === agent.id);

  return (
    <div className="py-6 px-4">
      <div className="flex items-center gap-4 mb-6">
        <div className="w-12 h-12 rounded-lg bg-secondary flex items-center justify-center">
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <div className="flex items-center gap-2 mb-4 pb-2 border-b border-border">
            <Wrench size={14} className="text-muted-foreground" />
            <h3 className="font-mono text-xs tracking-widest uppercase text-muted-foreground">Tools</h3>
          </div>
          <div className="space-y-2">
            {tools.map((tool) => (
              <div key={tool.name} className="flex items-start gap-3 p-3 rounded-sm border border-border hover:border-foreground/20 transition-colors">
                <div className={`w-8 h-8 rounded flex items-center justify-center shrink-0 mt-0.5 ${tool.isExternal ? "bg-violet-500/10" : "bg-secondary"}`}>
                  <tool.icon size={14} className={tool.isExternal ? "text-violet-400" : "text-muted-foreground"} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">{tool.name}</span>
                    {tool.isExternal && (
                      <Badge variant="outline" className="text-[8px] px-1 py-0 h-3.5 text-violet-400 border-violet-500/30">composio</Badge>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">{tool.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-4 pb-2 border-b border-border">
            <div className="flex items-center gap-2">
              <BookOpen size={14} className="text-muted-foreground" />
              <h3 className="font-mono text-xs tracking-widest uppercase text-muted-foreground">Skills</h3>
              <Badge variant="secondary" className="text-[9px]">{agentLinks.length}</Badge>
            </div>
            <button
              onClick={() => onAddSkill(agent.id)}
              className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-md bg-violet-600 text-white hover:bg-violet-500 transition-colors"
            >
              <Plus size={10} />
              Add Skill
            </button>
          </div>

          <SkillsList agentLinks={agentLinks} agentId={agent.id} onAddSkill={onAddSkill} />

          {/* Recommended Skills */}
          {agentRecs.length > 0 && (
            <div className="mt-4 pt-3 border-t border-amber-500/20">
              <div className="flex items-center gap-2 mb-3">
                <Lightbulb size={12} className="text-amber-400" />
                <span className="font-mono text-[10px] text-amber-400 tracking-wider uppercase">
                  Recommended
                </span>
                <Badge variant="secondary" className="text-[9px] bg-amber-500/10 text-amber-400">{agentRecs.length}</Badge>
              </div>
              <div className="space-y-2">
                {agentRecs.map((rec) => (
                  <div key={rec.id} className="p-3 rounded-sm border border-amber-500/20 bg-amber-500/5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium">{rec.title}</span>
                          <Badge variant="outline" className="text-[8px] px-1 py-0 h-3.5 text-amber-400 border-amber-500/30">
                            priority {rec.priority}
                          </Badge>
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-1 leading-snug">{rec.reason}</p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => onInstallRecommendation(rec)}
                          className="flex items-center gap-1 px-2 py-1 text-[9px] font-medium rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors"
                          title="Install this skill"
                        >
                          <Download size={10} />
                          Install
                        </button>
                        <button
                          onClick={() => dismissRecommendation.mutate(rec.id)}
                          className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                          title="Dismiss"
                        >
                          <XCircle size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Hardcoded base capabilities */}
          <div className="mt-4 pt-3 border-t border-border/50">
            <span className="font-mono text-[9px] text-muted-foreground/60 tracking-wider uppercase block mb-2">
              Base Capabilities
            </span>
            <div className="flex flex-wrap gap-1">
              {config.skills.map((skill, i) => (
                <Badge key={i} variant="outline" className="text-[9px] text-muted-foreground/60 border-border/50">
                  {skill}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const Agents = () => {
  const navigate = useNavigate();
  const { data: agentDefs = [], isLoading } = useAgentDefinitions();
  const { data: externalTools = [] } = useAgentTools();
  const { data: skillLinks = [] } = useAgentSkillLinks();
  const { data: recommendations = [] } = useSkillRecommendations();
  const { markInstalled } = useSkillRecommendationMutations();
  const [skillModalOpen, setSkillModalOpen] = useState(false);
  const [skillModalAgentId, setSkillModalAgentId] = useState<string | undefined>();
  const [skillPrefill, setSkillPrefill] = useState<SkillPrefill | undefined>();
  const [pendingRecId, setPendingRecId] = useState<string | null>(null);

  const typedAgents =
    (agentDefs as Array<{
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

  const tabAgents = typedAgents.filter((a) => allAgentSlugs.includes(a.slug));

  const agentToolsMap = useMemo(() => {
    const map: Record<string, ToolInfo[]> = {};
    for (const agent of typedAgents) {
      map[agent.slug] = buildToolList(agent.slug, agent.id, externalTools);
    }
    return map;
  }, [typedAgents, externalTools]);

  const handleAddSkill = (agentId: string) => {
    setSkillModalAgentId(agentId);
    setSkillPrefill(undefined);
    setPendingRecId(null);
    setSkillModalOpen(true);
  };

  const handleInstallRecommendation = (rec: SkillRecommendationRow) => {
    setSkillModalAgentId(rec.agent_definition_id);
    setSkillPrefill({
      name: rec.title,
      description: rec.reason,
      content: rec.suggested_content || "",
    });
    setPendingRecId(rec.id);
    setSkillModalOpen(true);
  };

  const handleModalSuccess = () => {
    if (pendingRecId) {
      markInstalled.mutate(pendingRecId);
    }
  };

  const handleModalClose = () => {
    setSkillModalOpen(false);
    setSkillPrefill(undefined);
    setPendingRecId(null);
  };

  return (
    <div className="h-screen flex flex-col bg-background">
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
        {!isLoading && <Badge variant="secondary" className="ml-2 text-[10px]">{typedAgents.length} agents</Badge>}
      </div>

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
                {tabAgents.map((agent) => {
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
              <OrgChart agents={typedAgents} externalTools={externalTools} />
            </TabsContent>

            {tabAgents.map((agent) => {
              const config = agentConfigs[agent.slug] || { icon: Bot, color: "text-muted-foreground", skills: [] };
              const tools = agentToolsMap[agent.slug] || [];
              return (
                <TabsContent key={agent.slug} value={agent.slug} className="mt-0">
                  <AgentDetail agent={agent} tools={tools} config={config} skillLinks={skillLinks} recommendations={recommendations} onAddSkill={handleAddSkill} onInstallRecommendation={handleInstallRecommendation} />
                </TabsContent>
              );
            })}
          </Tabs>
        )}
      </div>

      <AddSkillModal
        open={skillModalOpen}
        onClose={handleModalClose}
        onSuccess={handleModalSuccess}
        preselectedAgentId={skillModalAgentId}
        prefill={skillPrefill}
      />
    </div>
  );
};

export default Agents;
