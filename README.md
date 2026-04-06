# Cyber Business OS

An AI-powered business operating system. Chat with a CEO-level orchestrator agent that manages a team of specialist AI agents — each with their own tools, memory, and external integrations. Give it tasks through a chat interface, and the agents do the work: building apps, running research, executing outreach, creating designs, managing your calendar — and deliver real outputs back to you.

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

## The Agents

### Orchestrator

The central coordinator. Every conversation starts here. Answers quick questions directly via Claude Opus. For real work, proposes a task and delegates to the right specialist.

**Tools:** `delegate_task`, `create_task`, `store_memory`, `recall_memories`, `database_query`, `manage_integrations`, `test_url`, `fail_task`

### Engineering Agent

The builder. Writes code, creates GitHub repos, deploys live applications. Has a full sandbox environment (file system + shell) and a deployment pipeline (Vercel → Railway → GitHub Pages fallback).

**Tools:** `sandbox_write_file`, `sandbox_read_file`, `sandbox_bash`, `sandbox_list_files`, `github_create_repo`, `github_push_file`, `deploy_static_site`, `register_project`, `database_admin` + all shared tools

**Composio:** GitHub, Google Docs, Google Drive

### Research Agent

The analyst. Deep dives, market sizing, competitive intelligence, structured reports with sources and frameworks (PESTLE, Porter's Five Forces, SWOT).

**Composio:** Exa, Firecrawl, Google Docs, Google Sheets, Perplexity AI

### Growth Agent

The revenue engine. Covers acquisition, sales pipeline, outreach campaigns, and lead generation. Merged from three original agents (sales, outreach, growth).

**Composio:** Apollo, LinkedIn, Instantly, Gmail, AgentMail, Google Docs, Google Sheets

### Designer Agent

UI/UX design, design systems, wireframing. Provides specific CSS/Tailwind suggestions.

**Tools:** `design_system_search` + all shared tools

**Composio:** Figma, Google Docs

### Executive Assistant

The CEO's operational backbone. Email triage, meeting notes → action items, project management, client reporting, calendar scheduling.

**Composio:** Google Calendar, Gmail, Google Docs, Google Sheets, Granola

## How Agents Interact

Agents coordinate through the Supabase task queue — they don't talk to each other directly.

**Single delegation:** Orchestrator creates a task for a specialist → worker runs it → quality review → result posted back to chat.

**Chained workflows:** The orchestrator can set `next_agent` and `next_instruction` on a delegation. When the first agent finishes, the system automatically creates a follow-up task for the next agent, injecting the previous result via `{RESULT}` placeholder.

**Quality review:** Every completed task goes through a separate Claude review call. If rejected, the agent gets feedback and retries (up to 2 attempts). If still failing, the task is marked failed with a specific error.

**Shared memory:** All agents share a `memories` table with full-text search. Any agent can store facts and any agent can recall them later.

## Database Schema

| Table | Purpose |
|-------|---------|
| `agent_definitions` | Agent configs: slug, name, system prompt, model, company |
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
├── vercel.json                  # Vercel config + crons
└── package.json
```

## Local Development

```sh
git clone https://github.com/salisumohammed3-afk/cyber-business-os.git
cd cyber-business-os
npm install
npm run dev
```

Requires a `.env` file with:

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_PUBLISHABLE_KEY=...
ANTHROPIC_API_KEY=...
COMPOSIO_API_KEY=...
```

The worker runs separately on Railway and is not needed for frontend development.

## Deployment

- **Frontend + API:** Pushes to `main` auto-deploy to Vercel (connected via GitHub integration)
- **Worker:** Pushes to `main` that touch `worker/` or `api/agent-scripts/` auto-deploy to Railway via GitHub Actions
- **Database:** Run `npx supabase db push` to apply migrations to the remote Supabase project
- **Manual Railway deploy:** `bash scripts/deploy-railway.sh`
