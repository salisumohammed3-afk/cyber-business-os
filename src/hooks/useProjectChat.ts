import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type ChatMessageRow = Database["public"]["Tables"]["chat_messages"]["Row"];

interface Project {
  id: string;
  company_id: string;
  name: string;
  description: string | null;
  repo_url: string | null;
  deploy_url: string | null;
  branch: string;
  status: string;
  edit_conversation_id: string | null;
}

interface ActiveTask {
  id: string;
  status: string;
  title: string | null;
}

export function useProjectChat(projectId: string | undefined) {
  const [project, setProject] = useState<Project | null>(null);
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [activeTask, setActiveTask] = useState<ActiveTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const convIdRef = useRef<string | null>(null);

  // Load project
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    supabase
      .from("projects")
      .select("id, company_id, name, description, repo_url, deploy_url, branch, status, edit_conversation_id")
      .eq("id", projectId)
      .single()
      .then(({ data }) => {
        if (data) {
          setProject(data as Project);
          convIdRef.current = data.edit_conversation_id as string | null;
        }
        setLoading(false);
      });
  }, [projectId]);

  // Load messages when conversation exists
  const fetchMessages = useCallback(async (convId: string) => {
    const { data } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true });
    if (data) setMessages(data as ChatMessageRow[]);
  }, []);

  useEffect(() => {
    const convId = project?.edit_conversation_id;
    if (!convId) {
      setMessages([]);
      return;
    }
    fetchMessages(convId);
  }, [project?.edit_conversation_id, fetchMessages]);

  // Real-time subscription
  useEffect(() => {
    const convId = project?.edit_conversation_id;
    if (!convId) return;

    const channel: RealtimeChannel = supabase
      .channel(`project_chat:${convId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_messages",
          filter: `conversation_id=eq.${convId}`,
        },
        (payload) => {
          const row = payload.new as ChatMessageRow;
          setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [project?.edit_conversation_id]);

  // Poll for active tasks on this project's conversation
  useEffect(() => {
    const convId = project?.edit_conversation_id;
    if (!convId) return;

    let cancelled = false;
    const poll = async () => {
      const { data } = await supabase
        .from("tasks")
        .select("id, status, title")
        .eq("conversation_id", convId)
        .in("status", ["pending", "running"])
        .order("created_at", { ascending: false })
        .limit(1);

      if (!cancelled) {
        const task = data?.[0] as ActiveTask | undefined;
        setActiveTask(task || null);

        if (task) {
          // Refresh messages while task is active
          fetchMessages(convId);
        }
      }
    };

    poll();
    const interval = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [project?.edit_conversation_id, fetchMessages]);

  const sendFeedback = useCallback(
    async (message: string) => {
      if (!project?.id || !message.trim()) return;
      setSending(true);

      // Optimistic user message
      const optimistic: ChatMessageRow = {
        id: crypto.randomUUID(),
        conversation_id: convIdRef.current || "",
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
        created_at: new Date().toISOString(),
        tool_calls: null,
        metadata: null,
      };
      setMessages((prev) => [...prev, optimistic]);

      try {
        const res = await fetch("/api/project-feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project_id: project.id, message }),
        });
        const json = await res.json();

        if (json.conversation_id && json.conversation_id !== convIdRef.current) {
          convIdRef.current = json.conversation_id;
          setProject((prev) =>
            prev ? { ...prev, edit_conversation_id: json.conversation_id } : prev
          );
        }

        if (json.task_id) {
          setActiveTask({ id: json.task_id, status: "pending", title: `Edit: ${message.slice(0, 60)}` });
        }
      } catch (err) {
        console.error("Failed to send feedback:", err);
      } finally {
        setSending(false);
      }
    },
    [project?.id]
  );

  return {
    project,
    messages,
    activeTask,
    loading,
    sending,
    sendFeedback,
  };
}
