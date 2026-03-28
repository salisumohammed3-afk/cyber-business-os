import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/integrations/supabase/client'
import type { RealtimeChannel } from '@supabase/supabase-js'
import type { Database } from '@/integrations/supabase/types'

type ChatMessageRow = Database['public']['Tables']['chat_messages']['Row']

export interface Attachment {
  name: string
  url: string
  type: string
  size: number
}

const ATTACHMENT_BUCKET = 'chat-attachments'

async function uploadFiles(companyId: string, convId: string, files: File[]): Promise<Attachment[]> {
  const results: Attachment[] = []
  for (const file of files) {
    const ext = file.name.split('.').pop() || 'bin'
    const path = `${companyId}/${convId}/${crypto.randomUUID()}.${ext}`

    const { error } = await supabase.storage
      .from(ATTACHMENT_BUCKET)
      .upload(path, file, { contentType: file.type, upsert: false })

    if (error) {
      console.error('Upload failed for', file.name, error.message)
      continue
    }

    const { data: urlData } = supabase.storage.from(ATTACHMENT_BUCKET).getPublicUrl(path)
    results.push({
      name: file.name,
      url: urlData.publicUrl,
      type: file.type,
      size: file.size,
    })
  }
  return results
}

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
    async (text: string, files?: File[]): Promise<void> => {
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

      let attachments: Attachment[] = []
      if (files && files.length > 0) {
        attachments = await uploadFiles(companyId, convId, files)
      }

      const msgId = crypto.randomUUID()
      const ts = new Date().toISOString()
      const msgMeta = attachments.length > 0 ? { attachments } : null

      const optimisticMsg: ChatMessageRow = {
        id: msgId,
        conversation_id: convId,
        role: 'user',
        content: text,
        timestamp: ts,
        created_at: ts,
        tool_calls: null,
        metadata: msgMeta,
      }
      setMessages((prev) => [...prev, optimisticMsg])
      setWaitingForReply(true)

      const { error: msgError } = await supabase.from('chat_messages').insert({
        id: msgId,
        conversation_id: convId,
        role: 'user',
        content: text,
        timestamp: ts,
        metadata: msgMeta,
      })
      if (msgError) throw new Error(msgError.message)

      const attachmentContext = attachments.length > 0
        ? '\n\n[Attachments: ' + attachments.map((a) => `${a.name} (${a.type}) — ${a.url}`).join(', ') + ']'
        : ''

      try {
        const qr = await fetch('/api/quick-reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: convId,
            company_id: companyId,
            message: text + attachmentContext,
            attachments: attachments.length > 0 ? attachments : undefined,
          }),
        })

        if (qr.ok) {
          return
        }
      } catch (qrError) {
        console.error('Quick-reply failed, falling back to full pipeline:', qrError)
      }

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
        description: text + attachmentContext,
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
