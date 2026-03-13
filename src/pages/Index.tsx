import TopBar from "@/components/TopBar";
import AgentSidebar from "@/components/AgentSidebar";
import ActionPipeline from "@/components/ActionPipeline";
import CEOChat from "@/components/CEOChat";
import BottomTerminal from "@/components/BottomTerminal";
import LiveTerminal from "@/components/LiveTerminal";

const Index = () => {
  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <LiveTerminal />
      <TopBar />
      <div className="flex-1 flex overflow-hidden">
        <AgentSidebar />
        <ActionPipeline />
        <CEOChat />
      </div>
      <BottomTerminal />
    </div>
  );
};

export default Index;
