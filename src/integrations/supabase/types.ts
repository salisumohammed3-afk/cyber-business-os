export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type TaskStatus =
  | 'proposed'
  | 'running'
  | 'completed'
  | 'queued'
  | 'failed'
  | 'pending'
  | 'cancelled'

export type GoalStatus = 'active' | 'achieved' | 'paused' | 'abandoned'

export type BusinessStage = 'idea' | 'building' | 'pre-revenue' | 'early-revenue' | 'scaling' | 'established'

export interface CompanyBrief {
  what_we_do?: string
  stage?: BusinessStage
  target_customers?: string
  key_products?: Array<{ name: string; description: string }>
  team?: Array<{ name: string; role: string }>
  tone_of_voice?: string
  context_notes?: string
}

export interface Database {
  public: {
    Tables: {
      companies: {
        Row: {
          id: string
          owner_id: string
          name: string
          slug: string
          brief: CompanyBrief
          is_active: boolean
          created_at: string
        }
        Insert: {
          id?: string
          owner_id?: string
          name: string
          slug: string
          brief?: Json
          is_active?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          owner_id?: string
          name?: string
          slug?: string
          brief?: Json
          is_active?: boolean
          created_at?: string
        }
      }
      company_goals: {
        Row: {
          id: string
          company_id: string
          title: string
          description: string | null
          target_metric: string | null
          target_value: number | null
          current_value: number
          timeframe: string | null
          status: GoalStatus
          priority: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          company_id: string
          title: string
          description?: string | null
          target_metric?: string | null
          target_value?: number | null
          current_value?: number
          timeframe?: string | null
          status?: GoalStatus
          priority?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          title?: string
          description?: string | null
          target_metric?: string | null
          target_value?: number | null
          current_value?: number
          timeframe?: string | null
          status?: GoalStatus
          priority?: number
          created_at?: string
          updated_at?: string
        }
      }
      base_agent_definitions: {
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
          default_tools: Json
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
          default_tools?: Json
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
          default_tools?: Json
          created_at?: string
          updated_at?: string
        }
      }
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
          company_id: string | null
          title: string | null
          metadata: Json | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id?: string | null
          company_id?: string | null
          title?: string | null
          metadata?: Json | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string | null
          company_id?: string | null
          title?: string | null
          metadata?: Json | null
          created_at?: string
          updated_at?: string
        }
      }
      agent_definitions: {
        Row: {
          id: string
          company_id: string
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
          company_id: string
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
          company_id?: string
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
          connection_source: string
          composio_action_id: string | null
          tool_schema: Json | null
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
          connection_source?: string
          composio_action_id?: string | null
          tool_schema?: Json | null
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
          connection_source?: string
          composio_action_id?: string | null
          tool_schema?: Json | null
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
          company_id: string | null
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
          tags: Json
          is_recurring: boolean
          recurrence_schedule: string | null
          source: string | null
        }
        Insert: {
          id?: string
          company_id?: string | null
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
          tags?: Json
          is_recurring?: boolean
          recurrence_schedule?: string | null
          source?: string | null
        }
        Update: {
          id?: string
          company_id?: string | null
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
          tags?: Json
          is_recurring?: boolean
          recurrence_schedule?: string | null
          source?: string | null
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
          company_id: string | null
          agent_definition_id: string | null
          category: string | null
          content: string | null
          metadata: Json | null
          importance: number
          expires_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id?: string
          company_id?: string | null
          agent_definition_id?: string | null
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
          company_id?: string | null
          agent_definition_id?: string | null
          category?: string | null
          content?: string | null
          metadata?: Json | null
          importance?: number
          expires_at?: string | null
          created_at?: string
        }
      }
      training_examples: {
        Row: {
          id: string
          agent_definition_id: string | null
          user_message: string
          assistant_response: string
          quality_score: number
          tags: Json
          is_active: boolean
          created_at: string
        }
        Insert: {
          id?: string
          agent_definition_id?: string | null
          user_message: string
          assistant_response: string
          quality_score?: number
          tags?: Json
          is_active?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          agent_definition_id?: string | null
          user_message?: string
          assistant_response?: string
          quality_score?: number
          tags?: Json
          is_active?: boolean
          created_at?: string
        }
      }
      knowledge_chunks: {
        Row: {
          id: string
          source_name: string
          source_type: string
          chunk_index: number
          content: string
          metadata: Json
          agent_definition_id: string | null
          created_at: string
        }
        Insert: {
          id?: string
          source_name: string
          source_type?: string
          chunk_index?: number
          content: string
          metadata?: Json
          agent_definition_id?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          source_name?: string
          source_type?: string
          chunk_index?: number
          content?: string
          metadata?: Json
          agent_definition_id?: string | null
          created_at?: string
        }
      }
    }
    Enums: {
      task_status: TaskStatus
      goal_status: GoalStatus
    }
  }
}
