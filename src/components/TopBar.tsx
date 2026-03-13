import { metrics } from "@/data/mockData";
import { TrendingUp, TrendingDown } from "lucide-react";

const TopBar = () => {
  return (
    <div className="h-12 border-b border-border bg-card flex items-center px-4 gap-6">
      <span className="font-mono text-xs text-muted-foreground tracking-widest uppercase mr-4">
        AuraOS
      </span>
      <div className="h-4 w-px bg-border" />
      {metrics.map((m) => (
        <div key={m.label} className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{m.label}</span>
          <span className="font-mono text-sm text-foreground font-medium">{m.value}</span>
          {m.change && (
            <span className={`flex items-center gap-0.5 text-xs font-mono ${m.positive ? "text-emerald" : "text-amber"}`}>
              {m.positive ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
              {m.change}
            </span>
          )}
          <div className="h-4 w-px bg-border ml-2" />
        </div>
      ))}
      <div className="ml-auto flex items-center gap-2">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald pulse-active" />
        <span className="font-mono text-xs text-emerald">ONLINE</span>
      </div>
    </div>
  );
};

export default TopBar;
