import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/integrations/supabase/client'
import type { RealtimeChannel } from '@supabase/supabase-js'
import type { Database } from '@/integrations/supabase/types'

type ChatMessageRow = Database['public']['Tables']['chat_messages']['Row']

export function useLiveChat(conversationId: string | null) {
  const [messages, setMessages] = useState<ChatMessageRow[]>([])
  const [conversationIdState, setConversationIdState] = useState<string | null>(conversationId)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [waitingForReply, setWaitingForReply] = useState(false)
  const effectiveConversationId = conversationId ?? conversationIdState
  const convIdRef = useRef<string | null>(effectiveConversationId)
  convIdRef.current = effectiveConversationId

  const fetchMessages = useCallback(async (convId: string) => {
    const { data } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true })
    if (data) {
      setMessages(data as ChatMessageRow[])
      const hasAssistantReply = data.some((m: { role: string }) => m.role !== 'user')
      if (hasAssistantReply && data[data.length - 1]?.role !== 'user') {
        setWaitingForReply(false)
      }
    }
  }, [])

  // Fetch messages when conversation changes
  useEffect(() => {
    if (!effectiveConversationId) {
      setMessages([])
      setLoading(false)
      return
    }
    setLoading(true)
    fetchMessages(effectiveConversationId).finally(() => setLoading(false))
  }, [effectiveConversationId, fetchMessages])

  // Poll for new messages while waiting for a reply
  useEffect(() => {
    if (!effectiveConversationId || !waitingForReply) return
    const interval = setInterval(() => {
      fetchMessages(effectiveConversationId)
    }, 2000)
    return () => clearInterval(interval)
  }, [effectiveConversationId, waitingForReply, fetchMessages])

  // Realtime subscription as primary update mechanism
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
          if (row.role !== 'user') {
            setWaitingForReply(false)
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [effectiveConversationId])

  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      let convId = convIdRef.current

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
        convIdRef.current = convId
      }

      // Optimistically add user message to UI
      const optimisticMsg: ChatMessageRow = {
        id: crypto.randomUUID(),
        conversation_id: convId,
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
        created_at: new Date().toISOString(),
        tool_calls: null,
        metadata: null,
      }
      setMessages((prev) => [...prev, optimisticMsg])
      setWaitingForReply(true)

      // Insert into DB
      const { error: msgError } = await supabase.from('chat_messages').insert({
        conversation_id: convId,
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
      })
      if (msgError) throw new Error(msgError.message)

      // Look up orchestrator
      const { data: orchestrator, error: agentError } = await supabase
        .from('agent_definitions')
        .select('id')
        .eq('slug', 'orchestrator')
        .single()
      if (agentError || !orchestrator?.id) {
        throw new Error(agentError?.message ?? 'Orchestrator agent not found')
      }

      // Create task
      const { data: newTask, error: taskError } = await supabase.from('tasks').insert({
        conversation_id: convId,
        agent_definition_id: orchestrator.id,
        status: 'pending',
        title: 'Respond to user message',
        description: text,
        source: 'internal',
      }).select('id').single()
      if (taskError) throw new Error(taskError.message)

      // Fire-and-forget: polling + realtime will pick up the response
      fetch('/api/run-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: newTask.id, conversation_id: convId }),
      }).catch((fnError) => {
        console.error('Agent runner error:', fnError)
      })
    },
    []
  )

  return {
    messages,
    conversationId: effectiveConversationId,
    loading,
    error,
    sendMessage,
  }
}
