# Cyber Business OS

An AI-powered business operating system. Chat with a CEO-level orchestrator agent that manages a team of specialist AI agents — each with their own tools, memory, and external integrations. Give it tasks through a chat interface, and the agents do the work: building apps, running research, executing outreach, creating designs, managing your calendar — and deliver real outputs back to you.

---

## Architecture

```
You (CEO)
  │
  ▼
CEO Chat (Vercel) ── fast response via Claude Opus
  │
  │ [NEEDS_DELEGATION] → creates task card for approval
  ▼
Task Queue (Supabase)
  │
  │ Worker polls every 5s
  ▼
Worker (Railway) → forks runner.mjs per task
  │
  ├─ Engineering Agent → builds + deploys apps
  ├─ Research Agent    → deep research + reports
  ├─ Growth Agent      → outreach + lead gen
  ├─ Designer Agent    → UI/UX + mockups
  └─ Executive Assistant → email, calendar, admin
  │
  ▼
Quality Review → accept / reject + retry → deliver to chat
```

## Infrastructure

| Service | Platform | Purpose |
|---------|----------|---------|
| Frontend | **Vercel** | React SPA + serverless API functions |
| Worker | **Railway** | Persistent task processor (Docker) |
| Database | **Supabase** | PostgreSQL + Realtime + Storage |
| AI | **Anthropic Claude** | Opus for orchestrator, Sonnet for specialists |
| External tools | **Composio** | Managed integrations (Apollo, Gmail, GitHub, Figma, etc.) |
| Code hosting | **GitHub** | Source repo + agent-created project repos |
| Cron jobs | **Vercel Crons** | Daily planner, digest, skill recommendations |
| CI/CD | **GitHub Actions** | Auto-deploy worker to Railway on push to main |

## Tech Stack

- **Frontend:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui (Radix), Framer Motion
- **API:** Vercel Serverless Functions (TypeScript)
- **Worker:** Node.js (ESM), Docker on Railway
- **Database:** Supabase (PostgreSQL + Realtime subscriptions + Storage)
- **AI:** Anthropic Claude API (claude-opus-4-6, claude-sonnet-4-20250514)
- **External integrations:** Composio SDK (Apollo, Gmail, LinkedIn, Figma, Google Workspace, etc.)

---

## The Agents

### Orchestrator

The central coordinator. Every conversation starts here. Answers quick questions directly via Claude Opus. For real work, proposes a task and delegates to the right specialist. Can chain agents together for multi-step workflows.

**Tools:** `delegate_task`, `create_task`, `store_memory`, `recall_memories`, `database_query`, `manage_integrations`, `test_url`, `fail_task`

**What it doesn't have:** No web search, no sandbox, no GitHub, no Composio external tools. It manages — it doesn't build.

### Engineering Agent

The builder. Writes code, creates GitHub repos, deploys live applications. Has a full sandbox environment (file system + shell) and a deployment pipeline that tries Vercel first, falls back to Railway, then GitHub Pages.

**Tools:** `sandbox_write_file`, `sandbox_read_file`, `sandbox_bash`, `sandbox_list_files`, `github_create_repo`, `github_push_file`, `deploy_static_site`, `register_project`, `database_admin` + all shared tools

**Composio:** GitHub, Google Docs, Google Drive

### Research Agent

