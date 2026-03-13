import { useState } from "react";
import { chatMessages, type ChatMessage } from "@/data/mockData";
import { Send, Bot, User } from "lucide-react";

const CEOChat = () => {
  const [messages, setMessages] = useState<ChatMessage[]>(chatMessages);
  const [input, setInput] = useState("");

  const handleSend = () => {
    if (!input.trim()) return;
    const newMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: "user",
      content: input,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };
    setMessages((prev) => [...prev, newMsg]);
    setInput("");

    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          id: `msg-${Date.now()}-resp`,
          role: "orchestrator",
          content: "Acknowledged. Routing your directive to the relevant agents. I'll update you when execution begins.",
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    }, 1200);
  };

  return (
    <div className="w-80 border-l border-border bg-background flex flex-col h-full">
      <div className="p-3 border-b border-border">
        <span className="font-mono text-[10px] text-muted-foreground tracking-widest uppercase">
          CEO Strategy Layer
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-2 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
            <div className={`w-5 h-5 rounded-sm flex items-center justify-center flex-shrink-0 mt-0.5 ${
              msg.role === "user" ? "bg-primary" : "bg-secondary"
            }`}>
              {msg.role === "user" ? (
                <User size={10} className="text-primary-foreground" />
              ) : (
                <Bot size={10} className="text-muted-foreground" />
              )}
            </div>
            <div className={`flex-1 min-w-0 ${msg.role === "user" ? "text-right" : ""}`}>
              <div className={`inline-block text-left p-2 rounded-sm max-w-full ${
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary border border-border"
              }`}>
                <p className="text-xs whitespace-pre-wrap leading-relaxed">{msg.content}</p>
              </div>
              <p className="text-[9px] font-mono text-muted-foreground mt-1">{msg.timestamp}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="p-3 border-t border-border">
        <div className="flex items-center gap-2 border border-border rounded-sm p-1.5">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Ask Aura anything..."
            className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none px-1"
          />
          <button
            onClick={handleSend}
            className="p-1 rounded-sm hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          >
            <Send size={12} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default CEOChat;
