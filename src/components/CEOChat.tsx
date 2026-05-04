import { useRef, useEffect, useState, useMemo, useCallback, type KeyboardEvent, type DragEvent, type ClipboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import { Bot, Pencil, Globe, GitBranch, FileText, Mail, CheckCircle2, Sheet, Paperclip, X, Image as ImageIcon, Loader2, MessageSquarePlus, OctagonX, Play, Clock, DollarSign, Wrench, AlertTriangle, CalendarClock, Repeat } from 'lucide-react'
import { useLiveChat, type Attachment } from '@/hooks/useLiveChat'
import { useCompany } from '@/contexts/CompanyContext'
import { supabase } from '@/integrations/supabase/client'
import { Link } from 'react-router-dom'

interface ProjectRef { id: string; deploy_url: string }

interface IntegrationVendorDef {
  vendor: string
  display_name: string
  description: string
  docs_url: string
  credentials: Array<{
    name: string
    label: string
    description?: string
    placeholder?: string
    is_secret: boolean
    required: boolean
  }>
  config: Array<{
    name: string
    label: string
    description?: string
    default?: string
    required?: boolean
  }>
}

interface ScheduleProposal {
  name: string
  description: string
  cadence_type: string
  cadence_spec: Record<string, unknown>
  cadence_human: string
  next_runs_preview: string[]
  work_order_template: {
    type: string
    agent: string
    title: string
    description: string
    estimated_cost_usd: number
    estimated_minutes: number
    output_target: string
  }
}

interface WorkOrderProposal {
  type: string
  agent: string
  title: string
  description: string
  estimated_cost_usd: number
  estimated_minutes: number
  output_target: string
  preflight: { tool: string; status: 'ready' | 'missing' | 'unknown'; note?: string }[]
}

const WORK_ORDER_TYPE_LABELS: Record<string, string> = {
  research: 'Research',
  build_static_site: 'Build Static Site',
  edit_project: 'Edit Project',
  send_outreach: 'Send Outreach',
  design_mockup: 'Design Mockup',
  meeting_admin: 'Meeting / Admin',
}

interface Deliverable {
  type: string
  label: string
  url?: string
  id?: string
}

interface StagedFile {
  file: File
  previewUrl: string | null
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'])
const MAX_FILES = 5
const MAX_SIZE_MB = 50

const AGENT_LABELS: Record<string, string> = {
  engineering: 'Engineering Agent',
  research: 'Research Agent',
  growth: 'Growth Agent',
  designer: 'Design Agent',
  'executive-assistant': 'Executive Assistant',
}

const DELIVERABLE_ICONS: Record<string, typeof Globe> = {
  project: Globe,
  repo: GitBranch,
  doc: FileText,
  sheet: Sheet,
  email: Mail,
  registered: CheckCircle2,
}

export function CEOChat() {
  const { company } = useCompany()
  const { messages, conversationId, loading, error, waitingForReply, sendMessage, stopThinking, clearConversation } = useLiveChat(company?.id ?? null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [inputValue, setInputValue] = useState('')
  const [sending, setSending] = useState(false)
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(max-width: 640px)')
    const update = () => setIsMobile(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  const autoResize = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
  }, [])
  const [projectRefs, setProjectRefs] = useState<ProjectRef[]>([])

  const addFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files)
    setStagedFiles((prev) => {
      const room = MAX_FILES - prev.length
      const toAdd = arr.slice(0, room).filter((f) => f.size <= MAX_SIZE_MB * 1024 * 1024)
      return [
        ...prev,
        ...toAdd.map((file) => ({
          file,
          previewUrl: IMAGE_TYPES.has(file.type) ? URL.createObjectURL(file) : null,
        })),
      ]
    })
  }, [])

  const removeStaged = useCallback((idx: number) => {
    setStagedFiles((prev) => {
      const copy = [...prev]
      const removed = copy.splice(idx, 1)[0]
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      return copy
    })
  }, [])

  useEffect(() => {
    if (!company?.id) return
    supabase
      .from('projects')
      .select('id, deploy_url')
      .eq('company_id', company.id)
      .not('deploy_url', 'is', null)
      .then(({ data }) => setProjectRefs((data as ProjectRef[]) || []))
  }, [company?.id])

  // Poll for active tasks so the STOP ALL button can appear/disappear in realtime
  const [activeTaskCount, setActiveTaskCount] = useState(0)
  const [stopping, setStopping] = useState(false)
  useEffect(() => {
    if (!company?.id) {
      setActiveTaskCount(0)
      return
    }
    let cancelled = false
    const check = async () => {
      const { count } = await supabase
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id)
        .in('status', ['running', 'pending'])
      if (!cancelled) setActiveTaskCount(count || 0)
    }
    check()
    const interval = setInterval(check, 4000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [company?.id, messages.length])

  // Track which work orders are being approved/cancelled (for spinner state)
  const [pendingActionTaskId, setPendingActionTaskId] = useState<string | null>(null)

  const handleWorkOrderAction = useCallback(
    async (taskId: string, action: 'approve' | 'cancel') => {
      setPendingActionTaskId(taskId)
      try {
        const r = await fetch('/api/approve-work-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task_id: taskId, action }),
        })
        if (!r.ok) {
          const body = await r.json().catch(() => ({ error: r.statusText }))
          alert(
            (action === 'approve' ? 'Approve failed: ' : 'Cancel failed: ') +
              (body.error || r.statusText)
          )
        }
      } catch (err) {
        alert(
          (action === 'approve' ? 'Approve failed: ' : 'Cancel failed: ') +
            (err instanceof Error ? err.message : String(err))
        )
      } finally {
        setPendingActionTaskId(null)
      }
    },
    []
  )

  const handleStopAll = useCallback(async () => {
    if (!company?.id) return
    if (!confirm(`Stop all ${activeTaskCount} running task(s)? This cannot be undone.`)) return
    setStopping(true)
    try {
      const r = await fetch('/api/cancel-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_id: company.id, include_proposed: false }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: 'unknown' }))
        alert('Stop failed: ' + (body.error || r.statusText))
      } else {
        setActiveTaskCount(0)
      }
    } catch (err) {
      alert('Stop failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setStopping(false)
    }
  }, [company?.id, activeTaskCount])

  const projectUrlMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of projectRefs) if (p.deploy_url) m.set(p.deploy_url.replace(/\/$/, ''), p.id)
    return m
  }, [projectRefs])

  const findProjectForUrl = useCallback((href: string) => {
    const clean = href.replace(/\/$/, '')
    if (projectUrlMap.has(clean)) return projectUrlMap.get(clean)!
    for (const [url, id] of projectUrlMap) {
      if (clean.startsWith(url) || url.startsWith(clean)) return id
    }
    return null
  }, [projectUrlMap])

  useEffect(() => {
    scrollContainerRef.current?.scrollTo({
      top: scrollContainerRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = inputValue.trim()
    if ((!text && stagedFiles.length === 0) || sending) return
    setSending(true)
    setInputValue('')
    const filesToSend = stagedFiles.map((s) => s.file)
    stagedFiles.forEach((s) => { if (s.previewUrl) URL.revokeObjectURL(s.previewUrl) })
    setStagedFiles([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    try {
      await sendMessage(text || '(attached files)', filesToSend.length > 0 ? filesToSend : undefined)
    } catch (err) {
      console.error(err)
      setInputValue(text)
    } finally {
      setSending(false)
    }
  }

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
  }, [addFiles])

  const onPaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length) {
      e.preventDefault()
      addFiles(files)
    }
  }, [addFiles])

  // "Waiting for orchestrator response" — true while quick-reply is in-flight.
  // Sourced from the hook (set true on send, false on response/error/abort).
  const isWaitingForResponse = waitingForReply

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b">
        <span className="text-sm font-medium text-gray-600">Chat</span>
        <div className="flex items-center gap-3">
          {isWaitingForResponse && (
            <button
              onClick={stopThinking}
              className="flex items-center gap-1 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded px-2 py-1 transition-colors"
              title="Abort the in-flight chat reply (frees the UI immediately)"
            >
              <OctagonX size={14} />
              STOP THINKING
            </button>
          )}
          {activeTaskCount > 0 && (
            <button
              onClick={handleStopAll}
              disabled={stopping}
              className="flex items-center gap-1 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 disabled:bg-red-400 disabled:cursor-wait rounded px-2 py-1 transition-colors"
              title={`Cancel all ${activeTaskCount} running/pending task(s)`}
            >
              {stopping ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <OctagonX size={14} />
              )}
              STOP ALL ({activeTaskCount})
            </button>
          )}
          <button
            onClick={clearConversation}
            disabled={!company || messages.length === 0}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Start new conversation"
          >
            <MessageSquarePlus size={14} />
            New Chat
          </button>
        </div>
      </div>
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto p-4 space-y-4"
      >
        {loading && (
          <div className="flex justify-center py-4">
            <span className="text-sm text-gray-500">Loading...</span>
          </div>
        )}
        {error && (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error.message}
          </div>
        )}
        {!loading && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
            <Bot size={32} className="mb-2 opacity-50" />
            <p className="text-sm">Chat with your {company?.name || ''} team</p>
            <p className="text-xs mt-1 opacity-70">Messages are scoped to this company</p>
          </div>
        )}
        {!loading &&
          messages.map((msg) => {
            const meta = (msg.metadata && typeof msg.metadata === 'object' && !Array.isArray(msg.metadata))
              ? msg.metadata as Record<string, unknown>
              : null
            // kind: row column wins, fall back to metadata.kind for legacy rows
            const kind: string =
              (msg.kind as string | null | undefined) ||
              (meta?.kind as string | undefined) ||
              (msg.role === 'user' ? 'user_msg' : 'reply')
            const isNotification = kind === 'notification' || meta?.notification === true
            const deliverables = (isNotification && Array.isArray(meta?.deliverables))
              ? meta.deliverables as Deliverable[]
              : []
            const notifAgent = (meta?.agent_slug as string) || ''

            const attachments = (
              meta?.attachments && Array.isArray(meta.attachments)
                ? meta.attachments as Array<{ name: string; url: string; type: string; size: number }>
                : []
            )

            // Render progress messages as subtle status indicators
            if (kind === 'progress' || meta?.progress === true) {
              return (
                <div key={msg.id} className="flex justify-start">
                  <div className="text-xs text-gray-400 italic px-4 py-1 flex items-center gap-1.5">
                    <Loader2 size={10} className="animate-spin" />
                    {msg.content}
                  </div>
                </div>
              )
            }

            // Render kind=integration_problem — auth failure on a connected integration.
            // Shows the vendor + error + a Reconnect button that opens an inline
            // IntegrationProposalCard for the same vendor (re-uses the proposal flow).
            if (kind === 'integration_problem') {
              const vendor = (meta?.vendor as string) || ''
              const displayName = (meta?.display_name as string) || vendor
              const action = (meta?.action as string) || 'a call'
              const origError = (meta?.original_error as string) || ''
              return (
                <div key={msg.id} className="flex justify-start">
                  <IntegrationProblemCard
                    vendor={vendor}
                    displayName={displayName}
                    action={action}
                    originalError={origError}
                    content={msg.content || ''}
                    companyId={company?.id || ''}
                  />
                </div>
              )
            }

            // Render kind=schedule_proposal as a recurring policy approval card.
            // Shows cadence in human terms, next 3 firing times, and the work-order
            // template that will run each time. Approve creates a row in scheduled_tasks.
            if (kind === 'schedule_proposal' && meta?.proposal) {
              return (
                <div key={msg.id} className="flex justify-start">
                  <ScheduleProposalCard
                    proposal={meta.proposal as ScheduleProposal}
                    companyId={company?.id || ''}
                    conversationId={conversationId || ''}
                    preamble={msg.content || undefined}
                  />
                </div>
              )
            }

            // Render kind=integration_proposal as an inline form for adding/updating an integration.
            // Same backend (/api/integrations) as Settings -> API Center; both flows write to the same row.
            if (kind === 'integration_proposal' && meta?.vendor_def) {
              return (
                <div key={msg.id} className="flex justify-start">
                  <IntegrationProposalCard
                    vendorDef={meta.vendor_def as IntegrationVendorDef}
                    existing={(meta.existing as { id: string; status: string; credential_preview: string | null } | null) || null}
                    companyId={company?.id || ''}
                    preamble={msg.content || undefined}
                  />
                </div>
              )
            }

            // Render kind=work_order_proposal as an interactive approval card
            if (kind === 'work_order_proposal' && meta?.proposal) {
              const proposal = meta.proposal as WorkOrderProposal
              const taskId = (meta.task_id as string) || ''
              const typeLabel = WORK_ORDER_TYPE_LABELS[proposal.type] || proposal.type
              const missing = (proposal.preflight || []).filter(p => p.status === 'missing')
              const isPending = pendingActionTaskId === taskId
              return (
                <div key={msg.id} className="flex justify-start">
                  <div className="rounded-md border border-blue-300 bg-blue-50 px-3 py-2 max-w-[85%] text-sm">
                    {msg.content && (
                      <div className="text-foreground/80 whitespace-pre-wrap mb-2">
                        {msg.content}
                      </div>
                    )}
                    <div className="rounded bg-white border border-blue-200 px-3 py-2">
                      <div className="text-xs uppercase tracking-wide font-semibold text-blue-700 mb-1">
                        Work order: {typeLabel}
                      </div>
                      <div className="font-medium mb-1">{proposal.title}</div>
                      <div className="text-xs text-gray-600 mb-2 whitespace-pre-wrap">
                        {proposal.description}
                      </div>
                      <div className="flex flex-wrap gap-3 text-xs text-gray-700 mb-2">
                        <span className="inline-flex items-center gap-1">
                          <Wrench size={11} /> {proposal.agent}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <DollarSign size={11} /> ≤ ${proposal.estimated_cost_usd.toFixed(2)}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Clock size={11} /> ≤ {proposal.estimated_minutes} min
                        </span>
                        <span className="inline-flex items-center gap-1">
                          → {proposal.output_target}
                        </span>
                      </div>
                      {missing.length > 0 && (
                        <div className="mb-2 rounded bg-amber-50 border border-amber-200 px-2 py-1.5 text-xs text-amber-800 flex items-start gap-1.5">
                          <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                          <div>
                            <div>
                              Missing integrations: <b>{missing.map(m => m.tool).join(', ')}</b>. Connect them before approving.
                            </div>
                            <Link
                              to="/company-settings"
                              className="inline-flex items-center gap-1 text-blue-700 hover:underline mt-0.5"
                            >
                              Open API Center →
                            </Link>
                          </div>
                        </div>
                      )}
                      <div className="flex items-center gap-2 mt-2">
                        <button
                          onClick={() => handleWorkOrderAction(taskId, 'approve')}
                          disabled={!taskId || isPending || missing.length > 0}
                          className="inline-flex items-center gap-1 px-3 py-1 text-xs font-semibold rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                        >
                          {isPending ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                          Approve
                        </button>
                        <button
                          onClick={() => handleWorkOrderAction(taskId, 'cancel')}
                          disabled={!taskId || isPending}
                          className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <X size={12} />
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )
            }

            // Render kind=work_order_status (approved / cancelled / completed / failed)
            if (kind === 'work_order_status') {
              const status = (meta.status as string) || 'unknown'
              const cost = typeof meta.cost_usd === 'number' ? meta.cost_usd : null
              const dur = typeof meta.duration_min === 'number' ? meta.duration_min : null
              const woType = (meta.work_order_type as string) || ''
              const typeLabel = WORK_ORDER_TYPE_LABELS[woType] || woType
              const icon =
                status === 'completed' ? '✅' :
                status === 'failed' ? '❌' :
                status === 'cancelled' ? '🚫' :
                status === 'approved' ? '▶' :
                '🔔'
              const deliverables = (Array.isArray(meta.deliverables) ? meta.deliverables : []) as Deliverable[]
              return (
                <div key={msg.id} className="flex justify-start">
                  <div className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 max-w-[85%] text-sm">
                    <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                      <span>{icon}</span>
                      <span className="font-semibold uppercase tracking-wide">{status}</span>
                      {typeLabel && <span>· {typeLabel}</span>}
                      {cost !== null && <span>· ${cost.toFixed(2)}</span>}
                      {dur !== null && <span>· {dur} min</span>}
                    </div>
                    <div className="text-foreground/80 whitespace-pre-wrap">{msg.content}</div>
                    {deliverables.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {deliverables.map((d, i) => (
                          <a
                            key={i}
                            href={d.url || '#'}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-white border border-border hover:bg-gray-50"
                          >
                            <Globe size={11} />
                            {d.label || d.type}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            }

            // Render kind=error messages as a clear, actionable error card with the
            // real diagnostic visible. Replaces the old "Something went wrong" pattern.
            if (kind === 'error' || meta?.error === true) {
              const source = (meta?.source as string) || 'system'
              const original = (meta?.original_error as string) || ''
              return (
                <div key={msg.id} className="flex justify-start">
                  <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 max-w-[90%] text-sm text-red-800">
                    <div className="flex items-center gap-1.5 font-semibold">
                      <X size={14} />
                      <span>Error from {source}</span>
                    </div>
                    <div className="mt-1 whitespace-pre-wrap font-mono text-xs">
                      {msg.content}
                    </div>
                    {original && original !== msg.content && (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-xs opacity-70 hover:opacity-100">
                          Full diagnostic
                        </summary>
                        <pre className="mt-1 text-xs whitespace-pre-wrap bg-red-100 p-2 rounded">
                          {original}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
              )
            }

            // Render notification messages as compact cards
            if ((kind === 'notification' || meta?.notification === true) && meta?.event_type) {
              const eventIcon = meta.event_type === 'task_completed' ? '\u2705'
                : meta.event_type === 'task_failed' ? '\u274C'
                : meta.event_type === 'task_proposed' ? '\uD83D\uDCA1'
                : '\uD83D\uDD14'
              return (
                <div key={msg.id} className="flex justify-start">
                  <div className="text-xs border border-border/50 rounded-md px-3 py-2 max-w-[85%] bg-muted/30">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <span>{eventIcon}</span>
                      <span className="font-medium">{meta.agent_slug ? AGENT_LABELS[meta.agent_slug as string] || meta.agent_slug : 'System'}</span>
                      {meta.duration_min ? <span className="opacity-60">({meta.duration_min}min)</span> : null}
                    </div>
                    <div className="mt-1 text-foreground/80 whitespace-pre-wrap">{msg.content}</div>
                  </div>
                </div>
              )
            }

            if (msg.role === 'user') {
              return (
                <div key={msg.id} className="flex justify-end">
                  <div className="rounded-lg px-4 py-2 max-w-[80%] bg-blue-600 text-white space-y-2">
                    {msg.content && msg.content !== '(attached files)' && (
                      <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                    )}
                    {attachments.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {attachments.map((att, i) =>
                          IMAGE_TYPES.has(att.type) ? (
                            <a key={i} href={att.url} target="_blank" rel="noreferrer">
                              <img
                                src={att.url}
                                alt={att.name}
                                className="w-24 h-24 object-cover rounded border border-blue-400/30 hover:opacity-90 transition-opacity"
                              />
                            </a>
                          ) : (
                            <a
                              key={i}
                              href={att.url}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-1.5 rounded bg-blue-500/40 px-2 py-1 text-xs hover:bg-blue-500/60 transition-colors"
                            >
                              <FileText size={12} />
                              <span className="truncate max-w-[120px]">{att.name}</span>
                            </a>
                          )
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            }

            if (isNotification) {
              return (
                <div key={msg.id} className="flex justify-start">
                  <div className="max-w-[85%] rounded-lg border border-green-200 bg-green-50 overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-2 bg-green-100/60 border-b border-green-200">
                      <CheckCircle2 size={14} className="text-green-600 shrink-0" />
                      <span className="text-xs font-semibold text-green-800">
                        {AGENT_LABELS[notifAgent] || 'Agent'} — Task Complete
                      </span>
                    </div>

                    <div className="px-4 py-3">
                      <div className="prose prose-sm prose-gray max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_code]:text-xs [&_pre]:text-xs [&_hr]:my-2">
                        <ReactMarkdown components={{
                          a: ({ href, children, ...props }) => {
                            const pid = href ? findProjectForUrl(href) : null
                            return (
                              <>
                                <a href={href} target="_blank" rel="noreferrer" className="text-green-700 hover:text-green-900" {...props}>{children}</a>
                                {pid && (
                                  <Link to={`/projects/${pid}/edit`} className="inline-flex items-center gap-0.5 ml-1 text-violet-600 hover:text-violet-500 no-underline text-[10px] font-medium align-middle">
                                    <Pencil size={9} /> edit
                                  </Link>
                                )}
                              </>
                            )
                          }
                        }}>{msg.content ?? ''}</ReactMarkdown>
                      </div>

                      {deliverables.length > 0 && (
                        <div className="mt-3 pt-2 border-t border-green-200 space-y-1.5">
                          {deliverables.map((d, i) => {
                            const Icon = DELIVERABLE_ICONS[d.type] || FileText
                            return (
                              <div key={i} className="flex items-center gap-2 text-sm">
                                <Icon size={13} className="text-green-600 shrink-0" />
                                {d.url ? (
                                  <div className="flex items-center gap-1.5">
                                    <a href={d.url} target="_blank" rel="noreferrer" className="text-green-800 hover:text-green-950 underline underline-offset-2 font-medium">{d.label}</a>
                                    {d.type === 'project' && d.url && (() => {
                                      const pid = findProjectForUrl(d.url)
                                      return pid ? (
                                        <Link to={`/projects/${pid}/edit`} className="inline-flex items-center gap-0.5 text-violet-600 hover:text-violet-500 text-[10px] font-medium">
                                          <Pencil size={9} /> edit
                                        </Link>
                                      ) : null
                                    })()}
                                  </div>
                                ) : (
                                  <span className="text-green-700">{d.label}</span>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            }

            return (
              <div key={msg.id} className="flex justify-start">
                <div className="rounded-lg px-4 py-2 max-w-[80%] bg-gray-200 text-gray-900">
                  <div className="prose prose-sm prose-gray max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_code]:text-xs [&_pre]:text-xs">
                    <ReactMarkdown components={{
                      a: ({ href, children, ...props }) => {
                        const pid = href ? findProjectForUrl(href) : null
                        return (
                          <>
                            <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>
                            {pid && (
                              <Link to={`/projects/${pid}/edit`} className="inline-flex items-center gap-0.5 ml-1 text-violet-600 hover:text-violet-500 no-underline text-[10px] font-medium align-middle">
                                <Pencil size={9} /> edit
                              </Link>
                            )}
                          </>
                        )
                      }
                    }}>{msg.content ?? ''}</ReactMarkdown>
                  </div>
                </div>
              </div>
            )
          })}
        {isWaitingForResponse && (
          <div className="flex justify-start items-center gap-2">
            <Bot size={14} className="text-gray-400 animate-pulse" />
            <span className="text-sm text-gray-500 animate-pulse">
              Thinking...
            </span>
          </div>
        )}
      </div>
      <form
        onSubmit={handleSubmit}
        onDrop={onDrop}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        className={`border-t p-4 space-y-2 transition-colors ${dragOver ? 'bg-blue-50 border-blue-300' : ''}`}
      >
        {stagedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {stagedFiles.map((sf, i) => (
              <div key={i} className="relative group">
                {sf.previewUrl ? (
                  <img
                    src={sf.previewUrl}
                    alt={sf.file.name}
                    className="w-16 h-16 object-cover rounded-lg border border-gray-200"
                  />
                ) : (
                  <div className="w-16 h-16 rounded-lg border border-gray-200 bg-gray-50 flex flex-col items-center justify-center px-1">
                    <FileText size={16} className="text-gray-400" />
                    <span className="text-[8px] text-gray-500 truncate w-full text-center mt-0.5">
                      {sf.file.name.split('.').pop()?.toUpperCase()}
                    </span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removeStaged(i)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X size={10} />
                </button>
                <span className="block text-[8px] text-gray-400 truncate w-16 text-center mt-0.5">{sf.file.name}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.pdf,.txt,.csv,.md,.json,.docx,.xlsx,.pptx,.zip"
            className="hidden"
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending || !company || stagedFiles.length >= MAX_FILES}
            className="rounded-lg border border-gray-300 p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
            title="Attach files or images"
          >
            <Paperclip size={16} />
          </button>
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value)
              autoResize()
            }}
            onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmit(e)
              }
            }}
            onPaste={onPaste}
            placeholder={company ? (isMobile ? '' : `Message ${company.name}... (drag files, paste images, or prefix with /think for deep reasoning)`) : 'Select a company first'}
            disabled={sending || !company}
            rows={1}
            className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed resize-none overflow-y-auto"
            style={{ maxHeight: '160px' }}
          />
          <button
            type="submit"
            disabled={sending || (!inputValue.trim() && stagedFiles.length === 0) || !company}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
          >
            Send
          </button>
        </div>
        {dragOver && (
          <div className="text-center text-xs text-blue-500 font-medium py-1">
            Drop files here to attach
          </div>
        )}
      </form>
    </div>
  )
}

export default CEOChat

// ── Integration proposal card ───────────────────────────────────────────────
// Inline component to keep the rendering loop tight. Renders the form for
// adding/updating an integration via chat. Submits to the same /api/integrations
// endpoint the API Center uses, and automatically runs a connection test
// after save so the user immediately sees green/red status.

interface IntegrationCardProps {
  vendorDef: IntegrationVendorDef
  existing: { id: string; status: string; credential_preview: string | null } | null
  companyId: string
  preamble?: string
}

function IntegrationProposalCard({ vendorDef, existing, companyId, preamble }: IntegrationCardProps) {
  const [creds, setCreds] = useState<Record<string, string>>({})
  const [config, setConfig] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const f of vendorDef.config) {
      init[f.name] = f.default || ''
    }
    return init
  })
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState<null | { ok: boolean; message: string }>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!companyId) return
    setSaving(true)
    setDone(null)
    try {
      const r = await fetch('/api/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: companyId,
          vendor: vendorDef.vendor,
          credentials: creds,
          config,
        }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        setDone({ ok: false, message: 'Save failed: ' + (body.error || r.statusText) })
        return
      }
      const { integration } = await r.json()
      // Auto-test
      const tr = await fetch(`/api/integrations?id=${integration.id}&action=test`, { method: 'POST' })
      const tb = await tr.json().catch(() => ({}))
      if (tb.ok) {
        setDone({
          ok: true,
          message: `${vendorDef.display_name} connected and verified.`,
        })
      } else {
        setDone({
          ok: false,
          message:
            `${vendorDef.display_name} saved, but the test failed: ` +
            (tb.message || 'unknown error'),
        })
      }
    } catch (err) {
      setDone({
        ok: false,
        message: 'Save failed: ' + (err instanceof Error ? err.message : String(err)),
      })
    } finally {
      setSaving(false)
    }
  }

  const isEditing = !!existing

  if (done?.ok) {
    return (
      <div className="rounded-md border border-green-300 bg-green-50 px-3 py-2 max-w-[85%]">
        <div className="flex items-center gap-2 text-sm text-green-800">
          <CheckCircle2 size={14} />
          <span className="font-semibold">{done.message}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-blue-300 bg-blue-50 px-3 py-2 max-w-[85%] text-sm">
      {preamble && (
        <div className="text-foreground/80 whitespace-pre-wrap mb-2">{preamble}</div>
      )}
      <div className="rounded bg-white border border-blue-200 px-3 py-2">
        <div className="text-xs uppercase tracking-wide font-semibold text-blue-700 mb-1">
          API Center · {isEditing ? 'Update' : 'Add'} integration
        </div>
        <div className="font-medium mb-1">{vendorDef.display_name}</div>
        <div className="text-xs text-gray-600 mb-2">{vendorDef.description}</div>
        {vendorDef.docs_url && (
          <a
            href={vendorDef.docs_url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1 mb-2"
          >
            Get your key <ExternalLink size={10} />
          </a>
        )}
        <form onSubmit={submit} className="space-y-2 mt-2">
          {vendorDef.credentials.map(f => (
            <div key={f.name}>
              <label className="text-xs font-medium block mb-0.5">
                {f.label} {f.required && <span className="text-red-600">*</span>}
              </label>
              {isEditing && f.is_secret && (
                <p className="text-xs text-muted-foreground mb-0.5">
                  Current: <code>{existing.credential_preview}</code> — leave blank to keep, or paste new value to replace.
                </p>
              )}
              <input
                type={f.is_secret ? 'password' : 'text'}
                placeholder={f.placeholder}
                onChange={e => setCreds({ ...creds, [f.name]: e.target.value })}
                className="w-full rounded border border-border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoComplete="off"
              />
              {f.description && (
                <p className="text-xs text-muted-foreground mt-0.5">{f.description}</p>
              )}
            </div>
          ))}
          {vendorDef.config.map(f => (
            <div key={f.name}>
              <label className="text-xs font-medium block mb-0.5">{f.label}</label>
              <input
                type="text"
                value={config[f.name] || ''}
                onChange={e => setConfig({ ...config, [f.name]: e.target.value })}
                placeholder={f.default}
                className="w-full rounded border border-border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {f.description && (
                <p className="text-xs text-muted-foreground mt-0.5">{f.description}</p>
              )}
            </div>
          ))}
          {done && !done.ok && (
            <div className="text-xs text-red-700 rounded bg-red-50 border border-red-200 px-2 py-1">
              {done.message}
            </div>
          )}
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center justify-center gap-1.5 rounded bg-blue-600 text-white text-xs px-3 py-1 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
            {isEditing ? 'Update & test' : 'Save & test'}
          </button>
        </form>
      </div>
    </div>
  )
}

export { IntegrationProposalCard }

// ── Integration problem card ────────────────────────────────────────────────
// Shown when the runner detects auth failure on a connected integration. Uses
// the same form as IntegrationProposalCard but enters edit-mode (existing
// connection) and pre-loads the vendor def from /api/integrations?vendors=1.

interface IntegrationProblemCardProps {
  vendor: string
  displayName: string
  action: string
  originalError: string
  content: string
  companyId: string
}

function IntegrationProblemCard({
  vendor,
  displayName,
  action,
  originalError,
  content,
  companyId,
}: IntegrationProblemCardProps) {
  const [reconnecting, setReconnecting] = useState(false)
  const [vendorDef, setVendorDef] = useState<IntegrationVendorDef | null>(null)
  const [existing, setExisting] = useState<{ id: string; status: string; credential_preview: string | null } | null>(null)

  const startReconnect = async () => {
    setReconnecting(true)
    try {
      const [vRes, iRes] = await Promise.all([
        fetch('/api/integrations?vendors=1'),
        fetch(`/api/integrations?company_id=${companyId}`),
      ])
      if (vRes.ok) {
        const { vendors } = await vRes.json()
        const def = (vendors as IntegrationVendorDef[]).find(v => v.vendor === vendor)
        if (def) setVendorDef(def)
      }
      if (iRes.ok) {
        const { integrations } = await iRes.json()
        const found = (integrations as Array<{ id: string; vendor: string; status: string; credential_preview: string | null }>).find(i => i.vendor === vendor)
        if (found) setExisting({ id: found.id, status: found.status, credential_preview: found.credential_preview })
      }
    } catch (err) {
      alert('Could not load reconnect form: ' + (err instanceof Error ? err.message : String(err)))
      setReconnecting(false)
    }
  }

  if (vendorDef) {
    return (
      <IntegrationProposalCard
        vendorDef={vendorDef}
        existing={existing}
        companyId={companyId}
        preamble={`Reconnecting ${displayName} — paste a fresh key.`}
      />
    )
  }

  return (
    <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 max-w-[85%] text-sm">
      <div className="flex items-center gap-1.5 font-semibold text-red-800 mb-1">
        <AlertTriangle size={14} />
        <span>Integration broken: {displayName}</span>
      </div>
      <div className="text-xs text-red-700 mb-2 whitespace-pre-wrap">
        Auth failed on <code>{action}</code>{originalError ? `: ${originalError}` : ''}.
        {content && content !== `⚠ Integration broken: ${displayName} returned ${originalError.split(' ')[0]} on ${action}. Reconnect to fix.` && (
          <div className="mt-1">{content}</div>
        )}
      </div>
      <button
        onClick={startReconnect}
        disabled={reconnecting}
        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:bg-gray-300"
      >
        {reconnecting ? <Loader2 size={12} className="animate-spin" /> : null}
        Reconnect {displayName}
      </button>
    </div>
  )
}

// ── Schedule proposal card ──────────────────────────────────────────────────
// Renders a recurring-policy proposal: cadence in plain English, next 3 fire
// times, the work-order template that will run each time. Approve creates a
// scheduled_tasks row via /api/schedules. Same backend the Settings UI uses.

interface ScheduleProposalCardProps {
  proposal: ScheduleProposal
  companyId: string
  conversationId: string
  preamble?: string
}

function ScheduleProposalCard({ proposal, companyId, conversationId, preamble }: ScheduleProposalCardProps) {
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState<null | { ok: boolean; message: string }>(null)

  const approve = async () => {
    if (!companyId) return
    setSubmitting(true)
    try {
      const r = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: companyId,
          conversation_id: conversationId,
          name: proposal.name,
          description: proposal.description,
          cadence_type: proposal.cadence_type,
          cadence_spec: proposal.cadence_spec,
          work_order_template: proposal.work_order_template,
        }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        setDone({ ok: false, message: body.error || r.statusText })
      } else {
        setDone({
          ok: true,
          message: `Schedule active. Next firing: ${formatTime(body.schedule?.next_run_at)}.`,
        })
      }
    } catch (err) {
      setDone({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setSubmitting(false)
    }
  }

  if (done?.ok) {
    return (
      <div className="rounded-md border border-green-300 bg-green-50 px-3 py-2 max-w-[85%]">
        <div className="flex items-center gap-2 text-sm text-green-800">
          <CheckCircle2 size={14} />
          <span className="font-semibold">{done.message}</span>
        </div>
      </div>
    )
  }

  const tmpl = proposal.work_order_template
  return (
    <div className="rounded-md border border-purple-300 bg-purple-50 px-3 py-2 max-w-[85%] text-sm">
      {preamble && <div className="text-foreground/80 whitespace-pre-wrap mb-2">{preamble}</div>}
      <div className="rounded bg-white border border-purple-200 px-3 py-2">
        <div className="text-xs uppercase tracking-wide font-semibold text-purple-700 mb-1 inline-flex items-center gap-1">
          <Repeat size={11} /> Recurring schedule
        </div>
        <div className="font-medium mb-1">{proposal.name}</div>
        {proposal.description && (
          <div className="text-xs text-gray-600 mb-2 whitespace-pre-wrap">{proposal.description}</div>
        )}

        <div className="rounded bg-purple-50/70 border border-purple-200 px-2 py-1.5 text-xs mb-2">
          <div className="inline-flex items-center gap-1 font-semibold text-purple-900">
            <CalendarClock size={11} /> Cadence
          </div>
          <div className="text-foreground/80 mt-0.5">{proposal.cadence_human}</div>
          {proposal.next_runs_preview && proposal.next_runs_preview.length > 0 && (
            <div className="mt-1 text-gray-600">
              Next: {proposal.next_runs_preview.slice(0, 3).map(formatTime).join(' · ')}
            </div>
          )}
        </div>

        <div className="rounded bg-blue-50/50 border border-blue-200 px-2 py-1.5 text-xs">
          <div className="inline-flex items-center gap-1 font-semibold text-blue-900">
            <Wrench size={11} /> Each firing runs
          </div>
          <div className="text-foreground/80 mt-0.5">
            <span className="font-medium">{tmpl.type}</span>
            <span className="text-gray-500"> · {tmpl.agent}</span>
          </div>
          <div className="text-gray-600 mt-0.5">{tmpl.title}</div>
          <div className="text-gray-500 mt-0.5 inline-flex flex-wrap gap-3">
            <span className="inline-flex items-center gap-0.5"><DollarSign size={10} /> ≤ ${tmpl.estimated_cost_usd.toFixed(2)}/run</span>
            <span className="inline-flex items-center gap-0.5"><Clock size={10} /> ≤ {tmpl.estimated_minutes} min/run</span>
            <span>→ {tmpl.output_target}</span>
          </div>
        </div>

        {done && !done.ok && (
          <div className="mt-2 text-xs text-red-700 rounded bg-red-50 border border-red-200 px-2 py-1">
            {done.message}
          </div>
        )}

        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={approve}
            disabled={submitting}
            className="inline-flex items-center justify-center gap-1.5 rounded bg-purple-600 text-white text-xs px-3 py-1 hover:bg-purple-700 disabled:bg-gray-300"
          >
            {submitting ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            Approve schedule
          </button>
          <button
            onClick={() => setDone({ ok: false, message: 'Cancelled. No schedule was created.' })}
            disabled={submitting}
            className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded border border-gray-300 text-gray-700 hover:bg-gray-100"
          >
            <X size={12} />
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function formatTime(iso: string | undefined): string {
  if (!iso) return '?'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  return d.toLocaleString(undefined, opts)
}

export { ScheduleProposalCard }
