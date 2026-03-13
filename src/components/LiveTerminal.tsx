import { useState, useEffect, useRef } from "react";
import { X, Minimize2, Maximize2 } from "lucide-react";

const liveLogLines = [
  "> Initializing cold outreach pipeline...",
  "> Loading ICP criteria from knowledge base...",
  "> Searching web for: Vodafone CTO digital transformation AI strategy Europe...",
  "> Found: [contact verified]",
  "> Searching web for: UniCredit Chief AI Officer fintech enterprise...",
  "> Found: [email]",
  "> Finding email addresses...",
  "> Searching web for: BNY Mellon CDO AI deployment enterprise agents...",
  "> Found: [email]",
  "> Found: [email]",
  "> Searching web for: MTN Group CEO Africa telecom AI digital transformation...",
  "> Found: [email]",
  "> Finding email addresses...",
  "> Searching web for: Siemens AG Chief Technology Officer digital transformation AI strategy Europe...",
  "> Found: [email]",
  "> Searching web for: Safaricom MTN Africa telecommunications CEO CTO AI digital transformation strate......",
  "> Found: [email]",
  "> Found: [email]",
  "> Finding email addresses...",
  "> Finding email addresses...",
  "> Finding email addresses...",
  "> Searching web for: BBVA Chief Digital Officer AI strategy Spain Europe 2026 leadership...",
  "> Found: [email]",
  "> Found: [email]",
  "> Finding email addresses...",
  "> Searching web for: ABB Switzerland CEO CTO Chief Technology Ofstdout:ficer AI transformation Europe...",
  "> Found: [email]",
  "> Using company_email:add_lead...",
  "> Using company_email:add_lead...",
  "> Lead pipeline updated. 10/10 contacts verified.",
  "> Generating personalized outreach sequences...",
  "> Sequence 1/10: Scott Petty (Vodafone) — 3 emails drafted",
  "> Sequence 2/10: Anabel Almagro (UniCredit) — 3 emails drafted",
  "> Applying tone: consultative, enterprise, AI-native...",
  "> Sequence 3/10: Eric Hirschhorn (BNY Mellon) — 3 emails drafted",
  "> Cross-referencing CRM for prior touchpoints...",
  "> No prior contact found. Cold sequence confirmed.",
  "> Sequence 4/10: Ralph Mupita (MTN Group) — customizing for Africa market...",
];

const LiveTerminal = () => {
  const [lines, setLines] = useState<string[]>([]);
  const [isExpanded, setIsExpanded] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const indexRef = useRef(0);

  useEffect(() => {
    // Start with a few lines
    setLines(liveLogLines.slice(0, 5));
    indexRef.current = 5;

    const interval = setInterval(() => {
      if (indexRef.current < liveLogLines.length) {
        setLines((prev) => [...prev, liveLogLines[indexRef.current]]);
        indexRef.current++;
      } else {
        // Loop back
        indexRef.current = 0;
        setLines([]);
      }
    }, 800);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  if (!isExpanded) {
    return (
      <div className="bg-[hsl(var(--terminal-bg))] border-b border-[hsl(0,0%,15%)] px-4 py-1.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-[hsl(var(--terminal-fg))] pulse-active" />
          <span className="font-mono text-[10px] text-[hsl(var(--terminal-fg))]">LIVE EXECUTION — agent:growth running</span>
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
          <span className="font-mono text-[10px] text-[hsl(0,0%,50%)] ml-2">aura-os — agent:growth — cold_outreach_pipeline</span>
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
        {lines.map((line, i) => (
          <div key={i} className="font-mono text-[11px] leading-5 text-[hsl(var(--terminal-fg))]">
            {line}
          </div>
        ))}
        <span className="font-mono text-[11px] text-[hsl(var(--terminal-fg))] animate-pulse">█</span>
      </div>
    </div>
  );
};

export default LiveTerminal;
