-- Add full-text search to memories table for stemmed, ranked recall
-- Replaces naive ilike substring matching

-- Generated tsvector column that auto-updates when content or category changes
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(category, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_memories_fts ON public.memories USING gin (fts);
