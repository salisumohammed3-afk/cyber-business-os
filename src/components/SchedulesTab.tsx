import { useState, useEffect, useCallback } from "react";
import { Loader2, Pause, Play, Trash2, Clock, Wrench, DollarSign, RotateCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";

// Settings -> Schedules tab. Lists all approved recurring policies for the
// active company. Lets you pause/resume, run-now, or delete. Same backend the
// chat-card approval writes to, so creating a schedule conversationally and
// managing it here are two doors into the same data.

interface Schedule {
  id: string;
  company_id: string;
  name: string;
  description: string | null;
  cadence_type: string;
  cadence_spec: Record<string, unknown>;
  cadence_human?: string;
  work_order_template: {
    type: string;
    agent: string;
    title: string;
    description: string;
    estimated_cost_usd?: number;
    estimated_minutes?: number;
  };
  is_active: boolean;
  last_run_at: string | null;
  next_run_at: string;
  total_fires: number;
  total_failures: number;
  created_at: string;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  };
  return d.toLocaleString(undefined, opts);
}

export function SchedulesTab() {
  const { company } = useCompany();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!company?.id) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/schedules?company_id=${company.id}`);
      if (r.ok) {
        const { schedules: s } = await r.json();
        setSchedules((s as Schedule[]) || []);
      }
    } finally {
      setLoading(false);
    }
  }, [company?.id]);

  useEffect(() => {
    refresh();
    // Auto-refresh every 30s so users see firings advance the next_run_at
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const togglePause = async (s: Schedule) => {
    setBusyId(s.id);
    try {
      const r = await fetch(`/api/schedules?id=${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !s.is_active }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        alert("Update failed: " + (body.error || r.statusText));
      }
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (s: Schedule) => {
    setBusyId(s.id);
    try {
      const r = await fetch(`/api/schedules?id=${s.id}&action=run-now`, { method: "POST" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert("Run-now failed: " + (body.error || r.statusText));
      } else {
        alert(`Fired manually. Task ${body.task_id?.slice(0, 8)} created.`);
      }
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (s: Schedule) => {
    if (!confirm(`Delete "${s.name}"? This cannot be undone.`)) return;
    setBusyId(s.id);
    try {
      const r = await fetch(`/api/schedules?id=${s.id}`, { method: "DELETE" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        alert("Delete failed: " + (body.error || r.statusText));
      }
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  if (!company) {
    return <p className="text-sm text-muted-foreground">Select a company to manage schedules.</p>;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold mb-1">Schedules</h2>
        <p className="text-sm text-muted-foreground">
          Recurring policies the agents follow. Each schedule fires its work order on a cadence.
          To create one, just ask the orchestrator in chat — say <em>"every Monday at 9, scrape Athlo and tell me what changed"</em>.
        </p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          Loading…
        </div>
      )}

      {!loading && schedules.length === 0 && (
        <div className="rounded-md border border-dashed border-border bg-card/50 px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground">
            No schedules yet. Ask the orchestrator in chat to set one up.
          </p>
        </div>
      )}

      {!loading && schedules.length > 0 && (
        <div className="space-y-2">
          {schedules.map(s => {
            const reliability = s.total_fires > 0
              ? Math.round(((s.total_fires - s.total_failures) / s.total_fires) * 100)
              : null;
            return (
              <div
                key={s.id}
                className={`rounded-md border ${s.is_active ? "border-border bg-card" : "border-border bg-muted/40 opacity-70"} p-3`}
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{s.name}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded border ${s.is_active ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-50 text-gray-600 border-gray-200"}`}>
                        {s.is_active ? <CheckCircle2 size={10} className="inline mr-1" /> : <Pause size={10} className="inline mr-1" />}
                        {s.is_active ? "active" : "paused"}
                      </span>
                      {s.total_failures > 0 && reliability !== null && reliability < 100 && (
                        <span className="text-xs px-1.5 py-0.5 rounded border bg-amber-50 text-amber-700 border-amber-200">
                          <AlertTriangle size={10} className="inline mr-1" />
                          {reliability}% reliable
                        </span>
                      )}
                    </div>
                    {s.description && (
                      <div className="text-xs text-gray-600 mt-0.5">{s.description}</div>
                    )}
                    <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                      <span className="inline-flex items-center gap-1">
                        <Clock size={11} /> {s.cadence_human || s.cadence_type}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Wrench size={11} /> {s.work_order_template.type} · {s.work_order_template.agent}
                      </span>
                      {s.work_order_template.estimated_cost_usd != null && (
                        <span className="inline-flex items-center gap-1">
                          <DollarSign size={11} /> ≤ ${s.work_order_template.estimated_cost_usd.toFixed(2)}/run
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                      <span><b>Next:</b> {s.is_active ? formatTime(s.next_run_at) : "—"}</span>
                      <span><b>Last:</b> {formatTime(s.last_run_at)}</span>
                      <span><b>Fires:</b> {s.total_fires}{s.total_failures > 0 ? ` (${s.total_failures} failed)` : ""}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => runNow(s)}
                      disabled={busyId === s.id}
                      className="text-xs flex items-center gap-1 px-2 py-1 rounded border border-border hover:bg-secondary disabled:opacity-50"
                      title="Fire now"
                    >
                      {busyId === s.id ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
                      Run now
                    </button>
                    <button
                      onClick={() => togglePause(s)}
                      disabled={busyId === s.id}
                      className="text-xs flex items-center gap-1 px-2 py-1 rounded border border-border hover:bg-secondary disabled:opacity-50"
                      title={s.is_active ? "Pause" : "Resume"}
                    >
                      {s.is_active ? <Pause size={12} /> : <Play size={12} />}
                      {s.is_active ? "Pause" : "Resume"}
                    </button>
                    <button
                      onClick={() => remove(s)}
                      disabled={busyId === s.id}
                      className="text-xs flex items-center gap-1 px-2 py-1 rounded border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50"
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