The analyst. Deep dives, market sizing, competitive intelligence, structured reports with sources and frameworks (PESTLE, Porter's Five Forces, SWOT).

**Tools:** All shared tools (web search, memory, database, test_url)

**Composio:** Exa, Firecrawl, Google Docs, Google Sheets, Perplexity AI

### Growth Agent

The revenue engine. Covers acquisition, sales pipeline, outreach campaigns, and lead generation. Merged from three original agents (sales, outreach, growth).

**Tools:** All shared tools

**Composio:** Apollo, LinkedIn, Instantly, Gmail, AgentMail, Google Docs, Google Sheets

### Designer Agent

UI/UX design, design systems, wireframing. Provides specific CSS/Tailwind suggestions.

**Tools:** `design_system_search` + all shared tools

**Composio:** Figma, Google Docs

### Executive Assistant

The CEO's operational backbone. Email triage, meeting notes → action items, project management, client reporting, calendar scheduling.

**Tools:** All shared tools

**Composio:** Google Calendar, Gmail, Google Docs, Google Sheets, Granola

---

## How Agents Interact

Agents coordinate through the Supabase task queue — they don't talk to each other directly.

**Single delegation:** Orchestrator creates a task for a specialist → worker runs it → quality review → result posted back to chat.

**Chained workflows:** The orchestrator can set `next_agent` and `next_instruction` on a delegation. When the first agent finishes, the system automatically creates a follow-up task for the next agent, injecting the previous result via `{RESULT}` placeholder.

**Quality review:** Every completed task goes through a separate Claude review call. If rejected, the agent gets feedback and retries (up to 2 attempts). If still failing, the task is marked failed with a specific error.

**Shared memory:** All agents share a `memories` table with full-text search. Any agent can store facts and any agent can recall them later.

---

## Database Schema

| Table | Purpose |
|-------|---------|
| `agent_definitions` | Agent configs: slug, name, system prompt, model, company |
| `base_agent_definitions` | Templates for seeding new companies |
| `tasks` | Task queue (pending → running → completed/failed) |
| `task_results` | Full output from completed tasks |
| `chat_messages` | Conversation messages + agent notifications |
| `conversations` | Chat sessions per company |
| `agent_tools` | Per-agent Composio integration assignments |
| `skills` | Agent learned capabilities |
| `projects` | Registry of engineering-built projects |
| `memories` | Persistent memory with FTS (GIN index) |
| `terminal_logs` | Real-time execution logs (streamed via Supabase Realtime) |
| `company_goals` | Company OKRs and goals |
| `system_heartbeats` | Worker health monitoring |
| `job_runs` | Cron job execution ledger |

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/quick-reply` | Chat with the orchestrator |
| `POST /api/run-agent` | Trigger a task for the worker |
| `GET /api/health` | System health check |
| `GET /api/daily-digest` | Daily summary (cron, 8:05 AM) |
| `GET /api/proactive-planner` | Task suggestions (cron, 8:00 AM) |
| `GET /api/skill-recommender` | Agent skill improvements (cron, 8:10 AM) |
| `POST /api/project-feedback` | Project feedback collection |
| `GET /api/job-run-ledger` | Cron execution history |

---

## Project Structure

```
├── api/
│   ├── quick-reply.ts          # Chat endpoint (Vercel)
│   ├── run-agent.ts            # Task trigger
│   ├── health.ts               # Health check
│   ├── daily-digest.ts         # Daily digest cron
│   ├── proactive-planner.ts    # Proactive planner cron
│   ├── skill-recommender.ts    # Skill recommender cron
│   ├── project-feedback.ts     # Project feedback
│   ├── job-run-ledger.ts       # Job run tracking
│   ├── companies.ts            # Company management
│   ├── goals.ts                # Goals management
│   └── agent-scripts/
│       └── runner.mjs          # Agent execution engine
├── worker/
│   ├── index.mjs               # Railway task queue worker
│   ├── Dockerfile              # Worker container config
│   └── railway.toml            # Railway deployment config
├── src/
│   ├── pages/
│   │   ├── Index.tsx            # Main dashboard + chat
│   │   ├── Agents.tsx           # Agent management
│   │   ├── Outputs.tsx          # Deliverables viewer
│   │   ├── CompanySettings.tsx  # Settings + tool config
│   │   └── ProjectEditor.tsx    # Project editor
│   ├── components/
│   │   ├── CEOChat.tsx          # Chat interface
│   │   ├── ActionPipeline.tsx   # Task queue UI
│   │   ├── BottomTerminal.tsx   # Live system status
│   │   ├── LiveTerminal.tsx     # Agent execution logs
│   │   └── ui/                  # shadcn/ui components
│   └── hooks/
│       └── useSupabaseData.ts   # Data fetching hooks
├── supabase/
│   └── migrations/              # 24 migration files
├── scripts/
│   └── deploy-railway.sh        # Manual Railway deploy
├── .github/
│   └── workflows/
│       └── deploy-railway.yml   # Auto-deploy to Railway
├── docs/
│   └── system-overview.md       # Detailed system documentation
├── vercel.json                  # Vercel config + crons
└── package.json
```

---

## Getting Started — Set Up Your Own Instance

### Prerequisites

You'll need accounts on the following services (all have free tiers):

| Service | What you need | Sign up |
|---------|---------------|---------|
| **Supabase** | A project (PostgreSQL database) | [supabase.com](https://supabase.com) |
| **Vercel** | For hosting the frontend + API | [vercel.com](https://vercel.com) |
| **Railway** | For hosting the worker | [railway.app](https://railway.app) |
| **Anthropic** | Claude API key | [console.anthropic.com](https://console.anthropic.com) |
| **GitHub** | Repo hosting + agent code pushes | [github.com](https://github.com) |
| **Composio** (optional) | External tool integrations | [composio.dev](https://composio.dev) |

### Step 1: Clone the Repo

```bash
git clone https://github.com/salisumohammed3-afk/cyber-business-os.git
cd cyber-business-os
npm install
```

### Step 2: Set Up Supabase

1. Create a new project at [supabase.com](https://supabase.com)
2. Install the Supabase CLI: `npm install -g supabase`
3. Link your project:
   ```bash
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   ```
4. Run all migrations to create the schema and seed the agents:
   ```bash
   npx supabase db push
   ```
   This creates all tables, seeds the 6 default agents (orchestrator, engineering, research, growth, designer, executive-assistant), and configures their prompts and tool assignments.

5. From your Supabase dashboard, grab:
   - **Project URL** — Settings → API → Project URL
   - **Anon (public) key** — Settings → API → `anon` `public` key
   - **Service role key** — Settings → API → `service_role` key (keep this secret — it's for the Vercel API functions)

### Step 3: Set Up Environment Variables

Create a `.env` file in the project root:

```bash
# Supabase (frontend)
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-anon-key

# Anthropic
ANTHROPIC_API_KEY=sk-ant-api03-your-key

# Composio (optional — for external tool integrations)
COMPOSIO_API_KEY=your-composio-key
```

### Step 4: Deploy the Frontend to Vercel

1. Push your fork to GitHub
2. Go to [vercel.com](https://vercel.com), import the repository
3. Set these environment variables in the Vercel dashboard (Settings → Environment Variables):

   | Variable | Value | Notes |
   |----------|-------|-------|
   | `VITE_SUPABASE_URL` | `https://YOUR_REF.supabase.co` | Your Supabase project URL |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | `eyJ...` | Supabase anon key |
   | `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` | Supabase service role key (secret) |
   | `ANTHROPIC_API_KEY` | `sk-ant-...` | Your Anthropic API key |
   | `COMPOSIO_API_KEY` | `ak_...` | Optional — Composio key |
   | `SERPER_API_KEY` | `...` | Optional — for web search ([serper.dev](https://serper.dev)) |

4. Deploy. Vercel will build the React app and set up the serverless API functions automatically.

### Step 5: Deploy the Worker to Railway

1. Go to [railway.app](https://railway.app), create a new project
2. Add a new service → Deploy from GitHub repo
3. Set the **root directory** to `/` (Railway uses `worker/Dockerfile` via `railway.toml`)
4. Set these environment variables in Railway:

   | Variable | Value | Notes |
   |----------|-------|-------|
   | `SUPABASE_URL` | `https://YOUR_REF.supabase.co` | Same as above |
   | `SUPABASE_KEY` | `eyJ...` | Use the **service role key** here |
   | `ANTHROPIC_API_KEY` | `sk-ant-...` | Your Anthropic API key |
   | `VERCEL_TOKEN` | `...` | For agent deployments ([vercel.com/account/tokens](https://vercel.com/account/tokens)) |
   | `COMPOSIO_API_KEY` | `ak_...` | Optional |
   | `SERPER_API_KEY` | `...` | Optional |

5. Deploy. The worker will start polling Supabase for tasks immediately.

### Step 6: Run Locally (Optional)

For frontend development only:

```bash
npm run dev
```

This starts the Vite dev server at `http://localhost:5173`. The chat and UI work locally, but tasks are processed by the Railway worker (not locally).

### Step 7: Test It

1. Open your Vercel deployment URL
2. Type a message in the chat, e.g. "What can you do?"
3. The orchestrator should respond directly
4. Try a real task: "Build me a simple calculator app"
5. The orchestrator should propose a task card → approve it → watch the engineering agent build and deploy it in the terminal logs

---

## Customising the Agents

### Change an Agent's Personality or Instructions

Each agent's behaviour is controlled by its `system_prompt` in the `agent_definitions` table.

**Option A — SQL (direct):**

```sql
UPDATE agent_definitions
SET system_prompt = 'Your new prompt here...',
    updated_at = now()
WHERE slug = 'research';
```

**Option B — Supabase dashboard:**

1. Go to your Supabase project → Table Editor → `agent_definitions`
2. Find the row with the slug you want to change
3. Edit the `system_prompt` column
4. Save

Changes take effect on the next task — no redeployment needed.

### Add a New Agent

1. Insert a new row into `agent_definitions`:
   ```sql
   INSERT INTO agent_definitions (slug, name, description, system_prompt, model, company_id, is_orchestrator)
   VALUES (
     'copywriter',
     'Copywriter Agent',
     'Writes marketing copy, blog posts, social media content',
     'You are the Copywriter Agent. You write compelling copy that converts...',
     'claude-sonnet-4-20250514',
     'YOUR_COMPANY_ID',
     false
   );
   ```

2. Also insert into `base_agent_definitions` if you want it to be available to new companies.

3. Add the new slug to the orchestrator's system prompt so it knows the agent exists:
   ```sql
   UPDATE agent_definitions
   SET system_prompt = system_prompt || E'\n- **copywriter** — marketing copy, blog posts, social media.'
   WHERE slug = 'orchestrator';
   ```

4. If the agent needs Composio integrations, assign them:
   ```sql
   INSERT INTO agent_tools (agent_id, tool_name, tool_type, connection_source, is_enabled)
   SELECT id, unnest(ARRAY['googledocs', 'gmail']), 'composio', 'composio', true
   FROM agent_definitions WHERE slug = 'copywriter';
   ```

5. If the agent needs **custom built-in tools** (beyond the shared set), you'll need to add them in `api/agent-scripts/runner.mjs`:
   - Define the tool schema (like `ENGINEERING_TOOLS`)
   - Implement the tool function
   - Add it to the tool selection block (~line 1818)

### Remove an Agent

```sql
DELETE FROM agent_tools WHERE agent_id = (SELECT id FROM agent_definitions WHERE slug = 'designer');
DELETE FROM agent_definitions WHERE slug = 'designer';
```

Remove the reference from the orchestrator's system prompt as well.

### Change Which Composio Apps an Agent Has

**From the UI:** Go to Company Settings → Tools tab → toggle apps on/off per agent.

**From SQL:**
```sql
-- Give the research agent access to Gmail
INSERT INTO agent_tools (agent_id, tool_name, tool_type, connection_source, is_enabled)
SELECT id, 'gmail', 'composio', 'composio', true
FROM agent_definitions WHERE slug = 'research'
ON CONFLICT (agent_id, tool_name) DO UPDATE SET is_enabled = true;

-- Remove it
UPDATE agent_tools SET is_enabled = false
WHERE agent_id = (SELECT id FROM agent_definitions WHERE slug = 'research')
  AND tool_name = 'gmail';
```

**From the orchestrator chat:** Ask the orchestrator — it has the `manage_integrations` tool and can list, assign, or remove Composio apps for any agent.

### Swap the AI Model

Each agent has a `model` column in `agent_definitions`. The default is `claude-sonnet-4-20250514` for specialists and `claude-opus-4-6` for the orchestrator (in quick-reply).

```sql
-- Use a different model for the engineering agent
UPDATE agent_definitions SET model = 'claude-opus-4-6' WHERE slug = 'engineering';
```

The orchestrator's chat model is set in `api/quick-reply.ts` (the `model` field in the Anthropic API call).

---

## Credentials Reference

Here's every credential the system uses and where it goes:

| Credential | Where it's set | What it's for |
|------------|---------------|---------------|
| `VITE_SUPABASE_URL` | `.env`, Vercel | Frontend connects to Supabase |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `.env`, Vercel | Frontend auth (anon key) |
| `SUPABASE_URL` | Railway | Worker connects to Supabase |
| `SUPABASE_KEY` | Railway | Worker auth (service role key) |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel | API functions auth (service role key) |
| `ANTHROPIC_API_KEY` | Vercel, Railway | Claude API for all agents |
| `VERCEL_TOKEN` | Railway | Agent deployments to Vercel |
| `RAILWAY_DEPLOY_TOKEN` | Railway | Agent deployments to Railway (fallback) |
| `COMPOSIO_API_KEY` | Railway | External tool integrations |
| `SERPER_API_KEY` | Railway | Web search via Serper (Google) |

---

## Deployment

- **Frontend + API:** Pushes to `main` auto-deploy to Vercel (connected via GitHub integration)
- **Worker:** Pushes to `main` that touch `worker/` or `api/agent-scripts/` auto-deploy to Railway via GitHub Actions
- **Database:** Run `npx supabase db push` to apply migrations to the remote Supabase project
- **Manual Railway deploy:** `bash scripts/deploy-railway.sh`

---

## License

Private. All rights reserved.
