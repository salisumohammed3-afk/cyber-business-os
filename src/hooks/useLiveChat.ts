import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/integrations/supabase/client'
import type { RealtimeChannel } from '@supabase/supabase-js'
import type { Database } from '@/integrations/supabase/types'

type ChatMessageRow = Database['public']['Tables']['chat_messages']['Row']

function convStorageKey(companyId: string) {
  return `sal-os-conv-${companyId}`
}

export function useLiveChat(companyId: string | null) {
  const [messages, setMessages] = useState<ChatMessageRow[]>([])
  const [conversationIdState, setConversationIdState] = useState<string | null>(() => {
    if (!companyId) return null
    try { return localStorage.getItem(convStorageKey(companyId)) } catch { return null }
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [waitingForReply, setWaitingForReply] = useState(false)
  const convIdRef = useRef<string | null>(conversationIdState)
  convIdRef.current = conversationIdState

  // When companyId changes, load the stored conversation for that company
  useEffect(() => {
    if (!companyId) {
      setConversationIdState(null)
      setMessages([])
      setLoading(false)
      return
    }
    try {
      const stored = localStorage.getItem(convStorageKey(companyId))
      setConversationIdState(stored)
      convIdRef.current = stored
    } catch {
      setConversationIdState(null)
    }
    setMessages([])
    setWaitingForReply(false)
  }, [companyId])

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

  useEffect(() => {
    if (!conversationIdState) {
      setMessages([])
      setLoading(false)
      return
    }
    setLoading(true)
    fetchMessages(conversationIdState).finally(() => setLoading(false))
  }, [conversationIdState, fetchMessages])

  useEffect(() => {
    if (!conversationIdState || !waitingForReply) return
    const interval = setInterval(() => {
      fetchMessages(conversationIdState)
    }, 2000)
    return () => clearInterval(interval)
  }, [conversationIdState, waitingForReply, fetchMessages])

  useEffect(() => {
    if (!conversationIdState) return

    const channel: RealtimeChannel = supabase
      .channel(`chat_messages:${conversationIdState}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_messages',
          filter: `conversation_id=eq.${conversationIdState}`,
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
  }, [conversationIdState])

  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      if (!companyId) throw new Error('No company selected')

      let convId = convIdRef.current

      if (!convId) {
        const { data: newConv, error: convError } = await supabase
          .from('conversations')
          .insert({ title: 'New conversation', company_id: companyId })
          .select('id')
          .single()

        if (convError || !newConv?.id) {
          throw new Error(convError?.message ?? 'Failed to create conversation')
        }
        convId = newConv.id
        setConversationIdState(convId)
        convIdRef.current = convId
        try { localStorage.setItem(convStorageKey(companyId), convId) } catch { /* noop */ }
      }

      const msgId = crypto.randomUUID()
      const ts = new Date().toISOString()

      const optimisticMsg: ChatMessageRow = {
        id: msgId,
        conversation_id: convId,
        role: 'user',
        content: text,
        timestamp: ts,
        created_at: ts,
        tool_calls: null,
        metadata: null,
      }
      setMessages((prev) => [...prev, optimisticMsg])
      setWaitingForReply(true)

      const { error: msgError } = await supabase.from('chat_messages').insert({
        id: msgId,
        conversation_id: convId,
        role: 'user',
        content: text,
        timestamp: ts,
      })
      if (msgError) throw new Error(msgError.message)

      // Fast path: call quick-reply (Haiku) for instant answers.
      // If delegation is needed, the endpoint creates the task for us.
      try {
        const qr = await fetch('/api/quick-reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: convId,
            company_id: companyId,
            message: text,
          }),
        })

        if (qr.ok) {
          const result = await qr.json()
          if (result.mode === 'direct') {
            // Reply already written to chat_messages — realtime will deliver it
            return
          }
          // mode === 'delegated': ack message + task already created by the endpoint
          // Keep waitingForReply true so the UI shows the spinner until the
          // delegated task's completion notification arrives
          return
        }
      } catch (qrError) {
        console.error('Quick-reply failed, falling back to full pipeline:', qrError)
      }

      // Fallback: full task pipeline (only reached if quick-reply fails)
      const { data: orchestrator } = await supabase
        .from('agent_definitions')
        .select('id')
        .eq('slug', 'orchestrator')
        .eq('company_id', companyId)
        .single()

      if (!orchestrator?.id) {
        console.error('Orchestrator agent not found — cannot send message')
        return
      }

      const { data: existingTask } = await supabase
        .from('tasks')
        .select('id, status')
        .eq('conversation_id', convId)
        .in('status', ['pending', 'running'])
        .eq('title', 'Respond to user message')
        .limit(1)
        .maybeSingle()

      if (existingTask) return

      const { data: newTask, error: taskError } = await supabase.from('tasks').insert({
        conversation_id: convId,
        agent_definition_id: orchestrator.id,
        company_id: companyId,
        status: 'pending',
        title: 'Respond to user message',
        description: text,
        source: 'internal',
      }).select('id').single()
      if (taskError) throw new Error(taskError.message)

      fetch('/api/run-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: newTask.id, conversation_id: convId }),
      }).catch((fnError) => {
        console.error('Agent runner error:', fnError)
      })
    },
    [companyId]
  )

  return {
    messages,
    conversationId: conversationIdState,
    loading,
    error,
    sendMessage,
  }
}
