# Cyber Business OS — System Overview

## What Is It?

Cyber Business OS is an AI-powered business operating system. You chat with a CEO-level orchestrator agent that manages a team of specialist AI agents, each with their own tools and capabilities. You give it tasks through a chat interface, and the agents do the work — building apps, doing research, running outreach, creating designs — and deliver real outputs back to you.

---

## Infrastructure Summary

| Service | Platform | Purpose |
|---------|----------|---------|
| Frontend | **Vercel** | React SPA + serverless API functions |
| Worker | **Railway** | Persistent task processor (Docker) |
| Database | **Supabase** | PostgreSQL + Realtime + Storage |
| AI | **Anthropic Claude** | Opus for orchestrator, Sonnet for specialists |
| External tools | **Composio** | Managed integrations (Apollo, Gmail, GitHub, Figma, etc.) |
| Code hosting | **GitHub** | Source repo + agent-created project repos |
| Cron jobs | **Vercel Crons** | Daily planner, digest, skill recommendations (8 AM) |
| Deployments | **GitHub Actions** | Auto-deploy worker to Railway on push to main |

---

## Frontend (Vercel)

A React + TypeScript single-page app built with Vite, styled with Tailwind CSS and shadcn/ui (Radix primitives). Deployed on Vercel.

### Main Pages

| Page | What It Does |
|------|-------------|
| **Index** | The main dashboard. Contains the CEO Chat interface, task pipeline, and activity view |
| **Agents** | Shows all specialist agents, their skills, and which tools (built-in + Composio) they have access to |
| **Outputs** | Displays deliverables the agents have produced — documents, reports, links. Supports preview and download |
| **Company Settings** | Company configuration, agent tool management (toggle Composio integrations on/off per agent) |
| **Project Editor** | View and edit projects the engineering agent has built |

### Key Components

- **CEOChat** — The main chat interface where you talk to the orchestrator. Supports text, file/image attachments, and shows agent notifications when tasks complete.
- **ActionPipeline** — Visual task queue showing pending, running, and completed tasks with approval controls.
- **BottomTerminal** — Live system status bar showing real-time agent logs streamed from the database.
- **LiveTerminal** — Detailed terminal view of agent execution logs.
- **AgentSidebar** — Navigation and agent status overview.
- **TopBar** — Header with navigation between pages.

### Data Layer

`useSupabaseData.ts` — Custom hooks for fetching agents, tasks, tools, conversations, and terminal logs from Supabase. Uses Supabase Realtime subscriptions for instant updates on chat messages and logs.

---

## API Layer (Vercel Serverless Functions)

TypeScript serverless functions deployed on Vercel under `/api/`. They handle lightweight, request-response operations.

| Endpoint | Purpose |
|----------|---------|
| **quick-reply** | The chat endpoint. Calls Claude Opus for fast replies. If the orchestrator decides the task needs real work, it marks the response with `[NEEDS_DELEGATION]` and the frontend creates a task card for approval |
| **run-agent** | Triggers a task to be picked up by the Railway worker |
| **health** | System health check |
| **daily-digest** | Scheduled cron (8:05 AM daily) — generates a daily summary of what happened |
| **proactive-planner** | Scheduled cron (8:00 AM daily) — suggests tasks and priorities for the day |
| **skill-recommender** | Scheduled cron (8:10 AM daily) — recommends skill improvements for agents |
| **project-feedback** | Collects feedback on agent-built projects |
| **job-run-ledger** | Tracks cron job execution history |
| **companies / goals** | Company and goal management endpoints |

---

## Worker (Railway)

The heavy-lifting engine. A persistent Node.js process running on Railway in a Docker container.

### Task Queue Worker (`worker/index.mjs`)

- Polls Supabase every 5 seconds for pending tasks
- Claims a task (sets status to "running")
- Forks `runner.mjs` as a child process with the task's environment variables
- Runs up to 2 tasks concurrently
- Monitors for stuck tasks (>10 min with no heartbeat)
- Logs everything back to Supabase `terminal_logs` table
- Handles graceful shutdown and crash recovery

### Agent Runner (`api/agent-scripts/runner.mjs`)

This is where all agent work happens:

1. Loads the agent definition (prompt, model, tools) from Supabase
2. Loads the agent's allowed Composio integrations from the `agent_tools` table
3. Builds a system prompt with operational context, project info, and skills
4. Runs an **agentic loop**: calls Claude, processes tool calls, feeds results back, repeats until the task is done or time runs out
5. Has a **10-minute time budget** with turn-by-turn awareness ("you have 3 minutes left, wrap up")
6. After completion, runs a **quality review** — a separate Claude call that evaluates if the output is actually usable
7. If the review rejects the work, sends it back for **revision** (up to 2 retries)
8. Extracts deliverables (URLs, documents, projects) and posts a notification back to the chat
9. If everything fails after retries, marks the task as failed with an accurate error message

### Deployment Chain

When the engineering agent calls `deploy_static_site`, the tool automatically tries:

1. **Vercel** (primary)
2. **Railway** (fallback)
3. **GitHub Pages / raw.githack** (last resort)

---

## Database (Supabase)

