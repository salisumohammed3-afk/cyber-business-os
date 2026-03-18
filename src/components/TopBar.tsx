import { metrics } from "@/data/mockData";
import { TrendingUp, TrendingDown } from "lucide-react";

const TopBar = () => {
  return (
    <div className="h-12 border-b border-border bg-background flex items-center px-4 gap-6">
      <span className="text-lg font-semibold tracking-tight text-foreground mr-4">
        SalOS
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
      <div className="ml-auto flex items-center gap-3">
        <button className="px-3 py-1 rounded-sm bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors">
          + New
        </button>
        <button className="px-3 py-1 rounded-sm border border-border text-xs font-medium text-foreground hover:bg-secondary transition-colors">
          Menu ▾
        </button>
      </div>
    </div>
  );
};

export default TopBar;
