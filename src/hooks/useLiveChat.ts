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

// Resolve the canonical conversation for this company by looking at the SERVER,
// not localStorage. Otherwise mobile and desktop end up with different
// conversation IDs (each device's localStorage is independent) and the
// orchestrator can't see across them. Strategy:
//   1. Pick the conversation with the most-recent chat_message for this company
//      (i.e. the thread with actual ongoing activity).
//   2. If multiple conversations exist with messages, that's a sign of past
//      device drift — the FE will pick the most-active one and writes will
//      converge there. The data layer can be merged separately.
//   3. If no conversation exists at all, return null and let the existing
//      first-message path create one.
async function resolveCanonicalConversation(companyId: string): Promise<string | null> {
  // Step 1: find every conversation for this company.
  const { data: convs } = await supabase
    .from('conversations')
    .select('id')
    .eq('company_id', companyId)
  if (!convs || convs.length === 0) return null
  if (convs.length === 1) return convs[0].id

  // Step 2: pick the one with the latest chat_message. We can't easily group-by
  // on a join in supabase-js, so fetch the most-recent message per conv-id list
  // in one shot and bucket client-side.
  const ids = convs.map(c => c.id)
  const { data: latest } = await supabase
    .from('chat_messages')
    .select('conversation_id, created_at')
    .in('conversation_id', ids)
    .order('created_at', { ascending: false })
    .limit(1)
  if (latest && latest.length > 0 && latest[0].conversation_id) {
    return latest[0].conversation_id
  }
  // Fallback: no messages yet in any conv, return the first one.
  return convs[0].id
}

export function useLiveChat(companyId: string | null) {
  const [messages, setMessages] = useState<ChatMessageRow[]>([])
  // Start with localStorage as a fast hint to avoid an empty-flash on load,
  // then immediately validate against the server in the effect below. If the
  // server says a different conversation is canonical, we switch.
  const [conversationIdState, setConversationIdState] = useState<string | null>(() => {
    if (!companyId) return null
    try { return localStorage.getItem(convStorageKey(companyId)) } catch { return null }
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [waitingForReply, setWaitingForReply] = useState(false)
  const convIdRef = useRef<string | null>(conversationIdState)
  convIdRef.current = conversationIdState
  const lastRealtimeRef = useRef<number>(0)
  // Holds the current in-flight quick-reply fetch's abort controller so the
  // user can hit STOP THINKING to kill the call from the client side.
  const inFlightRef = useRef<AbortController | null>(null)

  // When companyId changes, resolve the canonical conversation from the SERVER.
  // localStorage is a hint, never the source of truth — that's what caused the
  // mobile/desktop fork.
  useEffect(() => {
    if (!companyId) {
      setConversationIdState(null)
      setMessages([])
      setLoading(false)
      return
    }
    setMessages([])
    setWaitingForReply(false)
    let cancelled = false
    void (async () => {
      const canonical = await resolveCanonicalConversation(companyId)
      if (cancelled) return
      setConversationIdState(canonical)
      convIdRef.current = canonical
      // Sync localStorage so subsequent writes use the same conv id.
      try {
        if (canonical) localStorage.setItem(convStorageKey(companyId), canonical)
        else localStorage.removeItem(convStorageKey(companyId))
      } catch {
        /* ignore */
      }
    })()
    return () => { cancelled = true }
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
      // Skip polling if Realtime delivered a message within the last 10 seconds
      if (Date.now() - lastRealtimeRef.current < 10_000) return
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
          lastRealtimeRef.current = Date.now()
          setMessages((prev) =>
            prev.some((m) => m.id === row.id) ? prev : [...prev, row]
          )
          // Only clear "thinking" on the FINAL reply. Intermediate events
          // (work_order_proposal, status, etc.) used to also clear it, which
          // hid the STOP THINKING button while the function was still running.
          if (row.role !== 'user' && row.kind === 'reply') {
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
        kind: 'user_msg',
        content: text,
        timestamp: ts,
        metadata: msgMeta,
      })
      if (msgError) throw new Error(msgError.message)

      const attachmentContext = attachments.length > 0
        ? '\n\n[Attachments: ' + attachments.map((a) => `${a.name} (${a.type}) — ${a.url}`).join(', ') + ']'
        : ''

      // Chat is chat. No fallback path. If quick-reply fails, the user sees a real error
      // in the conversation (quick-reply persists an error message on its end).
      // We do NOT silently spawn a task — that's how runaways start.
      // AbortController lets the user hit STOP THINKING to kill the in-flight call.
      const ac = new AbortController()
      inFlightRef.current = ac
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
          signal: ac.signal,
        })

        if (!qr.ok) {
          const body = await qr.json().catch(() => ({ error: qr.statusText }))
          const errMsg = typeof body?.error === 'string' ? body.error : qr.statusText
          // quick-reply tries to persist its own error message; if it can't, we surface here.
          setError(new Error(`Chat error (${qr.status}): ${errMsg}`))
          setWaitingForReply(false)
        }
      } catch (qrError) {
        const m = qrError instanceof Error ? qrError.message : String(qrError)
        // AbortError is the user clicking STOP THINKING — clear UI silently.
        if (qrError instanceof DOMException && qrError.name === 'AbortError') {
          setWaitingForReply(false)
        } else {
          console.error('Quick-reply network error:', m)
          setError(new Error(`Network error reaching chat: ${m}`))
          setWaitingForReply(false)
        }
      } finally {
        if (inFlightRef.current === ac) inFlightRef.current = null
      }
    },
    [companyId]
  )

  // Abort the in-flight quick-reply call. Doesn't stop the server-side LLM call
  // mid-flight (Vercel doesn't surface that), but it frees the UI immediately
  // and the function self-terminates when its 60s budget hits or it returns.
  const stopThinking = useCallback(() => {
    if (inFlightRef.current) {
      inFlightRef.current.abort()
      inFlightRef.current = null
    }
    setWaitingForReply(false)
  }, [])

  const clearConversation = useCallback(() => {
    if (!companyId) return
    try { localStorage.removeItem(convStorageKey(companyId)) } catch {}
    setConversationIdState(null)
    convIdRef.current = null
    setMessages([])
    setWaitingForReply(false)
  }, [companyId])

  return {
    messages,
    conversationId: conversationIdState,
    loading,
    error,
    waitingForReply,
    sendMessage,
    stopThinking,
    clearConversation,
  }
}
