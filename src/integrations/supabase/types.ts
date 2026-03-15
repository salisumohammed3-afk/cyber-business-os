export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type TaskStatus =
  | 'running'
  | 'completed'
  | 'queued'
  | 'failed'
  | 'pending'
  | 'cancelled'

export interface Database {
  public: {
    Tables: {
      users: {
        Row: {
          id: string
          name: string | null
          email: string | null
          company_context: Json | null
          created_at: string
        }
        Insert: {
          id: string
          name?: string | null
          email?: string | null
          company_context?: Json | null
          created_at?: string
        }
        Update: {
          id?: string
          name?: string | null
          email?: string | null
          company_context?: Json | null
          created_at?: string
        }
      }
      conversations: {
        Row: {
          id: string
          user_id: string | null
          title: string | null
          metadata: Json | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id?: string | null
          title?: string | null
          metadata?: Json | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string | null
          title?: string | null
          metadata?: Json | null
          created_at?: string
          updated_at?: string
        }
      }
      agent_definitions: {
        Row: {
          id: string
          name: string | null
          slug: string
          description: string | null
          system_prompt: string | null
          model: string | null
          allowed_tools: Json | null
          is_orchestrator: boolean
          max_turns: number
          temperature: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name?: string | null
          slug: string
          description?: string | null
          system_prompt?: string | null
          model?: string | null
          allowed_tools?: Json | null
          is_orchestrator?: boolean
          max_turns?: number
          temperature?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string | null
          slug?: string
          description?: string | null
          system_prompt?: string | null
          model?: string | null
          allowed_tools?: Json | null
          is_orchestrator?: boolean
          max_turns?: number
          temperature?: number
          created_at?: string
          updated_at?: string
        }
      }
      agent_tools: {
        Row: {
          id: string
          agent_id: string
          tool_name: string | null
          tool_type: string | null
          mcp_server_url: string | null
          config: Json | null
          is_enabled: boolean
          created_at: string
        }
        Insert: {
          id?: string
          agent_id: string
          tool_name?: string | null
          tool_type?: string | null
          mcp_server_url?: string | null
          config?: Json | null
          is_enabled?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          agent_id?: string
          tool_name?: string | null
          tool_type?: string | null
          mcp_server_url?: string | null
          config?: Json | null
          is_enabled?: boolean
          created_at?: string
        }
      }
      chat_messages: {
        Row: {
          id: string
          conversation_id: string | null
          role: string
          content: string | null
          timestamp: string | null
          tool_calls: Json | null
          metadata: Json | null
          created_at?: string
        }
        Insert: {
          id?: string
          conversation_id?: string | null
          role: string
          content?: string | null
          timestamp?: string | null
          tool_calls?: Json | null
          metadata?: Json | null
          created_at?: string
        }
        Update: {
          id?: string
          conversation_id?: string | null
          role?: string
          content?: string | null
          timestamp?: string | null
          tool_calls?: Json | null
          metadata?: Json | null
          created_at?: string
        }
      }
      tasks: {
        Row: {
          id: string
          conversation_id: string | null
          agent_definition_id: string | null
          parent_task_id: string | null
          status: TaskStatus
          title: string | null
          description: string | null
          input_data: Json
          priority: number
          error_message: string | null
          retry_count: number
          max_retries: number
          started_at: string | null
          completed_at: string | null
          created_at?: string
        }
        Insert: {
          id?: string
          conversation_id?: string | null
          agent_definition_id?: string | null
          parent_task_id?: string | null
          status?: TaskStatus
          title?: string | null
          description?: string | null
          input_data?: Json
          priority?: number
          error_message?: string | null
          retry_count?: number
          max_retries?: number
          started_at?: string | null
          completed_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          conversation_id?: string | null
          agent_definition_id?: string | null
          parent_task_id?: string | null
          status?: TaskStatus
          title?: string | null
          description?: string | null
          input_data?: Json
          priority?: number
          error_message?: string | null
          retry_count?: number
          max_retries?: number
          started_at?: string | null
          completed_at?: string | null
          created_at?: string
        }
      }
      task_results: {
        Row: {
          id: string
          task_id: string
          result_type: string
          data: Json | null
          created_at: string
        }
        Insert: {
          id?: string
          task_id: string
          result_type: string
          data?: Json | null
          created_at?: string
        }
        Update: {
          id?: string
          task_id?: string
          result_type?: string
          data?: Json | null
          created_at?: string
        }
      }
      memories: {
        Row: {
          id: string
          user_id: string
          category: string | null
          content: string | null
          metadata: Json | null
          importance: number
          expires_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          category?: string | null
          content?: string | null
          metadata?: Json | null
          importance?: number
          expires_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          category?: string | null
          content?: string | null
          metadata?: Json | null
          importance?: number
          expires_at?: string | null
          created_at?: string
        }
      }
    }
    Enums: {
      task_status: TaskStatus
    }
  }
}
