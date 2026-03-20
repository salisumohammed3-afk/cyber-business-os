import { useRef, useEffect, useState, useMemo, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import { Bot, Pencil } from 'lucide-react'
import { useLiveChat } from '@/hooks/useLiveChat'
import { useCompany } from '@/contexts/CompanyContext'
import { supabase } from '@/integrations/supabase/client'
import { Link } from 'react-router-dom'

interface ProjectRef { id: string; deploy_url: string }

export function CEOChat() {
  const { company } = useCompany()
  const { messages, loading, error, sendMessage } = useLiveChat(company?.id ?? null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [inputValue, setInputValue] = useState('')
  const [sending, setSending] = useState(false)
  const [projectRefs, setProjectRefs] = useState<ProjectRef[]>([])

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
    if (!text || sending) return
    setSending(true)
    setInputValue('')
    try {
      await sendMessage(text)
    } catch (err) {
      console.error(err)
      setInputValue(text)
    } finally {
      setSending(false)
    }
  }

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
          messages.map((msg) => (
            <div
              key={msg.id}
              className={
                msg.role === 'user'
                  ? 'flex justify-end'
                  : 'flex justify-start'
              }
            >
              <div
                className={
                  msg.role === 'user'
                    ? 'rounded-lg px-4 py-2 max-w-[80%] bg-blue-600 text-white'
                    : 'rounded-lg px-4 py-2 max-w-[80%] bg-gray-200 text-gray-900'
                }
              >
                {msg.role === 'user' ? (
                  <p className="text-sm whitespace-pre-wrap">{msg.content ?? ''}</p>
                ) : (
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
                )}
              </div>
            </div>
          ))}
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
        className="border-t p-4 flex gap-2 items-center"
      >
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder={company ? `Message ${company.name}...` : 'Select a company first'}
          disabled={sending || !company}
          className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <button
          type="submit"
          disabled={sending || !inputValue.trim() || !company}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Send
        </button>
      </form>
    </div>
  )
}

export default CEOChat
