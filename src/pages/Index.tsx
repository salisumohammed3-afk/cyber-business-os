import TopBar from "@/components/TopBar";
import AgentSidebar from "@/components/AgentSidebar";
import ActionPipeline from "@/components/ActionPipeline";
import CEOChat from "@/components/CEOChat";
import BottomTerminal from "@/components/BottomTerminal";
import LiveTerminal from "@/components/LiveTerminal";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { useIsMobile } from "@/hooks/use-mobile";

const Index = () => {
  const isMobile = useIsMobile();

  // Mobile: chat-only. The chat carries everything that matters on a phone —
  // proposals, approvals, status cards, integrations, schedules. Sidebars +
  // pipeline + terminals are desktop affordances.
  if (isMobile) {
    return (
      <div className="h-screen flex flex-col bg-background overflow-hidden">
        <TopBar />
        <div className="flex-1 overflow-hidden">
          <CEOChat />
        </div>
      </div>
    );
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

export default Index;
