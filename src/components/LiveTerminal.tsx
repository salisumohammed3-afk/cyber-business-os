import { useState, useEffect, useRef } from "react";
import { X, Minimize2, Maximize2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface LogEntry {
  id: string;
  message: string;
  source: string | null;
  agent_slug: string | null;
  log_type: string | null;
  created_at: string;
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
};

const LiveTerminal = () => {
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [isExpanded, setIsExpanded] = useState(true);
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Fetch logs and poll for new ones
  useEffect(() => {
    let lastSeenId: string | null = null;

    const fetchLogs = async (initial = false) => {
      const limit = initial ? 30 : 50;
      let query = supabase
        .from("terminal_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (!initial && lastSeenId) {
        query = supabase
          .from("terminal_logs")
          .select("*")
          .gt("created_at", lines[lines.length - 1]?.created_at || "2000-01-01")
          .order("created_at", { ascending: true })
          .limit(20);
      }

      const { data } = await query;
      if (!data || data.length === 0) return;

      if (initial) {
        const sorted = data.reverse();
        setLines(sorted as LogEntry[]);
        lastSeenId = sorted[sorted.length - 1]?.id || null;
        const latest = data[0];
        if (latest?.agent_slug) setActiveAgent(latest.agent_slug);
      } else {
        const sorted = data as LogEntry[];
        if (sorted.length > 0 && sorted[sorted.length - 1].id !== lastSeenId) {
          setLines((prev) => {
            const existingIds = new Set(prev.map(l => l.id));
            const newEntries = sorted.filter(l => !existingIds.has(l.id));
            if (newEntries.length === 0) return prev;
            const next = [...prev, ...newEntries];
            return next.length > 100 ? next.slice(-100) : next;
          });
          lastSeenId = sorted[sorted.length - 1].id;
          const latest = sorted[sorted.length - 1];
          if (latest?.agent_slug) setActiveAgent(latest.agent_slug);
        }
      }
    };

    fetchLogs(true);
    const interval = setInterval(() => fetchLogs(false), 2000);

    // Also try realtime (works when Supabase WS is available)
    const channel = supabase
      .channel("terminal_logs_realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "terminal_logs" },
        (payload) => {
          const row = payload.new as LogEntry;
          setLines((prev) => {
            if (prev.some(l => l.id === row.id)) return prev;
            const next = [...prev, row];
            return next.length > 100 ? next.slice(-100) : next;
          });
          if (row.agent_slug) setActiveAgent(row.agent_slug);
          lastSeenId = row.id;
        }
      )
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

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
            aura-os — {activeAgent ? `agent:${activeAgent}` : "system"} — live execution
          </span>
          {hasLogs && (
            <span className="font-mono text-[9px] text-emerald-500 ml-2">{lines.length} events</span>
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

      {/* Log output */}
      <div ref={scrollRef} className="h-40 overflow-y-auto px-4 py-2">
        {!hasLogs && (
          <div className="font-mono text-[11px] text-[hsl(0,0%,40%)] leading-5">
            &gt; Waiting for agent activity...
          </div>
        )}
        {lines.map((line) => {
          const color = logTypeColor[line.log_type || ""] || "text-[hsl(var(--terminal-fg))]";
          return (
            <div key={line.id} className="font-mono text-[11px] leading-5 flex gap-2">
              <span className="text-[hsl(0,0%,35%)] shrink-0 select-none">
                {new Date(line.created_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
              <span className={color}>
                &gt; {line.message}
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
