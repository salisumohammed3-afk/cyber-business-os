import { useRef, useEffect, useState, useMemo, useCallback, type KeyboardEvent, type DragEvent, type ClipboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import { Bot, Pencil, Globe, GitBranch, FileText, Mail, CheckCircle2, Sheet, Paperclip, X, Image as ImageIcon } from 'lucide-react'
import { useLiveChat, type Attachment } from '@/hooks/useLiveChat'
import { useCompany } from '@/contexts/CompanyContext'
import { supabase } from '@/integrations/supabase/client'
import { Link } from 'react-router-dom'

interface ProjectRef { id: string; deploy_url: string }

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
  const { messages, loading, error, sendMessage } = useLiveChat(company?.id ?? null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [inputValue, setInputValue] = useState('')
  const [sending, setSending] = useState(false)
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([])
  const [dragOver, setDragOver] = useState(false)

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

  const isWaitingForResponse =
    messages.length > 0 && messages[messages.length - 1]?.role === 'user'

  return (
    <div className="flex flex-col h-full">
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
            const isNotification = meta?.notification === true
            const deliverables = (isNotification && Array.isArray(meta?.deliverables))
              ? meta.deliverables as Deliverable[]
              : []
            const notifAgent = (meta?.agent_slug as string) || ''

            const attachments = (
              meta?.attachments && Array.isArray(meta.attachments)
                ? meta.attachments as Array<{ name: string; url: string; type: string; size: number }>
                : []
            )

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
            placeholder={company ? `Message ${company.name}... (paste images or drag files)` : 'Select a company first'}
            disabled={sending || !company}
            rows={1}
            className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed resize-none overflow-y-auto"
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
