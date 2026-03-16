import { type Task } from "@/hooks/useSupabaseData";
import { X, Brain, Terminal } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

interface Props {
  task: Task | null;
  onClose: () => void;
}

const TaskBlueprintModal = ({ task, onClose }: Props) => {
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
            className="w-full max-w-2xl mx-4 bg-background border border-border rounded-sm overflow-hidden shadow-lg"
          >
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div>
                <span className="font-mono text-[10px] text-muted-foreground">{task.id.slice(0, 8)}</span>
                <h2 className="text-sm font-medium text-foreground mt-0.5">{task.title || task.description || "Untitled task"}</h2>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[10px] text-muted-foreground">{task.agent_name || "orchestrator"}</span>
                  <span className="text-[10px] text-muted-foreground">·</span>
                  <span className="text-[10px] text-muted-foreground">{task.timestamp || task.created_at || ""}</span>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-1 rounded-sm hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Brain size={12} className="text-emerald" />
                  <span className="font-mono text-[10px] text-emerald tracking-wider uppercase">
                    Agent Reasoning
                  </span>
                </div>
                <p className="text-xs text-foreground leading-relaxed bg-secondary p-3 rounded-sm border border-border">
                  {task.reasoning || task.description || "No reasoning available."}
                </p>
              </div>

              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Terminal size={12} className="text-amber" />
                  <span className="font-mono text-[10px] text-amber tracking-wider uppercase">
                    Tool Output
                  </span>
                </div>
                <pre className="text-[10px] font-mono text-muted-foreground bg-secondary p-3 rounded-sm border border-border overflow-x-auto whitespace-pre-wrap leading-relaxed">
                  {task.tool_output || task.error_message || "No output yet."}
                </pre>
              </div>
            </div>

            <div className="p-3 border-t border-border flex items-center justify-between">
              <span className="font-mono text-[9px] text-muted-foreground">
                Task Blueprint{task.category ? ` · ${task.category}` : ""}
              </span>
              <div className="h-1 w-24 bg-secondary rounded-sm overflow-hidden">
                <div
                  className={`h-full rounded-sm ${task.status === "completed" ? "bg-emerald" : "bg-amber"}`}
                  style={{ width: `${task.status === "completed" ? 100 : task.status === "running" ? 50 : (task.progress ?? 0)}%` }}
                />
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default TaskBlueprintModal;
