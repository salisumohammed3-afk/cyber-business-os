import { useRef, useEffect, useState } from 'react'
import { useLiveChat } from '@/hooks/useLiveChat'

type ConversationIdProp = string | null

export function CEOChat({ conversationId }: { conversationId?: ConversationIdProp }) {
  const { messages, loading, error, sendMessage } = useLiveChat(conversationId ?? null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [inputValue, setInputValue] = useState('')
  const [sending, setSending] = useState(false)

  // Auto-scroll to bottom when messages change
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
                <p className="text-sm whitespace-pre-wrap">{msg.content ?? ''}</p>
              </div>
            </div>
          ))}
        {isWaitingForResponse && (
          <div className="flex justify-start">
            <span className="text-sm text-gray-500 animate-pulse">
              thinking...
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
          placeholder="Type a message..."
          disabled={sending}
          className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <button
          type="submit"
          disabled={sending || !inputValue.trim()}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Send
        </button>
      </form>
    </div>
  )
}
