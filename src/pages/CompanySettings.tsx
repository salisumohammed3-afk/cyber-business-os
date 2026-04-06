import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Save, Plus, Trash2, Target, Bot, Wrench, FileText, Bell } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { useCompany } from "@/contexts/CompanyContext";
import type { CompanyBrief, GoalStatus } from "@/integrations/supabase/types";

const STAGES = ["idea", "building", "pre-revenue", "scaling", "established"] as const;

// ── Brief Tab ──────────────────────────────────────────────────────────────

function BriefTab() {
  const { company, refreshCompanies } = useCompany();
  const [brief, setBrief] = useState<CompanyBrief>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (company?.brief) setBrief(company.brief);
  }, [company]);

  const save = async () => {
    if (!company) return;
    setSaving(true);
    await supabase.from("companies").update({ brief }).eq("id", company.id);
    await refreshCompanies();
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const update = (key: keyof CompanyBrief, value: unknown) => {
    setBrief((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <label className="text-sm font-medium">What We Do</label>
        <textarea
          value={brief.what_we_do || ""}
          onChange={(e) => update("what_we_do", e.target.value)}
          placeholder="One paragraph: what the business sells, who it serves, how it makes money."
          className="mt-1 w-full rounded-lg border px-3 py-2 text-sm min-h-[80px] focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="text-sm font-medium">Stage</label>
        <select
          value={brief.stage || ""}
          onChange={(e) => update("stage", e.target.value || undefined)}
          className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Select stage...</option>
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {s.replace("-", " ")}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-sm font-medium">Target Customers</label>
        <textarea
          value={brief.target_customers || ""}
          onChange={(e) => update("target_customers", e.target.value)}
          placeholder="Industry, size, role, geography."
          className="mt-1 w-full rounded-lg border px-3 py-2 text-sm min-h-[60px] focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="text-sm font-medium">Tone of Voice</label>
        <input
          value={brief.tone_of_voice || ""}
          onChange={(e) => update("tone_of_voice", e.target.value)}
          placeholder="How the brand communicates."
          className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="text-sm font-medium">Context Notes</label>
        <textarea
          value={brief.context_notes || ""}
          onChange={(e) => update("context_notes", e.target.value)}
          placeholder="Competitors, constraints, recent events — anything the agents should know."
          className="mt-1 w-full rounded-lg border px-3 py-2 text-sm min-h-[80px] focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <button
        onClick={save}
        disabled={saving}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
      >
        <Save size={14} />
        {saving ? "Saving..." : saved ? "Saved!" : "Save Brief"}
      </button>
    </div>
  );
}

// ── Goals Tab ──────────────────────────────────────────────────────────────

interface GoalRow {
  id: string;
  title: string;
  description: string | null;
  target_metric: string | null;
  target_value: number | null;
  current_value: number;
  timeframe: string | null;
  status: GoalStatus;
  priority: number;
}

function GoalsTab() {
  const { company } = useCompany();
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newGoal, setNewGoal] = useState({ title: "", description: "", target_metric: "", target_value: "", timeframe: "", priority: "5" });

  const fetchGoals = useCallback(async () => {
    if (!company) return;
    const { data } = await supabase
      .from("company_goals")
      .select("*")
      .eq("company_id", company.id)
      .order("priority", { ascending: true });
    if (data) setGoals(data as GoalRow[]);
    setLoading(false);
  }, [company]);

  useEffect(() => { fetchGoals() }, [fetchGoals]);

  const addGoal = async () => {
    if (!company || !newGoal.title) return;
    await supabase.from("company_goals").insert({
      company_id: company.id,
      title: newGoal.title,
      description: newGoal.description || null,
      target_metric: newGoal.target_metric || null,
      target_value: newGoal.target_value ? Number(newGoal.target_value) : null,
      timeframe: newGoal.timeframe || null,
      priority: Number(newGoal.priority) || 5,
    });
    setNewGoal({ title: "", description: "", target_metric: "", target_value: "", timeframe: "", priority: "5" });
    setShowAdd(false);
    fetchGoals();
  };

  const updateGoalStatus = async (id: string, status: GoalStatus) => {
    await supabase.from("company_goals").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
    fetchGoals();
  };

  const updateGoalValue = async (id: string, current_value: number) => {
    await supabase.from("company_goals").update({ current_value, updated_at: new Date().toISOString() }).eq("id", id);
    fetchGoals();
  };

  const deleteGoal = async (id: string) => {
    await supabase.from("company_goals").delete().eq("id", id);
    fetchGoals();
  };

  if (loading) return <p className="text-sm text-muted-foreground">Loading goals...</p>;

  return (
    <div className="space-y-4 max-w-2xl">
      {goals.map((g) => {
        const pct = g.target_value ? Math.min(100, Math.round((g.current_value / g.target_value) * 100)) : 0;
        return (
          <Card key={g.id}>
            <CardContent className="pt-4 space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium text-sm">{g.title}</h3>
                    <Badge variant={g.status === "active" ? "default" : "secondary"} className="text-xs">
                      {g.status}
                    </Badge>
                    <span className="text-xs text-muted-foreground">P{g.priority}</span>
                  </div>
                  {g.description && <p className="text-xs text-muted-foreground mt-1">{g.description}</p>}
                  {g.timeframe && <p className="text-xs text-muted-foreground">{g.timeframe}</p>}
                </div>
                <div className="flex items-center gap-1">
                  {g.status === "active" && (
                    <button onClick={() => updateGoalStatus(g.id, "achieved")} className="text-xs px-2 py-1 rounded border hover:bg-green-50">
                      Mark Achieved
                    </button>
                  )}
                  {g.status === "active" && (
                    <button onClick={() => updateGoalStatus(g.id, "paused")} className="text-xs px-2 py-1 rounded border hover:bg-yellow-50">
                      Pause
                    </button>
                  )}
                  {g.status === "paused" && (
                    <button onClick={() => updateGoalStatus(g.id, "active")} className="text-xs px-2 py-1 rounded border hover:bg-blue-50">
                      Resume
                    </button>
                  )}
                  <button onClick={() => deleteGoal(g.id)} className="text-xs p-1 rounded hover:bg-red-50 text-red-500">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              {g.target_value != null && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{g.target_metric}: {g.current_value} / {g.target_value}</span>
                    <span>{pct}%</span>
                  </div>
                  <Progress value={pct} className="h-2" />
                  <div className="flex gap-1">
                    <input
                      type="number"
                      defaultValue={g.current_value}
                      onBlur={(e) => updateGoalValue(g.id, Number(e.target.value))}
                      className="w-20 rounded border px-2 py-1 text-xs"
                    />
                    <span className="text-xs text-muted-foreground self-center">current value</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      {showAdd ? (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <input value={newGoal.title} onChange={(e) => setNewGoal({ ...newGoal, title: e.target.value })} placeholder="Goal title" className="w-full rounded border px-3 py-2 text-sm" />
            <input value={newGoal.description} onChange={(e) => setNewGoal({ ...newGoal, description: e.target.value })} placeholder="Description (optional)" className="w-full rounded border px-3 py-2 text-sm" />
            <div className="grid grid-cols-3 gap-2">
              <input value={newGoal.target_metric} onChange={(e) => setNewGoal({ ...newGoal, target_metric: e.target.value })} placeholder="Metric name" className="rounded border px-3 py-2 text-sm" />
              <input value={newGoal.target_value} onChange={(e) => setNewGoal({ ...newGoal, target_value: e.target.value })} placeholder="Target #" type="number" className="rounded border px-3 py-2 text-sm" />
              <input value={newGoal.timeframe} onChange={(e) => setNewGoal({ ...newGoal, timeframe: e.target.value })} placeholder="e.g. Q2 2026" className="rounded border px-3 py-2 text-sm" />
            </div>
            <div className="flex gap-2">
              <button onClick={addGoal} disabled={!newGoal.title} className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm disabled:opacity-50">Add Goal</button>
              <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 rounded border text-sm">Cancel</button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 px-3 py-2 rounded border text-sm hover:bg-secondary">
          <Plus size={14} /> Add Goal
        </button>
      )}
    </div>
  );
}

// ── Agents Tab ─────────────────────────────────────────────────────────────

function AgentsTab() {
  const { company } = useCompany();
  const [agents, setAgents] = useState<Array<{ id: string; name: string; slug: string; model: string; description: string; is_orchestrator: boolean; system_prompt: string; max_turns: number; temperature: number }>>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState("");
  const [editModel, setEditModel] = useState("");

  const fetchAgents = useCallback(async () => {
    if (!company) return;
    const { data } = await supabase
      .from("agent_definitions")
      .select("id, name, slug, model, description, is_orchestrator, system_prompt, max_turns, temperature")
      .eq("company_id", company.id)
      .order("name");
    if (data) {
      setAgents(data as typeof agents);
    }
  }, [company]);

  useEffect(() => { fetchAgents() }, [fetchAgents]);

  const saveAgent = async (id: string) => {
    await supabase.from("agent_definitions").update({
      system_prompt: editPrompt,
      model: editModel,
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    setEditingId(null);
    fetchAgents();
  };

  return (
    <div className="space-y-3 max-w-3xl">
      {agents.map((a) => (
        <Card key={a.id}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm">{a.name}</CardTitle>
                <Badge variant="outline" className="text-xs">{a.slug}</Badge>
                {a.is_orchestrator && <Badge className="text-xs">orchestrator</Badge>}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{a.model?.split("-").slice(0, 2).join("-")}</span>
                <span>{(builtInToolsByAgent[a.slug] || builtInToolsByAgent.research).length} tools</span>
                <button
                  onClick={() => {
                    setEditingId(editingId === a.id ? null : a.id);
                    setEditPrompt(a.system_prompt || "");
                    setEditModel(a.model || "claude-sonnet-4-20250514");
                  }}
                  className="px-2 py-1 rounded border hover:bg-secondary"
                >
                  {editingId === a.id ? "Close" : "Edit"}
                </button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground">{a.description}</p>
            {editingId === a.id && (
              <div className="mt-3 space-y-3 border-t pt-3">
                <div>
                  <label className="text-xs font-medium">Model</label>
                  <select value={editModel} onChange={(e) => setEditModel(e.target.value)} className="mt-1 w-full rounded border px-2 py-1.5 text-sm">
                    <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
                    <option value="claude-opus-4-20250514">Claude Opus 4</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium">System Prompt</label>
                  <textarea
                    value={editPrompt}
                    onChange={(e) => setEditPrompt(e.target.value)}
                    className="mt-1 w-full rounded border px-3 py-2 text-xs font-mono min-h-[120px]"
                  />
                </div>
                <button onClick={() => saveAgent(a.id)} className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm">Save</button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ── Tools Tab ──────────────────────────────────────────────────────────────

const builtInToolsByAgent: Record<string, string[]> = {
  orchestrator: ["delegate_task", "create_task", "database_query", "store_memory", "recall_memories", "test_url", "manage_integrations"],
  engineering: ["web_search", "database_query", "store_memory", "recall_memories", "test_url", "github_create_repo", "github_push_file", "sandbox_bash", "sandbox_write_file", "sandbox_read_file", "deploy_static_site", "register_project", "database_admin"],
  designer: ["web_search", "database_query", "store_memory", "recall_memories", "test_url", "design_system_search"],
  growth: ["web_search", "database_query", "store_memory", "recall_memories", "test_url"],
  research: ["web_search", "database_query", "store_memory", "recall_memories", "test_url"],
  "executive-assistant": ["web_search", "database_query", "store_memory", "recall_memories", "test_url"],
};

function ToolsTab() {
  const { company } = useCompany();
  const [agents, setAgentsState] = useState<Array<{ id: string; slug: string; name: string }>>([]);
  const [composioTools, setComposioTools] = useState<Array<{ id: string; agent_id: string; tool_name: string; connection_source: string; is_enabled: boolean; agent_slug?: string }>>([]);

  const fetchData = useCallback(async () => {
    if (!company) return;
    const { data: agentData } = await supabase
      .from("agent_definitions")
      .select("id, slug, name")
      .eq("company_id", company.id);
    if (!agentData?.length) return;
    setAgentsState(agentData as Array<{ id: string; slug: string; name: string }>);

    const agentMap: Record<string, string> = {};
    agentData.forEach((a: { id: string; slug: string }) => { agentMap[a.id] = a.slug; });

    const { data } = await supabase
      .from("agent_tools")
      .select("id, agent_id, tool_name, connection_source, is_enabled")
      .in("agent_id", agentData.map((a: { id: string }) => a.id))
      .eq("connection_source", "composio")
      .order("tool_name");

    if (data) {
      setComposioTools(data.map((t: { id: string; agent_id: string; tool_name: string; connection_source: string; is_enabled: boolean }) => ({
        ...t,
        agent_slug: agentMap[t.agent_id],
      })));
    }
  }, [company]);

  useEffect(() => { fetchData() }, [fetchData]);

  const toggleComposioTool = async (id: string, enabled: boolean) => {
    await supabase.from("agent_tools").update({ is_enabled: enabled }).eq("id", id);
    fetchData();
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <p className="text-sm text-muted-foreground">
        Built-in tools are managed by the system. Composio integrations can be toggled per agent.
      </p>

      {agents.map((agent) => {
        const tools = builtInToolsByAgent[agent.slug] || builtInToolsByAgent.research;
        const agentComposio = composioTools.filter((t) => t.agent_slug === agent.slug);
        return (
          <div key={agent.slug}>
            <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
              <Wrench size={14} />
              {agent.name}
            </h3>
            <div className="space-y-1">
              {tools.map((name) => (
                <div key={name} className="flex items-center justify-between px-3 py-2 rounded border text-sm">
                  <div className="flex items-center gap-2">
                    <span>{name}</span>
                    <Badge variant="outline" className="text-xs">built-in</Badge>
                  </div>
                  <span className="text-xs text-muted-foreground">Always on</span>
                </div>
              ))}
              {agentComposio.map((t) => (
                <div key={t.id} className="flex items-center justify-between px-3 py-2 rounded border text-sm">
                  <div className="flex items-center gap-2">
                    <span>{t.tool_name}</span>
                    <Badge variant="outline" className="text-xs">{t.connection_source}</Badge>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={t.is_enabled}
                      onChange={(e) => toggleComposioTool(t.id, e.target.checked)}
                      className="rounded"
                    />
                    <span className="text-xs">{t.is_enabled ? "On" : "Off"}</span>
                  </label>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {agents.length === 0 && <p className="text-sm text-muted-foreground">No agents found for this company.</p>}
    </div>
  );
}

// ── Notifications Tab ──────────────────────────────────────────────────────

function NotificationsTab() {
  const { company, refreshCompanies } = useCompany();
  const [digestEmail, setDigestEmail] = useState("");
  const [digestEnabled, setDigestEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (company) {
      setDigestEmail(company.digest_email || "");
      setDigestEnabled(company.digest_enabled ?? true);
    }
  }, [company]);

  const save = async () => {
    if (!company) return;
    setSaving(true);
    await supabase.from("companies").update({
      digest_email: digestEmail || null,
      digest_enabled: digestEnabled,
    }).eq("id", company.id);
    await refreshCompanies();
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h3 className="text-sm font-medium mb-1">Daily Digest Email</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Receive a daily briefing at 8:05 AM UTC summarizing your agents' activity from the last 24 hours.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={digestEnabled}
            onChange={(e) => { setDigestEnabled(e.target.checked); setSaved(false); }}
            className="rounded"
          />
          <span className="text-sm">Enable daily digest</span>
        </label>
      </div>

      <div>
        <label className="text-sm font-medium">Email address</label>
        <input
          type="email"
          value={digestEmail}
          onChange={(e) => { setDigestEmail(e.target.value); setSaved(false); }}
          placeholder="you@example.com"
          className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <p className="text-xs text-muted-foreground mt-1">
          The digest will be sent to this address every morning.
        </p>
      </div>

      <button
        onClick={save}
        disabled={saving}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
      >
        <Save size={14} />
        {saving ? "Saving..." : saved ? "Saved!" : "Save Notifications"}
      </button>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function CompanySettings() {
  const navigate = useNavigate();
  const { company } = useCompany();

  if (!company) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-muted-foreground">No company selected</p>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      <div className="h-12 border-b flex items-center px-4 gap-3">
        <button onClick={() => navigate("/")} className="p-1 rounded hover:bg-secondary">
          <ArrowLeft size={18} />
        </button>
        <h1 className="font-semibold text-sm">{company.name} — Settings</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <Tabs defaultValue="brief" className="w-full">
          <TabsList className="mb-6">
            <TabsTrigger value="brief" className="flex items-center gap-1.5">
              <FileText size={14} /> Brief
            </TabsTrigger>
            <TabsTrigger value="goals" className="flex items-center gap-1.5">
              <Target size={14} /> Goals
            </TabsTrigger>
            <TabsTrigger value="agents" className="flex items-center gap-1.5">
              <Bot size={14} /> Agents
            </TabsTrigger>
            <TabsTrigger value="tools" className="flex items-center gap-1.5">
              <Wrench size={14} /> Tools
            </TabsTrigger>
            <TabsTrigger value="notifications" className="flex items-center gap-1.5">
              <Bell size={14} /> Notifications
            </TabsTrigger>
          </TabsList>
          <TabsContent value="brief"><BriefTab /></TabsContent>
          <TabsContent value="goals"><GoalsTab /></TabsContent>
          <TabsContent value="agents"><AgentsTab /></TabsContent>
          <TabsContent value="tools"><ToolsTab /></TabsContent>
          <TabsContent value="notifications"><NotificationsTab /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
