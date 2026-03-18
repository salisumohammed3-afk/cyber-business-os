import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export type AgentStatus = "active" | "idle" | "thinking";

export interface Agent {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  last_action: string;
  tasks_completed: number;
}

export interface Task {
  id: string;
  title: string;
  agent_id?: string;
  agent_name?: string;
  status: "proposed" | "pending" | "running" | "completed" | "queued" | "failed" | "cancelled";
  progress?: number;
  timestamp?: string;
  reasoning?: string;
  tool_output?: string;
  category?: string;
  description?: string;
  agent_definition_id?: string;
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  error_message?: string;
  tags?: string[];
  is_recurring?: boolean;
  recurrence_schedule?: string | null;
  source?: string | null;
  result?: {
    response?: string;
    tools_used?: string[];
    turns?: number;
    model?: string;
    max_turns_reached?: boolean;
  } | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "orchestrator";
  content: string;
  timestamp: string;
}

export interface Metric {
  label: string;
  value: string;
  change?: string | null;
  positive?: boolean | null;
}

export function useAgents() {
  return useQuery({
    queryKey: ["agents"],
    queryFn: async () => {
      const { data, error } = await supabase.from("agents").select("*").order("name");
      if (error) throw error;
      return data as Agent[];
    },
  });
}

export function useTasks() {
  return useQuery({
    queryKey: ["tasks"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tasks")
        .select("*, agent_definitions(name, slug), task_results(result_type, data)")
        .neq("source", "internal")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []).map((t: Record<string, unknown>) => {
        const agentDef = t.agent_definitions as { name: string; slug: string } | null;
        const results = t.task_results as { result_type: string; data: Record<string, unknown> }[] | null;
        const agentResult = results?.find(r => r.result_type === "agent_response");
        return {
          ...t,
          agent_name: agentDef?.name || (t as Task).agent_name || "Orchestrator",
          result: agentResult?.data as Task["result"] ?? null,
          agent_definitions: undefined,
          task_results: undefined,
        } as Task;
      });
    },
    refetchInterval: 4000,
  });
}

export function useTaskActions() {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["tasks"] });

  const approveTask = useCallback(async (taskId: string) => {
    await supabase.from("tasks").update({ status: "pending" as const }).eq("id", taskId);
    try {
      await fetch("/api/run-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: taskId }),
      });
    } catch (e) {
      console.error("Failed to invoke agent runner:", e);
    }
    invalidate();
  }, []);

  const runTask = useCallback(async (taskId: string) => {
    await supabase.from("tasks").update({ status: "pending" as const }).eq("id", taskId);
    try {
      await fetch("/api/run-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: taskId }),
      });
    } catch (e) {
      console.error("Failed to invoke agent runner:", e);
    }
    invalidate();
  }, []);

  const rejectTask = useCallback(async (taskId: string) => {
    await supabase.from("tasks").update({ status: "cancelled" as const }).eq("id", taskId);
    invalidate();
  }, []);

  const retryTask = useCallback(async (taskId: string) => {
    await supabase.from("tasks").update({ status: "pending" as const, error_message: null, started_at: null, completed_at: null }).eq("id", taskId);
    try {
      await fetch("/api/run-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: taskId }),
      });
    } catch (e) {
      console.error("Failed to invoke agent runner:", e);
    }
    invalidate();
  }, []);

  const deleteTask = useCallback(async (taskId: string) => {
    await supabase.from("tasks").delete().eq("id", taskId);
    invalidate();
  }, []);

  const repeatTask = useCallback(async (task: Task) => {
    await supabase.from("tasks").insert({
      title: task.title,
      description: task.description,
      agent_definition_id: task.agent_definition_id,
      status: "proposed" as const,
      source: task.source || "agent",
      tags: task.tags ? JSON.stringify(task.tags) : "[]",
      is_recurring: task.is_recurring || false,
    });
    invalidate();
  }, []);

  return { approveTask, runTask, rejectTask, retryTask, deleteTask, repeatTask };
}

export function useChatMessages() {
  return useQuery({
    queryKey: ["chat_messages"],
    queryFn: async () => {
      const { data, error } = await supabase.from("chat_messages").select("*").order("created_at");
      if (error) throw error;
      return data as ChatMessage[];
    },
  });
}

export function useMetrics() {
  return useQuery({
    queryKey: ["metrics"],
    queryFn: async () => {
      const { data, error } = await supabase.from("metrics").select("*");
      if (error) throw error;
      return data as Metric[];
    },
  });
}

export function useTerminalLogs() {
  return useQuery({
    queryKey: ["terminal_logs"],
    queryFn: async () => {
      const { data, error } = await supabase.from("terminal_logs").select("*").order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return (data || []).map((row: { message: string }) => row.message);
    },
    refetchInterval: 3000,
  });
}

export function useAgentDefinitions() {
  return useQuery({
    queryKey: ["agent_definitions"],
    queryFn: async () => {
      const { data, error } = await supabase.from("agent_definitions").select("*").order("name");
      if (error) throw error;
      return data;
    },
  });
}

export interface AgentToolRow {
  id: string;
  agent_id: string;
  tool_name: string;
  tool_type: string;
  connection_source: string;
  is_enabled: boolean;
}

export function useAgentTools() {
  return useQuery({
    queryKey: ["agent_tools"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("agent_tools")
        .select("id, agent_id, tool_name, tool_type, connection_source, is_enabled")
        .eq("is_enabled", true);
      if (error) throw error;
      return (data || []) as AgentToolRow[];
    },
  });
}
