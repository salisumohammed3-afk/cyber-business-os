import { useState, useRef, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Send,
  RefreshCw,
  ExternalLink,
  GitBranch,
  Loader2,
  Bot,
  User,
  Globe,
  Pencil,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useProjectChat } from "@/hooks/useProjectChat";
import ReactMarkdown from "react-markdown";

export default function ProjectEditor() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { project, messages, activeTask, loading, sending, sendFeedback } =
    useProjectChat(projectId);

  const [input, setInput] = useState("");
  const [iframeKey, setIframeKey] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevTaskRef = useRef<string | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Auto-refresh iframe when a task completes
  useEffect(() => {
    if (activeTask) {
      prevTaskRef.current = activeTask.id;
    } else if (prevTaskRef.current) {
      setIframeKey((k) => k + 1);
      prevTaskRef.current = null;
    }
  }, [activeTask]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    await sendFeedback(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <Loader2 className="animate-spin text-muted-foreground" size={24} />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-background gap-3">
        <p className="text-sm text-muted-foreground">Project not found</p>
        <button
          onClick={() => navigate("/outputs")}
          className="text-xs text-violet-400 hover:text-violet-300"
        >
          Back to Outputs
        </button>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Top bar */}
      <div className="h-11 border-b flex items-center px-3 gap-2 shrink-0">
        <button
          onClick={() => navigate("/outputs")}
          className="p-1 rounded hover:bg-secondary text-muted-foreground"
        >
          <ArrowLeft size={16} />
        </button>
        <Pencil size={13} className="text-violet-400" />
        <span className="text-sm font-medium truncate">{project.name}</span>
        <Badge
          variant="secondary"
          className="text-[9px] shrink-0"
        >
          {project.status}
        </Badge>
        {project.repo_url && (
          <a
            href={project.repo_url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground ml-2"
          >
            <GitBranch size={10} /> repo
          </a>
        )}
        {project.deploy_url && (
          <a
            href={project.deploy_url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            <Globe size={10} /> live
          </a>
        )}
      </div>

      {/* Split pane */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Chat panel */}
        <div className="w-[38%] min-w-[320px] max-w-[500px] border-r flex flex-col">
          {/* Chat header */}
          <div className="px-4 py-2.5 border-b flex items-center gap-2">
            <Bot size={13} className="text-violet-400" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Project Feedback
            </span>
            {activeTask && (
              <div className="ml-auto flex items-center gap-1.5">
                <Loader2 size={10} className="animate-spin text-amber-500" />
                <span className="text-[10px] text-amber-500 font-medium">
                  {activeTask.status === "running" ? "Working..." : "Queued"}
                </span>
              </div>
            )}
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center gap-2">
                <Pencil size={24} className="text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">
                  Type feedback to modify this project.
                </p>
                <p className="text-[10px] text-muted-foreground/60 max-w-[240px]">
                  The engineering agent will read the existing code, make your changes, and push them live.
                </p>
              </div>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-2.5 ${msg.role === "user" ? "" : ""}`}
              >
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                    msg.role === "user"
                      ? "bg-foreground/10"
                      : "bg-violet-500/10"
                  }`}
                >
                  {msg.role === "user" ? (
                    <User size={12} className="text-foreground/60" />
                  ) : (
                    <Bot size={12} className="text-violet-400" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-[10px] text-muted-foreground block mb-0.5">
                    {msg.role === "user" ? "You" : "Engineering Agent"}
                  </span>
                  <div className="text-xs leading-relaxed prose prose-sm prose-gray max-w-none [&_p]:my-1 [&_ul]:my-1 [&_li]:my-0.5 [&_pre]:text-[10px] [&_code]:text-[10px]">
                    <ReactMarkdown>{msg.content || ""}</ReactMarkdown>
                  </div>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="p-3 border-t">
            <div className="flex gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Describe the changes you want..."
                rows={2}
                className="flex-1 px-3 py-2 text-xs bg-secondary border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-violet-500/50"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || sending}
                className="self-end px-3 py-2 rounded-md bg-violet-600 text-white hover:bg-violet-500 transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {sending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Send size={14} />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Right: Preview panel */}
        <div className="flex-1 flex flex-col bg-secondary/30">
          {/* Preview header */}
          <div className="px-4 py-2 border-b flex items-center gap-2 bg-background">
            <Globe size={13} className="text-blue-500" />
            <span className="text-[10px] text-muted-foreground font-mono truncate flex-1">
              {project.deploy_url || "No deploy URL"}
            </span>
            <button
              onClick={() => setIframeKey((k) => k + 1)}
              className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
              title="Refresh preview"
            >
              <RefreshCw size={12} />
            </button>
            {project.deploy_url && (
              <a
                href={project.deploy_url}
                target="_blank"
                rel="noreferrer"
                className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                title="Open in new tab"
              >
                <ExternalLink size={12} />
              </a>
            )}
          </div>

          {/* Iframe */}
          {project.deploy_url ? (
            <iframe
              key={iframeKey}
              src={`${project.deploy_url}${project.deploy_url.includes("?") ? "&" : "?"}t=${iframeKey}`}
              className="flex-1 w-full border-0"
              title={`Preview: ${project.name}`}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-2">
                <Globe size={32} className="mx-auto text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">
                  No deploy URL available
                </p>
                <p className="text-[10px] text-muted-foreground/60">
                  The preview will appear once the project is deployed.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
