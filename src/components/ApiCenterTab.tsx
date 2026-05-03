import { useState, useEffect, useCallback } from "react";
import { Plus, X, Loader2, CheckCircle2, AlertCircle, RotateCw, ExternalLink, Trash2 } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";

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
  const [showAdd, setShowAdd] = useState(false);
  const [editingVendor, setEditingVendor] = useState<VendorDef | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
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

  const handleSubmit = async (
    vendor: string,
    creds: Record<string, string>,
    config: Record<string, string>
  ) => {
    if (!company?.id) return;
    setSavingId(vendor);
    try {
      const r = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_id: company.id,
          vendor,
          credentials: creds,
          config,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        alert("Save failed: " + (body.error || r.statusText));
        return;
      }
      const { integration } = await r.json();
      // Run a test connection right away so the user sees green/red
      setTestingId(integration.id);
      await fetch(`/api/integrations?id=${integration.id}&action=test`, { method: "POST" });
      setTestingId(null);
      setEditingVendor(null);
      setShowAdd(false);
      await refresh();
    } catch (err) {
      alert("Save failed: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSavingId(null);
    }
  };

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
                            if (def) setEditingVendor(def);
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

          {/* Add new */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold">Available to add ({unconnectedVendors.length})</h3>
              {!showAdd && unconnectedVendors.length > 0 && (
                <button
                  onClick={() => setShowAdd(true)}
                  className="text-xs flex items-center gap-1 px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                >
                  <Plus size={12} /> Add integration
                </button>
              )}
            </div>
            {showAdd && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {unconnectedVendors.map(v => (
                  <button
                    key={v.vendor}
                    onClick={() => setEditingVendor(v)}
                    className="rounded-md border border-border bg-card p-3 text-left hover:border-blue-300 hover:bg-blue-50 transition-colors"
                  >
                    <div className="font-medium text-sm">{v.display_name}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{v.description}</div>
                  </button>
                ))}
                {unconnectedVendors.length === 0 && (
                  <p className="text-xs text-muted-foreground italic">All known vendors are already connected.</p>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Add/edit modal */}
      {editingVendor && (
        <AddIntegrationModal
          vendor={editingVendor}
          existing={integrations.find(i => i.vendor === editingVendor.vendor) || null}
          onClose={() => setEditingVendor(null)}
          onSubmit={handleSubmit}
          saving={savingId === editingVendor.vendor}
        />
      )}
    </div>
  );
}

interface AddIntegrationModalProps {
  vendor: VendorDef;
  existing: Integration | null;
  onClose: () => void;
  onSubmit: (
    vendor: string,
    creds: Record<string, string>,
    config: Record<string, string>
  ) => Promise<void>;
  saving: boolean;
}

function AddIntegrationModal({ vendor, existing, onClose, onSubmit, saving }: AddIntegrationModalProps) {
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of vendor.config) {
      init[f.name] =
        (existing?.config?.[f.name] as string) || f.default || "";
    }
    return init;
  });

  // Smart onboarding: when credentials are entered, ask the vendor for valid
  // options for each config field (e.g. Resend's verified domains → from-address
  // suggestions). Debounced so we don't probe on every keystroke.
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({});
  const [suggestNote, setSuggestNote] = useState<string>("");
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string>("");
  const credSignature = JSON.stringify(creds);

  useEffect(() => {
    // Only probe if we have at least one non-empty credential value
    const hasAny = Object.values(creds).some(v => v && v.trim().length > 4);
    if (!hasAny) return;

    let cancelled = false;
    const handle = setTimeout(async () => {
      setProbing(true);
      setProbeError("");
      try {
        const res = await fetch("/api/integrations?action=pre_probe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vendor: vendor.vendor, credentials: creds }),
        });
        const body = await res.json();
        if (cancelled) return;
        if (!body.ok) {
          setProbeError(body.error || "Could not reach vendor");
          setSuggestions({});
          setSuggestNote("");
        } else {
          setSuggestions(body.suggestions || {});
          setSuggestNote(body.note || "");
          setProbeError("");
        }
      } catch (e) {
        if (!cancelled) setProbeError(e instanceof Error ? e.message : "Probe failed");
      } finally {
        if (!cancelled) setProbing(false);
      }
    }, 600);
    return () => { cancelled = true; clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credSignature, vendor.vendor]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(vendor.vendor, creds, config);
  };

  const isEditing = !!existing;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="font-semibold">
            {isEditing ? "Update " : "Add "}
            {vendor.display_name}
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-secondary">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={submit} className="p-4 space-y-4">
          <p className="text-xs text-muted-foreground">{vendor.description}</p>
          {vendor.docs_url && (
            <a
              href={vendor.docs_url}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
            >
              Get your key <ExternalLink size={10} />
            </a>
          )}

          {vendor.credentials.map(f => (
            <div key={f.name}>
              <label className="text-xs font-medium block mb-1">
                {f.label} {f.required && <span className="text-red-600">*</span>}
              </label>
              {isEditing && f.is_secret && (
                <p className="text-xs text-muted-foreground mb-1">
                  Current: <code>{existing.credential_preview}</code> — leave blank to keep, or paste new value to replace.
                </p>
              )}
              <input
                type={f.is_secret ? "password" : "text"}
                placeholder={f.placeholder}
                onChange={e => setCreds({ ...creds, [f.name]: e.target.value })}
                className="w-full rounded border border-border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoComplete="off"
              />
              {f.description && (
                <p className="text-xs text-muted-foreground mt-1">{f.description}</p>
              )}
            </div>
          ))}

          {/* Live suggestions banner — shown above all config fields when probe returns useful data */}
          {(probing || probeError || suggestNote) && (
            <div className="rounded-md border border-blue-200 bg-blue-50/60 px-3 py-2 text-xs space-y-1">
              {probing && (
                <div className="flex items-center gap-1.5 text-blue-700">
                  <Loader2 size={12} className="animate-spin" />
                  Checking your account…
                </div>
              )}
              {!probing && probeError && (
                <div className="text-red-700">{probeError}</div>
              )}
              {!probing && !probeError && suggestNote && (
                <div className="text-blue-900">{suggestNote}</div>
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
                  className="w-full rounded border border-border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                        title="Click to use this value"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
                {f.description && (
                  <p className="text-xs text-muted-foreground mt-1">{f.description}</p>
                )}
              </div>
            );
          })}

          <div className="flex items-center gap-2 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded bg-blue-600 text-white text-sm px-3 py-1.5 hover:bg-blue-700 disabled:bg-gray-300"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {isEditing ? "Update & test" : "Save & test"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border text-sm px-3 py-1.5 hover:bg-secondary"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
