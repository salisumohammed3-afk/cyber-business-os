import { type Task, useTaskActions } from "@/hooks/useSupabaseData";
import {
  X,
  Play,
  XCircle,
  RotateCcw,
  Trash2,
  Copy,
  Clock,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Bot,
  Lightbulb,
  Check,
  Wrench,
  Zap,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import ReactMarkdown from "react-markdown";
import { useState } from "react";

interface Props {
  task: Task | null;
  onClose: () => void;
}

const statusDisplay: Record<string, { icon: React.ElementType; label: string; color: string }> = {
  proposed: { icon: Lightbulb, label: "Proposed", color: "text-violet-500" },
  pending: { icon: Clock, label: "Approved", color: "text-muted-foreground" },
  queued: { icon: Clock, label: "Queued", color: "text-muted-foreground" },
  running: { icon: Loader2, label: "In Progress", color: "text-amber-500" },
  completed: { icon: CheckCircle2, label: "Completed", color: "text-emerald-500" },
  failed: { icon: AlertCircle, label: "Failed", color: "text-red-500" },
  cancelled: { icon: XCircle, label: "Rejected", color: "text-orange-500" },
};

function formatTimestamp(ts?: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const TaskBlueprintModal = ({ task, onClose }: Props) => {
  const { approveTask, runTask, rejectTask, retryTask, deleteTask, repeatTask } = useTaskActions();
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleAction = async (action: string, fn: () => Promise<void>) => {
    setActionLoading(action);
    try {
      await fn();
      onClose();
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <AnimatePresence>
      {task && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.15 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl mx-4 bg-background border border-border rounded-md overflow-hidden shadow-lg flex flex-col max-h-[80vh]"
          >
            {/* Header */}
            <div className="flex items-start justify-between p-4 border-b border-border">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {task.id.slice(0, 8)}
                  </span>
                  {(() => {
                    const sd = statusDisplay[task.status] || statusDisplay.pending;
                    const StatusIcon = sd.icon;
                    return (
                      <Badge variant="secondary" className={`text-[10px] gap-1 ${sd.color}`}>
                        <StatusIcon size={10} className={task.status === "running" ? "animate-spin" : ""} />
                        {sd.label}
                      </Badge>
                    );
                  })()}
                </div>
                <h2 className="text-sm font-medium text-foreground">
                  {task.title || task.description || "Untitled task"}
                </h2>
              </div>
              <button
                onClick={onClose}
                className="p-1 rounded-sm hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors ml-2"
              >
                <X size={14} />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
              {/* Agent assignment */}
              <div className="flex items-center gap-2">
                <Bot size={12} className="text-muted-foreground" />
                <span className="text-[11px] text-muted-foreground">
                  Assigned to:{" "}
                  <span className="text-foreground font-medium">
                    {task.agent_name || "Orchestrator"}
                  </span>
                </span>
                {task.source && task.source !== "internal" && (
                  <Badge variant="outline" className="text-[9px] ml-auto">
                    source: {task.source}
                  </Badge>
                )}
              </div>

              {/* Tags */}
              {Array.isArray(task.tags) && task.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {task.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-[10px]">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}

              {/* Description */}
              {task.description && (
                <div>
                  <span className="font-mono text-[10px] text-muted-foreground tracking-wider uppercase block mb-1.5">
                    Description
                  </span>
                  <div className="text-xs text-foreground leading-relaxed bg-secondary p-3 rounded-md border border-border prose prose-sm prose-gray max-w-none [&_p]:my-1 [&_ul]:my-1 [&_li]:my-0.5">
                    <ReactMarkdown>{task.description}</ReactMarkdown>
                  </div>
                </div>
              )}

              {/* Timestamps */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <span className="font-mono text-[9px] text-muted-foreground block mb-0.5">Created</span>
                  <span className="text-[11px] text-foreground">{formatTimestamp(task.created_at || task.timestamp)}</span>
                </div>
                <div>
                  <span className="font-mono text-[9px] text-muted-foreground block mb-0.5">Started</span>
                  <span className="text-[11px] text-foreground">{formatTimestamp(task.started_at)}</span>
                </div>
                <div>
                  <span className="font-mono text-[9px] text-muted-foreground block mb-0.5">Completed</span>
                  <span className="text-[11px] text-foreground">{formatTimestamp(task.completed_at)}</span>
                </div>
              </div>

              {/* Section 2: Result / Outcome */}
              {task.result?.response && (
                <div>
                  <span className="font-mono text-[10px] text-muted-foreground tracking-wider uppercase block mb-1.5">
                    Result
                  </span>
                  <div className="text-xs text-foreground leading-relaxed bg-secondary p-3 rounded-md border border-border prose prose-sm prose-gray max-w-none [&_p]:my-1 [&_ul]:my-1 [&_li]:my-0.5 max-h-64 overflow-y-auto">
                    <ReactMarkdown>{task.result.response}</ReactMarkdown>
                  </div>
                </div>
              )}

              {!task.result?.response && (task.tool_output || task.reasoning) && (
                <div>
                  <span className="font-mono text-[10px] text-muted-foreground tracking-wider uppercase block mb-1.5">
                    Result
                  </span>
                  <pre className="text-[10px] font-mono text-muted-foreground bg-secondary p-3 rounded-md border border-border overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                    {task.tool_output || task.reasoning}
                  </pre>
                </div>
              )}

              {/* Section 3: Steps / What Happened */}
              {task.result && (
                <div className="space-y-2">
                  <span className="font-mono text-[10px] text-muted-foreground tracking-wider uppercase block">
                    Steps
                  </span>

                  <div className="flex flex-wrap items-center gap-3 text-[10px]">
                    {task.result.turns != null && (
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Zap size={10} className="text-amber-500" />
                        <span>{task.result.turns} turn{task.result.turns !== 1 ? "s" : ""}</span>
                      </div>
                    )}
                    {task.result.tools_used && task.result.tools_used.length > 0 && (
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Wrench size={10} className="text-blue-500" />
                        <span>{task.result.tools_used.length} tool{task.result.tools_used.length !== 1 ? "s" : ""} used</span>
                      </div>
                    )}
                    {task.result.model && (
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Bot size={10} />
                        <span>{task.result.model}</span>
                      </div>
                    )}
                    {task.result.max_turns_reached && (
                      <Badge variant="secondary" className="text-[9px] text-amber-500">max turns</Badge>
                    )}
                    {(task.result as Record<string, unknown>).attempt && (
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <RotateCcw size={10} className="text-violet-500" />
                        <span>attempt {(task.result as Record<string, unknown>).attempt as number}</span>
                      </div>
                    )}
                  </div>

                  {task.result.tools_used && task.result.tools_used.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {task.result.tools_used.map((tool) => (
                        <Badge key={tool} variant="outline" className="text-[9px] font-mono gap-1">
                          <Wrench size={8} />
                          {tool}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {task.result.tool_calls && Array.isArray(task.result.tool_calls) && task.result.tool_calls.length > 0 && (
                    <div className="space-y-1 mt-1">
                      {task.result.tool_calls.map((tc: { tool: string; source: string }, i: number) => (
                        <div key={i} className="flex items-center gap-2 text-[10px] text-muted-foreground pl-1">
                          <span className="text-[9px] font-mono text-muted-foreground/50 w-4 text-right">{i + 1}.</span>
                          <Badge variant="outline" className="text-[8px] font-mono px-1 py-0">{tc.source}</Badge>
                          <span className="font-mono">{tc.tool}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Error message */}
              {task.error_message && (
                <div>
                  <span className="font-mono text-[10px] text-red-500 tracking-wider uppercase block mb-1.5">
                    Error
                  </span>
                  <pre className="text-[10px] font-mono text-red-400 bg-red-500/5 p-3 rounded-md border border-red-500/20 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                    {task.error_message}
                  </pre>
                </div>
              )}
            </div>

            {/* Footer with action buttons */}
            <div className="p-3 border-t border-border flex flex-wrap items-center justify-end gap-2 flex-shrink-0">
              {task.status === "proposed" && (
                <>
                  <button
                    onClick={() => handleAction("reject", () => rejectTask(task.id))}
                    disabled={actionLoading !== null}
                    className="flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                  >
                    <XCircle size={13} />
                    Reject
                  </button>
                  <button
                    onClick={() => handleAction("approve", () => approveTask(task.id))}
                    disabled={actionLoading !== null}
                    className="flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-emerald text-white hover:brightness-110 transition-all disabled:opacity-50"
                  >
                    {actionLoading === "approve" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                    Approve & Run
                  </button>
                </>
              )}

              {(task.status === "pending" || task.status === "queued") && (
                <>
                  <button
                    onClick={() => handleAction("reject", () => rejectTask(task.id))}
                    disabled={actionLoading !== null}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                  >
                    <XCircle size={12} />
                    Cancel
                  </button>
                  <button
                    onClick={() => handleAction("run", () => runTask(task.id))}
                    disabled={actionLoading !== null}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-md bg-foreground text-background hover:bg-foreground/90 transition-colors disabled:opacity-50"
                  >
                    {actionLoading === "run" ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                    Run Now
                  </button>
                </>
              )}

              {task.status === "running" && (
                <button
                  onClick={() => handleAction("reject", () => rejectTask(task.id))}
                  disabled={actionLoading !== null}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                >
                  <XCircle size={12} />
                  Cancel
                </button>
              )}

              {task.status === "completed" && (
                <button
                  onClick={() => handleAction("repeat", () => repeatTask(task))}
                  disabled={actionLoading !== null}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                >
                  <Copy size={12} />
                  Repeat
                </button>
              )}

              {task.status === "failed" && (
                <>
                  <button
                    onClick={() => handleAction("delete", () => deleteTask(task.id))}
                    disabled={actionLoading !== null}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-md border border-red-500/30 text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                  >
                    <Trash2 size={12} />
                    Delete
                  </button>
                  <button
                    onClick={() => handleAction("retry", () => retryTask(task.id))}
                    disabled={actionLoading !== null}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-md bg-foreground text-background hover:bg-foreground/90 transition-colors disabled:opacity-50"
                  >
                    {actionLoading === "retry" ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                    Retry
                  </button>
                </>
              )}

              {task.status === "cancelled" && (
                <button
                  onClick={() => handleAction("delete", () => deleteTask(task.id))}
                  disabled={actionLoading !== null}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                >
                  <Trash2 size={12} />
                  Delete
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default TaskBlueprintModal;
