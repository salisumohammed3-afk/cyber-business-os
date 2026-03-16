import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/integrations/supabase/client'
import type { RealtimeChannel } from '@supabase/supabase-js'
import type { Database } from '@/integrations/supabase/types'

type ChatMessageRow = Database['public']['Tables']['chat_messages']['Row']

export function useLiveChat(conversationId: string | null) {
  const [messages, setMessages] = useState<ChatMessageRow[]>([])
  const [conversationIdState, setConversationIdState] = useState<string | null>(conversationId)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const effectiveConversationId = conversationId ?? conversationIdState

  // Fetch initial messages when we have a conversation id
  useEffect(() => {
    if (!effectiveConversationId) {
      setMessages([])
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    supabase
      .from('chat_messages')
      .select('*')
      .eq('conversation_id', effectiveConversationId)
      .order('created_at', { ascending: true })
      .then(({ data, error: err }) => {
        if (cancelled) return
        if (err) {
          setError(err as unknown as Error)
          setMessages([])
        } else {
          setMessages((data as ChatMessageRow[]) ?? [])
        }
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [effectiveConversationId])

  // Realtime: subscribe to INSERT on chat_messages for this conversation
  useEffect(() => {
    if (!effectiveConversationId) return

    const channel: RealtimeChannel = supabase
      .channel(`chat_messages:${effectiveConversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_messages',
          filter: `conversation_id=eq.${effectiveConversationId}`,
        },
        (payload) => {
          const row = payload.new as ChatMessageRow
          setMessages((prev) =>
            prev.some((m) => m.id === row.id) ? prev : [...prev, row]
          )
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [effectiveConversationId])

  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      let convId = effectiveConversationId

      // If no conversation yet, create one on first send
      if (!convId) {
        const { data: newConv, error: convError } = await supabase
          .from('conversations')
          .insert({ title: 'New conversation' })
          .select('id')
          .single()

        if (convError || !newConv?.id) {
          throw new Error(convError?.message ?? 'Failed to create conversation')
        }
        convId = newConv.id
        setConversationIdState(convId)
      }

      // a) Insert user message
      const { error: msgError } = await supabase.from('chat_messages').insert({
        conversation_id: convId,
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
      })
      if (msgError) throw new Error(msgError.message)

      // b) Look up orchestrator agent_definition_id
      const { data: orchestrator, error: agentError } = await supabase
        .from('agent_definitions')
        .select('id')
        .eq('slug', 'orchestrator')
        .single()
      if (agentError || !orchestrator?.id) {
        throw new Error(agentError?.message ?? 'Orchestrator agent not found')
      }

      // c) Insert pending task
      const { data: newTask, error: taskError } = await supabase.from('tasks').insert({
        conversation_id: convId,
        agent_definition_id: orchestrator.id,
        status: 'pending',
        title: 'Respond to user message',
        description: text,
      }).select('id').single()
      if (taskError) throw new Error(taskError.message)

      // d) Invoke the agent runner
      try {
        const resp = await fetch('/api/run-agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task_id: newTask.id, conversation_id: convId }),
        })
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}))
          console.error('Agent runner error:', body)
        }
      } catch (fnError) {
        console.error('Agent runner error:', fnError)
      }
    },
    [effectiveConversationId]
  )

  return {
    messages,
    conversationId: effectiveConversationId,
    loading,
    error,
    sendMessage,
  }
}
