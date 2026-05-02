-- Stage 4: explicit message types for chat_messages.
-- Replaces the metadata flag-soup (notification / error / progress / kind) with
-- a single typed column. UI routes rendering on this column.
--
-- Kinds (closed set):
--   user_msg            -- what the user typed
--   reply               -- straight chat reply from orchestrator/assistant
--   work_order_proposal -- card with Approve/Cancel buttons
--   work_order_status   -- approved / running / completed / failed / cancelled
--   error               -- system error, real diagnostic shown
--   notification        -- non-work-order task completion (legacy)
--   progress            -- "Working on it..." indicator
--
-- New rows MUST set kind. Old rows are backfilled from existing metadata.

ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS kind TEXT;

-- Backfill existing rows from metadata + role.
UPDATE public.chat_messages
SET kind = CASE
  WHEN (metadata->>'kind') IN
    ('user_msg', 'reply', 'work_order_proposal', 'work_order_status', 'error', 'notification', 'progress')
    THEN metadata->>'kind'
  WHEN role = 'user' THEN 'user_msg'
  WHEN (metadata->>'progress')::boolean IS TRUE THEN 'progress'
  WHEN (metadata->>'error')::boolean IS TRUE THEN 'error'
  WHEN (metadata->>'notification')::boolean IS TRUE THEN 'notification'
  ELSE 'reply'
END
WHERE kind IS NULL;

-- Index on kind so the UI can filter quickly if needed
CREATE INDEX IF NOT EXISTS idx_chat_messages_kind
  ON public.chat_messages(conversation_id, kind);

COMMENT ON COLUMN public.chat_messages.kind IS
  'Typed message kind: user_msg | reply | work_order_proposal | work_order_status | error | notification | progress. Replaces metadata-flag soup.';