PostgreSQL hosted on Supabase. The single source of truth for everything.

| Table | What It Stores |
|-------|---------------|
| **agent_definitions** | Each agent's config: slug, name, system prompt, model, company |
| **base_agent_definitions** | Template definitions for multi-company support |
| **tasks** | The task queue. Status lifecycle: pending → running → completed/failed. Contains title, description, input data, error messages, retry counts |
| **task_results** | Full output from completed tasks — the agent's response text, tool calls made, deliverables |
| **chat_messages** | All conversation messages (user + orchestrator + agent notifications). Supports attachments |
| **conversations** | Conversation sessions per company |
| **agent_tools** | Which Composio integrations each agent has access to. Toggled from Company Settings |
| **skills** | Agent skills — learned capabilities and recommendations |
| **projects** | Registry of things the engineering agent has built (name, repo URL, deploy URL, status) |
| **memories** | Agent memory store with full-text search (GIN index). Agents can store and recall information across tasks |
| **terminal_logs** | Real-time execution logs from the worker. Streamed to the frontend via Supabase Realtime |
| **company_goals** | Company-level OKRs and goals |
| **system_heartbeats** | Health monitoring for worker services |
| **job_runs** | Cron job execution ledger |

Supabase Storage is used for chat file/image attachments.

---

## The Agents

### Orchestrator (CEO's Right Hand)

**Role:** The central coordinator. Every conversation starts here. It decides whether to answer directly or delegate work to specialists.

**How it works in chat:** When you type a message, it goes to `quick-reply.ts` on Vercel, which calls Claude Opus. If it's a quick question ("what's the status of X?"), the orchestrator answers directly. If it's real work ("build me a landing page"), it marks the response with `[NEEDS_DELEGATION]` and creates a task card for you to approve. Once approved, the task goes to the queue and the right specialist picks it up.

**Tools:**

- `delegate_task` — Send work to any specialist agent. Can chain agents together with `next_agent`/`next_instruction` for multi-step workflows (e.g., research first, then growth runs outreach based on the findings)
- `create_task` — Propose a task for approval
- `store_memory` / `recall_memories` — Persistent memory across conversations
- `database_query` — Query any table in the system
- `manage_integrations` — View, assign, or revoke Composio app access for any agent
- `test_url` — Verify a URL loads correctly
- `fail_task` — Mark something as failed with a reason

**What it doesn't have:** No web search, no sandbox, no GitHub, no Composio external tools. It manages, it doesn't build.

---

### Engineering Agent

**Role:** The builder. Writes code, creates repos, deploys live applications, manages infrastructure.

**Personality:** "Default to building, not describing." Precise, technical, estimates effort, flags risks.

**Tools (in addition to all shared tools):**

- `sandbox_write_file` / `sandbox_read_file` / `sandbox_bash` / `sandbox_list_files` — A full local dev environment (temp directory per task on Railway)
- `github_create_repo` / `github_push_file` — Creates repos and pushes code to GitHub
- `deploy_static_site` — Deploys apps live (Vercel → Railway → GitHub Pages fallback)
- `register_project` — Registers completed projects in the system's project database
- `database_admin` — Direct SQL access for schema work

**Composio integrations:** GitHub, Google Docs, Google Drive

**How it delivers:** Writes the code in the sandbox → pushes to GitHub → deploys via `deploy_static_site` → runs `test_url` to verify the live URL actually loads → registers the project. If the review rejects it, it gets the feedback and tries again.

---

### Research Agent

**Role:** The analyst. Deep dives, market sizing, competitive intelligence, data-driven reports.

