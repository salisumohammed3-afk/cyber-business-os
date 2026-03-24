import { useState, useMemo } from "react";
import { useTasks, useTaskActions, type Task } from "@/hooks/useSupabaseData";
import {
  CheckCircle2,
  Loader2,
  Clock,
  AlertCircle,
  XCircle,
  Repeat,
  ChevronRight,
  Lightbulb,
  Wrench,
  Zap,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import TaskBlueprintModal from "./TaskBlueprintModal";

type TabKey = "proposed" | "todo" | "recurring" | "running" | "completed" | "rejected" | "failed";

const tabs: { key: TabKey; label: string }[] = [
  { key: "proposed", label: "Proposed" },
  { key: "todo", label: "Approved" },
  { key: "recurring", label: "Recurring" },
  { key: "running", label: "In Progress" },
  { key: "completed", label: "Completed" },
  { key: "rejected", label: "Rejected" },
  { key: "failed", label: "Failed" },
];

const statusConfig: Record<
  string,
  { icon: React.ElementType; color: string; bg: string; label: string; animate?: boolean }
> = {
  proposed: { icon: Lightbulb, color: "text-violet-500", bg: "bg-violet-500/10", label: "proposed" },
  completed: { icon: CheckCircle2, color: "text-emerald-500", bg: "bg-emerald-500/10", label: "completed" },
  running: { icon: Loader2, color: "text-amber-500", bg: "bg-amber-500/10", label: "running", animate: true },
  pending: { icon: Clock, color: "text-muted-foreground", bg: "bg-secondary", label: "approved" },
  queued: { icon: Clock, color: "text-muted-foreground", bg: "bg-secondary", label: "queued" },
  failed: { icon: AlertCircle, color: "text-red-500", bg: "bg-red-500/10", label: "failed" },
  cancelled: { icon: XCircle, color: "text-orange-500", bg: "bg-orange-500/10", label: "rejected" },
};

const fallbackConfig = { icon: Clock, color: "text-muted-foreground", bg: "bg-secondary", label: "unknown" };

function filterTasks(tasks: Task[], tab: TabKey): Task[] {
  switch (tab) {
    case "proposed":
      return tasks.filter((t) => t.status === "proposed");
    case "todo":
      return tasks.filter((t) => (t.status === "pending" || t.status === "queued") && !t.is_recurring);
    case "recurring":
      return tasks.filter((t) => t.is_recurring);
    case "running":
      return tasks.filter((t) => t.status === "running");
    case "completed":
      return tasks.filter((t) => t.status === "completed");
    case "rejected":
      return tasks.filter((t) => t.status === "cancelled");
    case "failed":
      return tasks.filter((t) => t.status === "failed");
    default:
      return tasks;
  }
}

function relativeTime(dateStr?: string | null): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const ActionPipeline = () => {
  const { data: tasks = [], isLoading } = useTasks();
  const { deleteTask } = useTaskActions();
  const [activeTab, setActiveTab] = useState<TabKey>("proposed");
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  const tabCounts = useMemo(() => {
    const counts: Record<TabKey, number> = { proposed: 0, todo: 0, recurring: 0, running: 0, completed: 0, rejected: 0, failed: 0 };
    for (const t of tasks) {
      if (t.status === "proposed") counts.proposed++;
      if (t.is_recurring) counts.recurring++;
      if ((t.status === "pending" || t.status === "queued") && !t.is_recurring) counts.todo++;
      if (t.status === "running") counts.running++;
      if (t.status === "completed") counts.completed++;
      if (t.status === "cancelled") counts.rejected++;
      if (t.status === "failed") counts.failed++;
    }
    return counts;
  }, [tasks]);

  const filtered = useMemo(() => filterTasks(tasks, activeTab), [tasks, activeTab]);

  return (
    <>
      <div className="flex-1 flex flex-col h-full border-r border-border">
        <div className="p-3 border-b border-border">
          <span className="font-mono text-[10px] text-muted-foreground tracking-widest uppercase">
            Task Pipeline
          </span>
        </div>

        <div className="flex border-b border-border overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground/70"
              }`}
            >
              {tab.label}
              {tabCounts[tab.key] > 0 && (
                <span
                  className={`text-[9px] font-mono px-1.5 py-0.5 rounded-full ${
                    activeTab === tab.key ? "bg-foreground text-background" : "bg-secondary text-muted-foreground"
                  }`}
                >
                  {tabCounts[tab.key]}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {isLoading ? (
            <div className="p-8 text-center text-xs text-muted-foreground">Loading tasks...</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              No tasks in this category.
            </div>
          ) : (
            filtered.map((task) => {
              const config = statusConfig[task.status] || fallbackConfig;
              const StatusIcon = config.icon;
              const tags: string[] = Array.isArray(task.tags) ? task.tags : [];

              return (
                <div
                  key={task.id}
                  onClick={() => setSelectedTask(task)}
                  className={`relative rounded-md p-3 transition-colors cursor-pointer group ${
                    task.status === "proposed"
                      ? "border border-dashed border-violet-500/40 hover:border-violet-500/70 bg-violet-500/[0.03]"
                      : "border border-border hover:border-foreground/20"
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <StatusIcon
                      size={14}
                      className={`mt-0.5 flex-shrink-0 ${config.color} ${config.animate ? "animate-spin" : ""}`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">
                        {task.title || task.description || "Untitled task"}
                      </p>
                      {task.description && task.description !== task.title && (
                        <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                          {task.description}
                        </p>
                      )}
                      {/* Result preview for completed tasks */}
                      {task.status === "completed" && task.result && (
                        <div className="flex items-center gap-2 mt-1.5 text-[10px] text-muted-foreground">
                          {task.result.turns != null && (
                            <span className="flex items-center gap-0.5">
                              <Zap size={9} className="text-amber-500" />
                              {task.result.turns} turn{task.result.turns !== 1 ? "s" : ""}
                            </span>
                          )}
                          {task.result.tools_used && task.result.tools_used.length > 0 && (
                            <span className="flex items-center gap-0.5">
                              <Wrench size={9} className="text-blue-500" />
                              {task.result.tools_used.join(", ")}
                            </span>
                          )}
                        </div>
                      )}
                      {task.status === "completed" && task.result?.response && (
                        <p className="text-[10px] text-muted-foreground mt-1 line-clamp-1 italic">
                          {task.result.response.slice(0, 120)}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        {tags.length > 0 &&
                          tags.map((tag) => (
                            <Badge
                              key={tag}
                              variant="secondary"
                              className="text-[9px] px-1.5 py-0 h-4 font-normal"
                            >
                              {tag}
                            </Badge>
                          ))}
                        {task.is_recurring && (
                          <span className="flex items-center gap-0.5 text-[9px] text-muted-foreground">
                            <Repeat size={9} />
                            {task.recurrence_schedule || "recurring"}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-[10px] text-muted-foreground">
                        {relativeTime(task.created_at || task.timestamp)}
                      </span>
                      <ChevronRight
                        size={12}
                        className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                      />
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteTask(task.id);
                    }}
                    className="absolute bottom-2 right-2 p-1 rounded-md text-muted-foreground/50 hover:text-red-500 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      <TaskBlueprintModal task={selectedTask} onClose={() => setSelectedTask(null)} />
    </>
  );
};

export default ActionPipeline;
