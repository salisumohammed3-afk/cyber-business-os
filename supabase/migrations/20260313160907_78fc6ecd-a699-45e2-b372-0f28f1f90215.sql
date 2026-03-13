-- Create agent_status enum
CREATE TYPE public.agent_status AS ENUM ('active', 'idle', 'thinking');

-- Create task_status enum
CREATE TYPE public.task_status AS ENUM ('running', 'completed', 'queued', 'failed');

-- Create agents table
CREATE TABLE public.agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  status agent_status NOT NULL DEFAULT 'idle',
  last_action TEXT NOT NULL DEFAULT '',
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create tasks table
CREATE TABLE public.tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES public.agents(id),
  agent_name TEXT NOT NULL,
  status task_status NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  timestamp TEXT NOT NULL DEFAULT 'Just now',
  reasoning TEXT NOT NULL DEFAULT '',
  tool_output TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create chat_messages table
CREATE TABLE public.chat_messages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  role TEXT NOT NULL CHECK (role IN ('user', 'orchestrator')),
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create metrics table
CREATE TABLE public.metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  change TEXT,
  positive BOOLEAN,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create terminal_logs table
CREATE TABLE public.terminal_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.terminal_logs ENABLE ROW LEVEL SECURITY;

-- Public read access for all tables (dashboard is public, API keys protect writes)
CREATE POLICY "Public read agents" ON public.agents FOR SELECT USING (true);
CREATE POLICY "Public read tasks" ON public.tasks FOR SELECT USING (true);
CREATE POLICY "Public read chat_messages" ON public.chat_messages FOR SELECT USING (true);
CREATE POLICY "Public read metrics" ON public.metrics FOR SELECT USING (true);
CREATE POLICY "Public read terminal_logs" ON public.terminal_logs FOR SELECT USING (true);

-- Anon/authenticated can insert/update/delete (for API access)
CREATE POLICY "Allow insert agents" ON public.agents FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow update agents" ON public.agents FOR UPDATE USING (true);
CREATE POLICY "Allow delete agents" ON public.agents FOR DELETE USING (true);

CREATE POLICY "Allow insert tasks" ON public.tasks FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow update tasks" ON public.tasks FOR UPDATE USING (true);
CREATE POLICY "Allow delete tasks" ON public.tasks FOR DELETE USING (true);

CREATE POLICY "Allow insert chat_messages" ON public.chat_messages FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow update chat_messages" ON public.chat_messages FOR UPDATE USING (true);
CREATE POLICY "Allow delete chat_messages" ON public.chat_messages FOR DELETE USING (true);

CREATE POLICY "Allow insert metrics" ON public.metrics FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow update metrics" ON public.metrics FOR UPDATE USING (true);
CREATE POLICY "Allow delete metrics" ON public.metrics FOR DELETE USING (true);

CREATE POLICY "Allow insert terminal_logs" ON public.terminal_logs FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow delete terminal_logs" ON public.terminal_logs FOR DELETE USING (true);

-- Timestamp trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Add update triggers
CREATE TRIGGER update_agents_updated_at BEFORE UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_tasks_updated_at BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_metrics_updated_at BEFORE UPDATE ON public.metrics FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Indexes
CREATE INDEX idx_tasks_agent_id ON public.tasks(agent_id);
CREATE INDEX idx_tasks_status ON public.tasks(status);
CREATE INDEX idx_terminal_logs_created ON public.terminal_logs(created_at DESC);