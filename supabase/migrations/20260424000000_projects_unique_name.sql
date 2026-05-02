-- Projects: enforce unique (company_id, name). This makes register_project
-- idempotent and prevents the duplicate-projects-on-rerun bug.
--
-- First, dedupe any existing rows by keeping the most recently updated.

WITH ranked AS (
  SELECT id, company_id, name,
    ROW_NUMBER() OVER (
      PARTITION BY company_id, lower(name)
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    ) AS rn
  FROM public.projects
)
DELETE FROM public.projects p
USING ranked r
WHERE p.id = r.id AND r.rn > 1;

-- Now create the unique index. Case-insensitive — "TodoApp" and "todoapp"
-- are the same thing for our purposes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_company_name_unique
  ON public.projects (company_id, lower(name));

COMMENT ON INDEX public.idx_projects_company_name_unique IS
  'Enforces register_project uniqueness per (company, name) — prevents duplicates on agent re-runs';
