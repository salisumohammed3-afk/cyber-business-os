import { useState, useEffect, useRef, useMemo } from "react";
import { X, Minimize2, Maximize2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useCompany } from "@/contexts/CompanyContext";

interface LogEntry {
  id: string;
  message: string;
  source: string | null;
  agent_slug: string | null;
  task_id: string | null;
  log_type: string | null;
  created_at: string;
  metadata?: unknown;
}

const logTypeColor: Record<string, string> = {
  task_start: "text-amber-400",
  agent_loaded: "text-blue-400",
  llm_call: "text-purple-400",
  tool_call: "text-cyan-400",
  tool_result: "text-emerald-400",
  task_complete: "text-green-400",
  memory_recall: "text-yellow-400",
  error: "text-red-400",
  provider_error: "text-orange-400",
  worker_exit_reconcile: "text-amber-400",
  digest_skipped_idempotent: "text-slate-400",
};

const LiveTerminal = () => {
  const { company } = useCompany();
  const companyId = company?.id;
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [isExpanded, setIsExpanded] = useState(true);
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastSeenTimestampRef = useRef<string>("2000-01-01T00:00:00Z");

  const filteredLines = useMemo(() => {
    const tf = taskFilter.trim().toLowerCase();
    const yf = typeFilter.trim().toLowerCase();
    return lines.filter((line) => {
      if (tf && !(line.task_id || "").toLowerCase().includes(tf)) return false;
      if (yf && !(line.log_type || "").toLowerCase().includes(yf)) return false;
      return true;
    });
  }, [lines, taskFilter, typeFilter]);

  useEffect(() => {
    if (!companyId) return;

    setLines([]);
    lastSeenTimestampRef.current = "2000-01-01T00:00:00Z";

    const fetchLogs = async (initial = false) => {
      if (initial) {
        const { data } = await supabase
          .from("terminal_logs")
          .select("*")
          .eq("company_id", companyId)
          .order("created_at", { ascending: false })
          .limit(30);
        if (!data || data.length === 0) return;

        const sorted = [...data].reverse() as LogEntry[];
        setLines(sorted);
        lastSeenTimestampRef.current = sorted[sorted.length - 1]!.created_at;
        if (sorted[0]?.agent_slug) setActiveAgent(sorted[0].agent_slug);
      } else {
        const { data } = await supabase
          .from("terminal_logs")
          .select("*")
          .eq("company_id", companyId)
          .gt("created_at", lastSeenTimestampRef.current)
          .order("created_at", { ascending: true })
          .limit(30);
        if (!data || data.length === 0) return;

        const newRows = data as LogEntry[];
        lastSeenTimestampRef.current = newRows[newRows.length - 1].created_at;
        const latestAgent = newRows[newRows.length - 1].agent_slug;
        if (latestAgent) setActiveAgent(latestAgent);

        setLines((prev) => {
          const existingIds = new Set(prev.map((l) => l.id));
          const fresh = newRows.filter((l) => !existingIds.has(l.id));
          if (fresh.length === 0) return prev;
          const next = [...prev, ...fresh];
          return next.length > 200 ? next.slice(-200) : next;
        });
      }
    };

    fetchLogs(true);
    const interval = setInterval(() => fetchLogs(false), 1500);

    const channel = supabase
      .channel(`terminal_logs_${companyId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "terminal_logs" },
        (payload) => {
          const row = payload.new as LogEntry & { company_id?: string | null };
          if (companyId && row.company_id && row.company_id !== companyId) return;
          lastSeenTimestampRef.current = row.created_at;
          if (row.agent_slug) setActiveAgent(row.agent_slug);
          setLines((prev) => {
            if (prev.some((l) => l.id === row.id)) return prev;
            const next = [...prev, row];
            return next.length > 200 ? next.slice(-200) : next;
          });
        }
      )
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [companyId]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, filteredLines]);

  const hasLogs = lines.length > 0;
  const latestLog = lines[lines.length - 1];

  if (!isExpanded) {
    return (
      <div className="bg-[hsl(var(--terminal-bg))] border-b border-[hsl(0,0%,15%)] px-4 py-1.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full ${hasLogs ? "bg-emerald-400 pulse-active" : "bg-[hsl(0,0%,30%)]"}`} />
          <span className="font-mono text-[10px] text-[hsl(var(--terminal-fg))]">
            {hasLogs
              ? `LIVE — ${activeAgent || "system"} — ${latestLog?.message.slice(0, 60)}...`
              : "TERMINAL — no recent activity"}
          </span>
        </div>
        <button onClick={() => setIsExpanded(true)} className="text-[hsl(0,0%,50%)] hover:text-[hsl(0,0%,80%)] transition-colors">
          <Maximize2 size={10} />
        </button>
      </div>
    );
  }

  return (
    <div className="bg-[hsl(var(--terminal-bg))] border-b border-[hsl(0,0%,15%)]">
      {/* Terminal chrome */}
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-[hsl(0,0%,12%)]">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-[hsl(0,70%,55%)]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[hsl(45,90%,55%)]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[hsl(142,71%,45%)]" />
          </div>
          <span className="font-mono text-[10px] text-[hsl(0,0%,50%)] ml-2">
            sal-os — {activeAgent ? `agent:${activeAgent}` : "system"} — live execution
          </span>
          {hasLogs && (
            <span className="font-mono text-[9px] text-emerald-500 ml-2">
              {filteredLines.length}/{lines.length} events
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setIsExpanded(false)} className="text-[hsl(0,0%,50%)] hover:text-[hsl(0,0%,80%)] transition-colors">
            <Minimize2 size={10} />
          </button>
          <button onClick={() => setIsExpanded(false)} className="text-[hsl(0,0%,50%)] hover:text-[hsl(0,0%,80%)] transition-colors">
            <X size={10} />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 py-1 border-b border-[hsl(0,0%,12%)]">
        <input
          type="text"
          value={taskFilter}
          onChange={(e) => setTaskFilter(e.target.value)}
          placeholder="Filter task id…"
          className="font-mono text-[10px] h-7 px-2 rounded border border-[hsl(0,0%,20%)] bg-[hsl(0,0%,8%)] text-[hsl(var(--terminal-fg))] w-40 placeholder:text-[hsl(0,0%,35%)]"
        />
        <input
          type="text"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          placeholder="Filter log_type…"
          className="font-mono text-[10px] h-7 px-2 rounded border border-[hsl(0,0%,20%)] bg-[hsl(0,0%,8%)] text-[hsl(var(--terminal-fg))] w-36 placeholder:text-[hsl(0,0%,35%)]"
        />
      </div>

      {/* Log output */}
      <div ref={scrollRef} className="h-40 overflow-y-auto px-4 py-2">
        {!hasLogs && (
          <div className="font-mono text-[11px] text-[hsl(0,0%,40%)] leading-5">
            &gt; Waiting for agent activity...
          </div>
        )}
        {filteredLines.map((line) => {
          const color = logTypeColor[line.log_type || ""] || "text-[hsl(var(--terminal-fg))]";
          const metaJson =
            line.metadata && typeof line.metadata === "object" ? JSON.stringify(line.metadata) : "";
          const metaHint =
            metaJson.length > 0
              ? " " + metaJson.slice(0, 120) + (metaJson.length > 120 ? "…" : "")
              : "";
          return (
            <div key={line.id} className="font-mono text-[11px] leading-5 flex gap-2">
              <span className="text-[hsl(0,0%,35%)] shrink-0 select-none">
                {new Date(line.created_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
              <span className="text-[hsl(0,0%,45%)] shrink-0 hidden sm:inline">{line.task_id ? line.task_id.slice(0, 8) : "—"}</span>
              <span className={color}>
                &gt; {line.message}
                {metaHint && <span className="text-[hsl(0,0%,45%)] font-normal">{metaHint}</span>}
              </span>
            </div>
          );
        })}
        <span className="font-mono text-[11px] text-[hsl(var(--terminal-fg))] animate-pulse">█</span>
      </div>
    </div>
  );
};

export default LiveTerminal;
