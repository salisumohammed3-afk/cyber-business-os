import { useState, useEffect } from "react";
import TopBar from "@/components/TopBar";
import AgentSidebar from "@/components/AgentSidebar";
import ActionPipeline from "@/components/ActionPipeline";
import CEOChat from "@/components/CEOChat";
import BottomTerminal from "@/components/BottomTerminal";
import LiveTerminal from "@/components/LiveTerminal";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTasks } from "@/hooks/useSupabaseData";
import { MessageSquare, ListTodo } from "lucide-react";

type MobileTab = "chat" | "tasks";

const Index = () => {
  const isMobile = useIsMobile();
  const [mobileTab, setMobileTab] = useState<MobileTab>("chat");

  if (isMobile) {
    return <MobileLayout tab={mobileTab} onTabChange={setMobileTab} />;
  }

  // Desktop: full operations surface
  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <LiveTerminal />
      <TopBar />
      <ResizablePanelGroup direction="horizontal" className="flex-1 overflow-hidden">
        <ResizablePanel defaultSize={15} minSize={10} maxSize={25}>
          <AgentSidebar />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={45} minSize={20}>
          <ActionPipeline />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={40} minSize={20} maxSize={70}>
          <CEOChat />
        </ResizablePanel>
      </ResizablePanelGroup>
      <BottomTerminal />
    </div>
  );
};

// ── Mobile shell ───────────────────────────────────────────────────────────
// Top: TopBar (with Outputs/Agents icons + hamburger)
// Tabs: Chat | Tasks  (with badge for proposed-task count, so the user knows
//       when an approval is pending even if they're on Chat)
// Body: whichever tab is selected
function MobileLayout({
  tab,
  onTabChange,
}: {
  tab: MobileTab;
  onTabChange: (t: MobileTab) => void;
}) {
  const { data: tasks = [] } = useTasks();
  const proposedCount = tasks.filter(t => t.status === "proposed").length;

  // Auto-jump to Tasks when a new proposed-task appears so the user notices
  // the approval card even if they're not on the Tasks tab. Only triggers
  // when going from 0 → 1 to avoid stealing focus mid-scroll.
  const [lastSeenProposed, setLastSeenProposed] = useState(proposedCount);
  useEffect(() => {
    if (proposedCount > lastSeenProposed && tab === "chat") {
      // Don't auto-switch — that's invasive. Just badge it (the count badge
      // on the Tasks tab is enough signal).
    }
    setLastSeenProposed(proposedCount);
  }, [proposedCount, lastSeenProposed, tab]);

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <TopBar />
      <MobileTabBar tab={tab} onTabChange={onTabChange} proposedCount={proposedCount} />
      <div className="flex-1 overflow-hidden">
        {tab === "chat" ? <CEOChat /> : <ActionPipeline />}
      </div>
    </div>
  );
}

function MobileTabBar({
  tab,
  onTabChange,
  proposedCount,
}: {
  tab: MobileTab;
  onTabChange: (t: MobileTab) => void;
  proposedCount: number;
}) {
  const tabClass = (active: boolean) =>
    `flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium border-b-2 transition-colors ${
      active
        ? "border-foreground text-foreground"
        : "border-transparent text-muted-foreground hover:text-foreground/70"
    }`;

  return (
    <div className="flex border-b border-border bg-background">
      <button onClick={() => onTabChange("chat")} className={tabClass(tab === "chat")}>
        <MessageSquare size={14} />
        Chat
      </button>
      <button onClick={() => onTabChange("tasks")} className={tabClass(tab === "tasks")}>
        <ListTodo size={14} />
        Tasks
        {proposedCount > 0 && (
          <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] text-[10px] font-mono px-1 rounded-full bg-violet-500 text-white">
            {proposedCount}
          </span>
        )}
      </button>
    </div>
  );
}

export default Index;
