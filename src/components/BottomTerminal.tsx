import { useTerminalLogs } from "@/hooks/useSupabaseData";
import { Radio } from "lucide-react";

const BottomTerminal = () => {
  const { data: logs = [] } = useTerminalLogs();
  const duplicated = [...logs, ...logs];

  return (
    <div className="h-8 border-t border-border bg-background flex items-center px-4 overflow-hidden">
      <div className="flex items-center gap-1.5 mr-4 flex-shrink-0">
        <Radio size={10} className="text-emerald" />
        <span className="font-mono text-[9px] text-emerald tracking-wider">MCP CONNECTION: ACTIVE</span>
      </div>
      <div className="h-3 w-px bg-border mr-3 flex-shrink-0" />
      <div className="overflow-hidden flex-1">
        <div className="terminal-ticker whitespace-nowrap flex gap-8">
          {duplicated.map((log, i) => (
            <span key={i} className="font-mono text-[9px] text-muted-foreground">
              <span className="text-emerald/60">›</span> {log}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

export default BottomTerminal;
