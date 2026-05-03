import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Plus, X, Loader2, CheckCircle2, AlertCircle, RotateCw, ExternalLink, Trash2,
  ChevronRight, ChevronLeft, Search, PartyPopper,
} from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { supabase } from "@/integrations/supabase/client";

// API Center tab — single place to manage external integrations.
// Backed by /api/integrations. Same data layer the conversational
// "add ChatGPT" flow writes to (Phase 2 of the API Center build).

interface VendorDef {
  vendor: string;
  display_name: string;
  category: string;
  description: string;
  docs_url: string;
  auth_type: string;
  base_url: string;
  credentials: Array<{
    name: string;
    label: string;
    description?: string;
    placeholder?: string;
    is_secret: boolean;
    required: boolean;
  }>;
  config: Array<{
    name: string;
    label: string;
    description?: string;
    default?: string;
    required?: boolean;
  }>;
}

interface Integration {
  id: string;
  vendor: string;
  display_name: string;
  auth_type: string;
  credential_preview: string | null;
  config: Record<string, unknown>;
  status: "active" | "unverified" | "broken" | "inactive";
  last_tested_at: string | null;
  last_test_error: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_STYLES: Record<Integration["status"], string> = {
  active: "bg-green-50 text-green-700 border-green-200",
  unverified: "bg-amber-50 text-amber-700 border-amber-200",
  broken: "bg-red-50 text-red-700 border-red-200",
  inactive: "bg-gray-50 text-gray-600 border-gray-200",
};

export function ApiCenterTab() {
  const { company } = useCompany();
  const [vendors, setVendors] = useState<VendorDef[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  // Wizard state — null means closed. preselect = jump straight to creds step.
  // editing = full edit flow (pre-fills creds preview, config, agent assignments).
  const [wizardState, setWizardState] = useState<
    | { mode: "closed" }
    | { mode: "add" }
    | { mode: "preselect"; vendor: VendorDef }
    | { mode: "edit"; integration: Integration; vendor: VendorDef }
  >({ mode: "closed" });
  const [testingId, setTestingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!company?.id) return;
    setLoading(true);
    try {
      const [vRes, iRes] = await Promise.all([
        fetch("/api/integrations?vendors=1"),
        fetch(`/api/integrations?company_id=${company.id}`),
      ]);
      if (vRes.ok) setVendors((await vRes.json()).vendors || []);
      if (iRes.ok) setIntegrations((await iRes.json()).integrations || []);
    } finally {
      setLoading(false);
    }
  }, [company?.id]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const r = await fetch(`/api/integrations?id=${id}&action=test`, { method: "POST" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert("Test failed: " + (body.error || r.statusText));
      } else if (!body.ok) {
        alert(`Test failed: ${body.message}`);
      }
    } finally {
      setTestingId(null);
      await refresh();
    }
  };

