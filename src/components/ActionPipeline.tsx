import { useState } from "react";
import { tasks, type Task } from "@/data/mockData";
import { ChevronDown, ChevronRight, CheckCircle2, Loader2, Clock, AlertCircle } from "lucide-react";
import TaskBlueprintModal from "./TaskBlueprintModal";

const statusConfig: Record<string, { icon: React.ElementType; color: string; bg: string; animate?: boolean }> = {
  completed: { icon: CheckCircle2, color: "text-emerald", bg: "bg-emerald/10" },
  running: { icon: Loader2, color: "text-amber", bg: "bg-amber/10", animate: true },
  queued: { icon: Clock, color: "text-muted-foreground", bg: "bg-muted" },
  failed: { icon: AlertCircle, color: "text-destructive", bg: "bg-destructive/10" },
};

const ActionPipeline = () => {
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  const toggleLog = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedLogs((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <>
      <div className="flex-1 flex flex-col h-full border-r border-border">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <span className="font-mono text-[10px] text-muted-foreground tracking-widest uppercase">
            Action Pipeline
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {tasks.length} tasks
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {tasks.map((task) => {
            const config = statusConfig[task.status];
            const StatusIcon = config.icon;
            const isExpanded = expandedLogs.has(task.id);

            return (
              <div
                key={task.id}
                onClick={() => setSelectedTask(task)}
                className="border border-border rounded-sm p-3 hover:border-emerald/20 transition-colors cursor-pointer"
              >
                <div className="flex items-start gap-2 mb-2">
                  <StatusIcon
                    size={14}
                    className={`mt-0.5 ${config.color} ${config.animate ? "animate-spin" : ""}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-mono text-[10px] text-muted-foreground">{task.id}</span>
                      <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded-sm ${config.bg} ${config.color}`}>
                        {task.status}
                      </span>
                    </div>
                    <p className="text-xs text-foreground font-medium truncate">{task.title}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] text-muted-foreground">{task.agentName}</span>
                      <span className="text-[10px] text-muted-foreground">·</span>
                      <span className="text-[10px] text-muted-foreground">{task.timestamp}</span>
                    </div>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="h-1 bg-muted rounded-sm overflow-hidden mb-2">
                  <div
                    className={`h-full transition-all duration-500 rounded-sm ${
                      task.status === "completed" ? "bg-emerald" : task.status === "running" ? "bg-amber" : "bg-muted-foreground/30"
                    }`}
                    style={{ width: `${task.progress}%` }}
                  />
                </div>

                {/* View Logs toggle */}
                <button
                  onClick={(e) => toggleLog(task.id, e)}
                  className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-emerald transition-colors"
                >
                  {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  View Logs
                </button>

                {isExpanded && (
                  <pre className="mt-2 p-2 bg-background rounded-sm text-[10px] font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap leading-relaxed border border-border">
                    {task.toolOutput}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <TaskBlueprintModal task={selectedTask} onClose={() => setSelectedTask(null)} />
    </>
  );
};

export default ActionPipeline;