**Personality:** Thorough but concise. Cites sources, distinguishes facts from estimates. Uses frameworks (PESTLE, Porter's Five Forces, SWOT) where appropriate. Presents findings with key takeaways first.

**Composio integrations:** Exa (semantic search), Firecrawl (web scraping), Google Docs, Google Sheets, Perplexity AI

**How it delivers:** Searches the web, scrapes relevant sources, synthesises findings into structured reports. Can output to Google Docs.

---

### Growth Agent

**Role:** The revenue engine. Covers the full lifecycle: acquisition, sales pipeline, outreach campaigns, lead generation.

**Personality:** "Think like a revenue leader. Quantify everything." Uses ICE scores (Impact, Confidence, Ease) to prioritise. Keeps cold emails under 100 words. Action-oriented — what to do this week, this month.

**Expertise spans three merged roles** (previously separate sales, outreach, and growth agents):

- **Acquisition & Growth** — Funnel optimisation, A/B tests, viral loops, retention analysis, product-market fit assessment
- **Sales & Revenue** — Pipeline management, pricing strategy, competitive positioning, revenue forecasting, discovery calls
- **Outreach & Campaigns** — Cold email, LinkedIn outreach, lead scoring, follow-up sequences, ICP refinement, objection handling

**Composio integrations:** Apollo (lead data), LinkedIn, Instantly (email sequences), Gmail, AgentMail, Google Docs, Google Sheets

---

### Designer Agent

**Role:** UI/UX design, design systems, wireframing, prototyping.

**Personality:** User-first. References design patterns by name. Provides specific CSS/Tailwind suggestions. Balances aesthetics with usability. Explains design rationale clearly.

**Specialist tools:**

- `design_system_search` — Searches through design system components and patterns

**Composio integrations:** Figma, Google Docs

---

### Executive Assistant

**Role:** The CEO's operational backbone. Email management, meeting notes to actions, project management, client reporting, calendar.

**Personality:** Proactive — anticipates what the CEO needs next. Professional and concise. Prioritises by urgency and business impact. Surfaces things that need attention without being asked.

**Key capabilities:**

- **Email** — Triage, draft, and send emails. Flag urgent messages, track threads needing follow-up
- **Meeting Notes → Actions** — Parse notes, extract action items, create tasks with owners and due dates
- **Project Management** — Create/update board items, track status, generate weekly reports
- **Client Reporting** — Compile status updates, pull metrics, draft client-facing reports
- **Calendar** — Check availability, suggest times, draft agendas, send invites

**Composio integrations:** Google Calendar, Gmail, Google Docs, Google Sheets, Granola (meeting notes)

---

## How Agents Interact

Agents don't talk to each other directly. All coordination flows through the task queue in Supabase.

### Single Delegation

```
You: "Build me a todo app"
  → Orchestrator (chat): marks [NEEDS_DELEGATION], creates task card
  → You approve the task
  → Task enters queue (status: pending)
  → Worker picks it up, forks runner.mjs for Engineering agent
  → Engineering builds, deploys, verifies
  → Quality review runs (separate Claude call)
  → If accepted: task completed, notification posted to chat
  → If rejected: sent back for revision (up to 2 retries)
```

### Chained Delegation (Multi-Step Workflows)

```
Orchestrator delegates to Research:
  "Research competitors in the AI agent space"
  next_agent: "growth"
  next_instruction: "Based on this research: {RESULT}, draft outreach emails to the top 5"

  → Research agent runs, completes
  → System automatically creates a new task for Growth agent
     with {RESULT} replaced by Research's actual output
  → Growth agent runs with the research as context
  → Both results flow back to the chat
```

The handoff chain is stored in `task.metadata.handoff` and processed after task completion. The `parent_task_id` links child tasks back to the original so the system can trace the full chain.

### Quality Control Loop

Every completed task goes through quality review:

1. A separate Claude call evaluates whether the output is a usable deliverable
2. If **ACCEPTED**: task marked completed, notification with deliverables sent to chat
3. If **REJECTED**: agent receives feedback, runs again (up to 2 revision attempts)
4. If still rejected after retries: task marked failed with a specific error message

### Shared Memory

Every agent has access to `store_memory` and `recall_memories`, backed by the same `memories` table with full-text search. If the research agent stores "Competitor X raised $50M in Series B", any agent can recall it later. The orchestrator also has memory, so context persists across conversations.

---

## Tools Reference

### Shared Tools (All Agents)

| Tool | Description |
|------|-------------|
| `web_search` | Google search via Serper API |
| `database_query` | Query any Supabase table |
| `store_memory` | Save information to persistent memory |
| `recall_memories` | Search memory with full-text search |
| `project_query` | Query the projects database |
| `test_url` | Verify a URL loads correctly (HTTP status + content preview) |
| `fail_task` | Declare a task failed with reason and partial results |
| `create_task` | Propose a new task for approval |
| `delegate_task` | Send work to another agent (with optional chaining) |

### Orchestrator-Only Tools

| Tool | Description |
|------|-------------|
| `manage_integrations` | List, assign, or remove Composio apps for any agent |

### Engineering-Only Tools

| Tool | Description |
|------|-------------|
| `sandbox_write_file` | Write a file to the local dev environment |
| `sandbox_read_file` | Read a file from the sandbox |
| `sandbox_bash` | Execute shell commands in the sandbox |
| `sandbox_list_files` | List directory contents |
| `github_create_repo` | Create a new GitHub repository |
| `github_push_file` | Push a file to a GitHub repo |
| `deploy_static_site` | Deploy to Vercel/Railway/GitHub Pages |
| `register_project` | Register a project in the system database |
| `database_admin` | Execute direct SQL queries |

### Designer-Only Tools

| Tool | Description |
|------|-------------|
| `design_system_search` | Search design system components and patterns |

### External Tools (Composio)

| Tool | Description |
|------|-------------|
| `composio_find_actions` | Discover available actions for a Composio app |
| `composio_execute` | Execute a Composio action (e.g., send email via Gmail, create lead in Apollo) |

Composio apps are assigned per-agent via the `agent_tools` database table and can be toggled on/off from Company Settings. The orchestrator can manage assignments using the `manage_integrations` tool.

---

## Scheduled Jobs (Cron)

| Job | Schedule | What It Does |
|-----|----------|-------------|
| Proactive Planner | 8:00 AM daily | Analyses current state and suggests tasks/priorities for the day |
| Daily Digest | 8:05 AM daily | Summarises what happened — completed tasks, outputs, issues |
| Skill Recommender | 8:10 AM daily | Recommends skill improvements for agents based on recent performance |

---

*Document generated: April 2026*