  const handleDelete = async (id: string, displayName: string) => {
    if (!confirm(`Disconnect ${displayName}? You can re-add it later.`)) return;
    const r = await fetch(`/api/integrations?id=${id}`, { method: "DELETE" });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      alert("Delete failed: " + (body.error || r.statusText));
      return;
    }
    await refresh();
  };

  const connectedVendors = new Set(integrations.map(i => i.vendor));
  const unconnectedVendors = vendors.filter(v => !connectedVendors.has(v.vendor));

  if (!company) {
    return <p className="text-sm text-muted-foreground">Select a company to manage integrations.</p>;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold mb-1">API Center</h2>
        <p className="text-sm text-muted-foreground">
          Connect external services so agents can use them. Credentials are encrypted at rest.
          You can also ask the orchestrator in chat — say <em>"add OpenAI"</em> and it'll walk you through it.
        </p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          Loading...
        </div>
      )}

      {!loading && (
        <>
          {/* Connected integrations */}
          <div>
            <h3 className="text-sm font-semibold mb-2">Connected ({integrations.length})</h3>
            {integrations.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No integrations yet. Add one below.</p>
            ) : (
              <div className="space-y-2">
                {integrations.map(i => {
                  const v = vendors.find(vv => vv.vendor === i.vendor);
                  return (
                    <div
                      key={i.id}
                      className="rounded-md border border-border bg-card p-3 flex flex-col sm:flex-row sm:items-center gap-3"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">{i.display_name}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded border ${STATUS_STYLES[i.status]}`}>
                            {i.status === "active" && <CheckCircle2 size={10} className="inline mr-1" />}
                            {i.status === "broken" && <AlertCircle size={10} className="inline mr-1" />}
                            {i.status}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                          <span className="truncate">{i.credential_preview || "no key"}</span>
                          {v?.docs_url && (
                            <a href={v.docs_url} target="_blank" rel="noreferrer" className="hover:text-foreground shrink-0">
                              <ExternalLink size={11} className="inline" />
                            </a>
                          )}
                        </div>
                        {i.status === "broken" && i.last_test_error && (
                          <div className="text-xs text-red-700 mt-1">{i.last_test_error}</div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0 flex-wrap">
                        <button
                          onClick={() => handleTest(i.id)}
                          disabled={testingId === i.id}
                          className="text-xs flex items-center gap-1 px-2 py-1 rounded border border-border hover:bg-secondary disabled:opacity-50"
                          title="Test connection"
                        >
                          {testingId === i.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <RotateCw size={12} />
                          )}
                          Test
                        </button>
                        <button
                          onClick={() => {
                            const def = vendors.find(vv => vv.vendor === i.vendor);
                            if (def) setWizardState({ mode: "edit", integration: i, vendor: def });
                          }}
                          className="text-xs px-2 py-1 rounded border border-border hover:bg-secondary"
                          title="Update credentials"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(i.id, i.display_name)}
                          className="text-xs flex items-center gap-1 px-2 py-1 rounded border border-red-200 text-red-700 hover:bg-red-50"
                          title="Disconnect"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Connect another — single CTA opens the wizard at step 1 (vendor pick) */}
          {unconnectedVendors.length > 0 ? (
            <button
              onClick={() => setWizardState({ mode: "add" })}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
            >
              <Plus size={14} /> Connect a service
            </button>
          ) : (
            <p className="text-xs text-muted-foreground italic">All known vendors are already connected.</p>
          )}
        </>
      )}

      {/* Wizard — handles add, vendor-preselect, and edit flows */}
      {wizardState.mode !== "closed" && company?.id && (
        <IntegrationWizard
          companyId={company.id}
          vendors={vendors}
          unconnectedVendors={unconnectedVendors}
          initialVendor={wizardState.mode === "preselect" ? wizardState.vendor : wizardState.mode === "edit" ? wizardState.vendor : null}
          existing={wizardState.mode === "edit" ? wizardState.integration : null}
          onClose={() => setWizardState({ mode: "closed" })}
          onComplete={async () => { setWizardState({ mode: "closed" }); await refresh(); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Integration Wizard
// ─────────────────────────────────────────────────────────────────────────────
//
// Replaces the old single-screen "fill all the fields" modal. Walks the user
// through one decision at a time:
//   1. pick     — which service?
//   2. creds    — paste API key (with smart probe of vendor for valid options)
//   3. config   — vendor-specific config (verified domains, etc.) — skipped
//                 if the vendor declares no config fields
//   4. agents   — which specialists should have access?
//   5. done     — summary + test status
//
// Each step has friendly, conversational copy. Back/Next navigation. Edit
// flows skip the picker and pre-fill known state. Errors are non-blocking —
// the user can proceed past a probe failure with a warning.

type WizardStep = "pick" | "creds" | "config" | "agents" | "done";

interface AgentRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  is_orchestrator: boolean;
}

// When a vendor of category X is added, pre-check these agents in the assignment step.
// User can override. Empty = no auto-suggestion.
const SUGGESTED_AGENTS_BY_CATEGORY: Record<string, string[]> = {
  email: ["growth", "outreach", "executive-assistant"],
  search: ["research"],
  code: ["engineering"],
  git: ["engineering"],
  llm: [], // already covered by agent_definitions.model
  data: ["research", "growth"],
  storage: ["engineering", "designer"],
  analytics: ["research", "growth"],
  appstore: ["growth", "research"],
  monitoring: ["engineering"],
};

interface IntegrationWizardProps {
  companyId: string;
  vendors: VendorDef[];
  unconnectedVendors: VendorDef[];
  initialVendor: VendorDef | null;
  existing: Integration | null;
  onClose: () => void;
  onComplete: () => void | Promise<void>;
}

function IntegrationWizard({
  companyId, vendors, unconnectedVendors, initialVendor, existing, onClose, onComplete,
}: IntegrationWizardProps) {
  const isEditing = !!existing;
  const [vendor, setVendor] = useState<VendorDef | null>(initialVendor);
  const [step, setStep] = useState<WizardStep>(initialVendor ? "creds" : "pick");
  const [picker, setPicker] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<Record<string, string>>({});
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [assignedAgents, setAssignedAgents] = useState<Set<string>>(new Set());
  // Smart probe state
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState("");
  const [probeNote, setProbeNote] = useState("");
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({});
  // Save state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState<{ id?: string; status?: string; testMessage?: string }>({});

  // ── Pre-fill config when entering a vendor ────────────────────────────────
  useEffect(() => {
    if (!vendor) return;
    const init: Record<string, string> = {};
    for (const f of vendor.config) {
      init[f.name] = (existing?.config?.[f.name] as string) || f.default || "";
    }
    setConfig(init);
  }, [vendor, existing]);

  // ── Fetch agents (for assignment step) ────────────────────────────────────
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("agent_definitions")
        .select("id,name,slug,description,is_orchestrator")
        .eq("company_id", companyId)
        .order("name");
      if (cancelled) return;
      setAgents((data as AgentRow[]) || []);
      // Pre-select sensible defaults the first time
      if (vendor) {
        const suggested = SUGGESTED_AGENTS_BY_CATEGORY[vendor.category] || [];
        if (existing) {
          // For edit mode, read current agent_tools assignments
          const { data: rows } = await supabase
            .from("agent_tools")
            .select("agent_id, is_enabled")
            .eq("connection_source", "integration")
            .eq("tool_name", vendor.vendor)
            .eq("is_enabled", true);
          const ids = new Set((rows || []).map((r: { agent_id: string }) => r.agent_id));
          const slugs = new Set(((data as AgentRow[]) || []).filter(a => ids.has(a.id)).map(a => a.slug));
          if (!cancelled) setAssignedAgents(slugs);
        } else if (suggested.length) {
          // Intersect suggestions with agents that actually exist in this company —
          // otherwise the Done step lists slugs we never wrote.
          const existingSlugs = new Set(((data as AgentRow[]) || []).map(a => a.slug));
          setAssignedAgents(new Set(suggested.filter(s => existingSlugs.has(s))));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [companyId, vendor, existing]);

  // ── Smart probe (debounced) ───────────────────────────────────────────────
  const credSignature = JSON.stringify(creds);
  useEffect(() => {
    if (!vendor) return;
    const hasAny = Object.values(creds).some(v => v && v.trim().length > 4);
    if (!hasAny) {
      setProbeError(""); setProbeNote(""); setSuggestions({}); return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setProbing(true); setProbeError("");
      try {
        const r = await fetch("/api/integrations?action=pre_probe", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vendor: vendor.vendor, credentials: creds }),
        });
        const body = await r.json();
        if (cancelled) return;
        if (!body.ok) {
          setProbeError(body.error || "Could not reach vendor");
          setSuggestions({}); setProbeNote("");
        } else {
          setSuggestions(body.suggestions || {});
          setProbeNote(body.note || ""); setProbeError("");
        }
      } catch (e) {
        if (!cancelled) setProbeError(e instanceof Error ? e.message : "Probe failed");
      } finally {
        if (!cancelled) setProbing(false);
      }
    }, 600);
    return () => { cancelled = true; clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credSignature, vendor?.vendor]);

  // ── Step navigation helpers ───────────────────────────────────────────────
  const canSkipConfig = !vendor || vendor.config.length === 0;

  const filteredVendors = useMemo(() => {
    const q = picker.trim().toLowerCase();
    if (!q) return unconnectedVendors;
    return unconnectedVendors.filter(v =>
      v.display_name.toLowerCase().includes(q) ||
      v.vendor.toLowerCase().includes(q) ||
      v.category.toLowerCase().includes(q) ||
      (v.description || "").toLowerCase().includes(q)
    );
  }, [picker, unconnectedVendors]);

  const goNext = () => {
    if (step === "pick" && vendor) setStep("creds");
    else if (step === "creds") setStep(canSkipConfig ? "agents" : "config");
    else if (step === "config") setStep("agents");
    else if (step === "agents") void save();
  };
  const goBack = () => {
    if (step === "creds" && !isEditing) setStep("pick");
    else if (step === "config") setStep("creds");
    else if (step === "agents") setStep(canSkipConfig ? "creds" : "config");
  };

  const credsLooksOk = vendor
    ? vendor.credentials.every(f => !f.required || (creds[f.name] && creds[f.name].length > 0)) ||
      // editing with no new key entered = keeping existing → valid
      (isEditing && Object.values(creds).every(v => !v))
    : false;

  // ── Save / commit ─────────────────────────────────────────────────────────
  const save = async () => {
    if (!vendor) return;
    setSaving(true); setSaveError("");
    try {
      // Edit mode: PATCH the existing integration. Add mode: POST a new one.
      const url = isEditing
        ? `/api/integrations?id=${existing!.id}`
        : "/api/integrations";
      const method = isEditing ? "PATCH" : "POST";
      // Strip empty credential values in edit mode (means "keep existing")
      const credsToSend: Record<string, string> = {};
      for (const [k, v] of Object.entries(creds)) {
        if (v && v.trim()) credsToSend[k] = v;
      }
      const body: Record<string, unknown> = {
        company_id: companyId,
        vendor: vendor.vendor,
        config,
      };
      if (Object.keys(credsToSend).length > 0 || !isEditing) {
        body.credentials = credsToSend;
      }
      const r = await fetch(url, {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || r.statusText);
      }
      const { integration } = await r.json();
      const integrationId = integration?.id || existing?.id;

      // Test the connection so the done step can show a real status
      let testStatus = integration?.status || "unverified";
      let testMessage = "";
      if (integrationId) {
        const tr = await fetch(`/api/integrations?id=${integrationId}&action=test`, { method: "POST" });
        const tbody = await tr.json().catch(() => ({}));
        testStatus = tbody.ok ? "active" : "broken";
        testMessage = tbody.message || tbody.error || "";
      }

      // Write agent_tools rows (additive — no delete unless this is edit)
      if (integrationId) {
        await syncAgentAssignments(companyId, vendor.vendor, agents, assignedAgents);
      }

      setSaved({ id: integrationId, status: testStatus, testMessage });
      setStep("done");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const headerTitle = (() => {
    if (step === "pick") return "Connect a service";
    if (step === "done") return "All set";
    if (isEditing) return `Update ${vendor?.display_name || ""}`;
    return `Connect ${vendor?.display_name || ""}`;
  })();

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] flex flex-col">
        {/* Header with progress */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-sm">{headerTitle}</h3>
            {step !== "pick" && step !== "done" && (
              <WizardProgress step={step} canSkipConfig={canSkipConfig} />
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-secondary shrink-0" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {step === "pick" && (
            <PickStep
              vendors={filteredVendors}
              search={picker}
              onSearch={setPicker}
              onPick={(v) => { setVendor(v); setStep("creds"); }}
            />
          )}
          {step === "creds" && vendor && (
            <CredsStep
              vendor={vendor}
              isEditing={isEditing}
              existing={existing}
              creds={creds}
              setCreds={setCreds}
              probing={probing}
              probeError={probeError}
              probeNote={probeNote}
            />
          )}
          {step === "config" && vendor && (
            <ConfigStep
              vendor={vendor}
              config={config}
              setConfig={setConfig}
              suggestions={suggestions}
              probing={probing}
              probeNote={probeNote}
            />
          )}
          {step === "agents" && vendor && (
            <AgentsStep
              vendor={vendor}
              agents={agents}
              assigned={assignedAgents}
              setAssigned={setAssignedAgents}
            />
          )}
          {step === "done" && vendor && (
            <DoneStep
              vendor={vendor}
              status={saved.status || ""}
              testMessage={saved.testMessage || ""}
              assignedSlugs={[...assignedAgents]}
              onTestAgain={async () => {
                if (!saved.id) return;
                const tr = await fetch(`/api/integrations?id=${saved.id}&action=test`, { method: "POST" });
                const body = await tr.json().catch(() => ({}));
                setSaved(prev => ({ ...prev, status: body.ok ? "active" : "broken", testMessage: body.message || body.error || "" }));
              }}
            />
          )}
          {saveError && (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {saveError}
            </div>
          )}
        </div>

        {/* Footer: nav buttons */}
        <div className="border-t px-4 py-3 flex items-center justify-between gap-2">
          {step !== "pick" && step !== "done" ? (
            <button
              onClick={goBack}
              disabled={saving || (step === "creds" && isEditing)}
              className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded border border-border hover:bg-secondary disabled:opacity-30"
            >
              <ChevronLeft size={12} /> Back
            </button>
          ) : <div />}

          {step === "pick" && (
            <button
              onClick={() => { /* picker step advances on click — this is just label */ }}
              disabled
              className="text-xs px-3 py-1.5 rounded border border-border opacity-50"
            >
              Pick a service to continue
            </button>
          )}
          {step === "creds" && (
            <button
              onClick={goNext}
              disabled={!credsLooksOk}
              className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300"
            >
              Next <ChevronRight size={12} />
            </button>
          )}
          {step === "config" && (
            <button
              onClick={goNext}
              className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700"
            >
              Next <ChevronRight size={12} />
            </button>
          )}
          {step === "agents" && (
            <button
              onClick={goNext}
              disabled={saving}
              className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300"
            >
              {saving ? <><Loader2 size={12} className="animate-spin" /> Saving…</> : <>{isEditing ? "Update" : "Save"} & test <CheckCircle2 size={12} /></>}
            </button>
          )}
          {step === "done" && (
            <button
              onClick={async () => { await onComplete(); }}
              className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Step components ─────────────────────────────────────────────────────────

function WizardProgress({ step, canSkipConfig }: { step: WizardStep; canSkipConfig: boolean }) {
  const steps: WizardStep[] = canSkipConfig ? ["creds", "agents"] : ["creds", "config", "agents"];
  const idx = steps.indexOf(step);
  return (
    <div className="flex items-center gap-1 mt-1">
      {steps.map((s, i) => (
        <span
          key={s}
          className={`h-1 rounded-full transition-all ${i <= idx ? "bg-blue-600 w-6" : "bg-gray-200 w-3"}`}
        />
      ))}
      <span className="text-[10px] text-muted-foreground ml-1">step {idx + 1} of {steps.length}</span>
    </div>
  );
}

function PickStep({ vendors, search, onSearch, onPick }: { vendors: VendorDef[]; search: string; onSearch: (s: string) => void; onPick: (v: VendorDef) => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">What are you connecting?</p>
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          autoFocus
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search by name (resend, github, openai…)"
          className="w-full pl-8 pr-3 py-2 rounded border text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {vendors.map(v => (
          <button
            key={v.vendor}
            onClick={() => onPick(v)}
            className="text-left rounded-md border bg-card p-3 hover:border-blue-300 hover:bg-blue-50 transition-colors"
          >
            <div className="font-medium text-sm">{v.display_name}</div>
            <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{v.description}</div>
            <div className="text-[10px] text-muted-foreground/70 mt-1 uppercase tracking-wider">{v.category}</div>
          </button>
        ))}
        {vendors.length === 0 && (
          <p className="text-xs text-muted-foreground italic col-span-full">
            {search ? "No vendors match." : "All known vendors are already connected."}
          </p>
        )}
      </div>
    </div>
  );
}

function CredsStep({ vendor, isEditing, existing, creds, setCreds, probing, probeError, probeNote }: {
  vendor: VendorDef; isEditing: boolean; existing: Integration | null;
  creds: Record<string, string>; setCreds: (c: Record<string, string>) => void;
  probing: boolean; probeError: string; probeNote: string;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm">{isEditing ? `Update credentials for ${vendor.display_name}` : `Got the API key for ${vendor.display_name}?`}</p>
      <p className="text-xs text-muted-foreground">{vendor.description}</p>
      {vendor.docs_url && (
        <a
          href={vendor.docs_url} target="_blank" rel="noreferrer"
          className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
        >
          Where to get yours <ExternalLink size={10} />
        </a>
      )}
      {vendor.credentials.map(f => (
        <div key={f.name}>
          <label className="text-xs font-medium block mb-1">
            {f.label} {f.required && <span className="text-red-600">*</span>}
          </label>
          {isEditing && f.is_secret && existing && (
            <p className="text-xs text-muted-foreground mb-1">
              Current: <code>{existing.credential_preview}</code> — leave blank to keep, or paste a new value to replace.
            </p>
          )}
          <input
            type={f.is_secret ? "password" : "text"}
            placeholder={f.placeholder}
            value={creds[f.name] || ""}
            onChange={e => setCreds({ ...creds, [f.name]: e.target.value })}
            className="w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            autoComplete="off"
          />
          {f.description && <p className="text-xs text-muted-foreground mt-1">{f.description}</p>}
        </div>
      ))}
      {(probing || probeError || probeNote) && (
        <div className={`rounded-md border px-3 py-2 text-xs space-y-1 ${probeError ? "border-red-200 bg-red-50/60" : "border-blue-200 bg-blue-50/60"}`}>
          {probing && (
            <div className="flex items-center gap-1.5 text-blue-700">
              <Loader2 size={12} className="animate-spin" /> Checking your account…
            </div>
          )}
          {!probing && probeError && <div className="text-red-700">{probeError}</div>}
          {!probing && !probeError && probeNote && <div className="text-blue-900">{probeNote}</div>}
        </div>
      )}
    </div>
  );
}

function ConfigStep({ vendor, config, setConfig, suggestions, probing, probeNote }: {
  vendor: VendorDef; config: Record<string, string>; setConfig: (c: Record<string, string>) => void;
  suggestions: Record<string, string[]>; probing: boolean; probeNote: string;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm">Anything to specify for {vendor.display_name}?</p>
      {(probing || probeNote) && (
        <div className="rounded-md border border-blue-200 bg-blue-50/60 px-3 py-2 text-xs">
          {probing ? (
            <div className="flex items-center gap-1.5 text-blue-700">
              <Loader2 size={12} className="animate-spin" /> Looking up valid options…
            </div>
          ) : (
            <div className="text-blue-900">{probeNote}</div>
          )}
        </div>
      )}
      {vendor.config.map(f => {
        const fieldSuggestions = suggestions[f.name] || [];
        return (
          <div key={f.name}>
            <label className="text-xs font-medium block mb-1">{f.label}</label>
            <input
              type="text"
              value={config[f.name] || ""}
              onChange={e => setConfig({ ...config, [f.name]: e.target.value })}
              placeholder={f.default}
              className="w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {fieldSuggestions.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {fieldSuggestions.map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setConfig({ ...config, [f.name]: s })}
                    className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                      config[f.name] === s
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white border-blue-300 text-blue-700 hover:bg-blue-100"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {f.description && <p className="text-xs text-muted-foreground mt-1">{f.description}</p>}
          </div>
        );
      })}
      {vendor.config.length === 0 && (
        <p className="text-xs text-muted-foreground italic">Nothing to configure here. You can move on.</p>
      )}
    </div>
  );
}

function AgentsStep({ vendor, agents, assigned, setAssigned }: {
  vendor: VendorDef;
  agents: AgentRow[];
  assigned: Set<string>;
  setAssigned: (s: Set<string>) => void;
}) {
  const togglable = agents.filter(a => !a.is_orchestrator);
  const toggle = (slug: string) => {
    const next = new Set(assigned);
    if (next.has(slug)) next.delete(slug); else next.add(slug);
    setAssigned(next);
  };
  const suggested = SUGGESTED_AGENTS_BY_CATEGORY[vendor.category] || [];
  return (
    <div className="space-y-3">
      <p className="text-sm">Which agents should be able to use {vendor.display_name}?</p>
      <p className="text-xs text-muted-foreground">
        {suggested.length > 0
          ? `Pre-selected based on this being a ${vendor.category} integration. Tweak as you like.`
          : "No defaults suggested for this category — pick whoever needs it."}
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setAssigned(new Set(togglable.map(a => a.slug)))}
          className="text-[11px] px-2 py-0.5 rounded border hover:bg-secondary"
        >
          Select all
        </button>
        <button
          onClick={() => setAssigned(new Set())}
          className="text-[11px] px-2 py-0.5 rounded border hover:bg-secondary"
        >
          Clear
        </button>
      </div>
      <div className="space-y-1.5">
        {togglable.map(a => (
          <label key={a.id} className="flex items-start gap-2 p-2 rounded border hover:bg-secondary/40 cursor-pointer text-xs">
            <input
              type="checkbox"
              checked={assigned.has(a.slug)}
              onChange={() => toggle(a.slug)}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{a.name}</div>
              {a.description && <div className="text-muted-foreground line-clamp-2">{a.description}</div>}
            </div>
          </label>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground italic">
        Today this assigns the integration in the <code>agent_tools</code> registry — used for Composio
        and forming the contract for direct integrations as that wiring lands.
      </p>
    </div>
  );
}

function DoneStep({ vendor, status, testMessage, assignedSlugs, onTestAgain }: {
  vendor: VendorDef; status: string; testMessage: string; assignedSlugs: string[]; onTestAgain: () => void | Promise<void>;
}) {
  const ok = status === "active";
  return (
    <div className="space-y-3 text-center py-4">
      <div className="flex justify-center">
        {ok
          ? <PartyPopper size={36} className="text-emerald-500" />
          : <AlertCircle size={36} className="text-amber-500" />}
      </div>
      <p className="text-sm font-medium">
        {ok ? `${vendor.display_name} is connected and live.` : `${vendor.display_name} saved, but the connection test didn't pass.`}
      </p>
      {testMessage && (
        <p className={`text-xs px-3 py-2 rounded ${ok ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{testMessage}</p>
      )}
      {assignedSlugs.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Assigned to: <span className="font-medium">{assignedSlugs.join(", ")}</span>
        </p>
      )}
      {!ok && (
        <button onClick={() => void onTestAgain()} className="text-xs px-3 py-1 rounded border hover:bg-secondary inline-flex items-center gap-1">
          <RotateCw size={12} /> Test again
        </button>
      )}
    </div>
  );
}

// ── Agent assignment writer ─────────────────────────────────────────────────
async function syncAgentAssignments(
  companyId: string,
  vendorSlug: string,
  agents: AgentRow[],
  desiredSlugs: Set<string>,
) {
  // Read existing rows for this (company, vendor) via the agents we know about
  const agentIds = agents.map(a => a.id);
  if (agentIds.length === 0) return;
  const { data: existing } = await supabase
    .from("agent_tools")
    .select("id, agent_id, is_enabled")
    .eq("connection_source", "integration")
    .eq("tool_name", vendorSlug)
    .in("agent_id", agentIds);
  const byAgent = new Map<string, { id: string; is_enabled: boolean | null }>(
    ((existing as Array<{ id: string; agent_id: string; is_enabled: boolean | null }>) || [])
      .map(r => [r.agent_id, { id: r.id, is_enabled: r.is_enabled }])
  );

  for (const agent of agents) {
    const wanted = desiredSlugs.has(agent.slug);
    const row = byAgent.get(agent.id);
    if (wanted && !row) {
      await supabase.from("agent_tools").insert({
        agent_id: agent.id,
        tool_name: vendorSlug,
        tool_type: "integration",
        connection_source: "integration",
        is_enabled: true,
      });
    } else if (wanted && row && !row.is_enabled) {
      await supabase.from("agent_tools").update({ is_enabled: true }).eq("id", row.id);
    } else if (!wanted && row && row.is_enabled) {
      await supabase.from("agent_tools").update({ is_enabled: false }).eq("id", row.id);
    }
  }
}
