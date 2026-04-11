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

## Agent Execution Deep-Dive

This section explains the full lifecycle of a task from the moment you type a message to the moment you get a result back.

### Step 1: Chat Message → Delegation

When you send a message, `api/quick-reply.ts` calls Claude Opus with the orchestrator's system prompt plus recent chat history, company context, active goals, and recent tasks. The orchestrator has **no tools** in chat mode — it's text-only.

If the message needs real work, the orchestrator includes the marker `[NEEDS_DELEGATION]` followed by a task title and description. The frontend parses this out, shows you a task card with the preamble as an acknowledgment, and inserts a `proposed` row in the `tasks` table.

If it's a quick question, the orchestrator just answers directly and the response is saved to `chat_messages`.

### Step 2: Approval → Task Queue

When you approve a task, the frontend calls `api/run-agent.ts`, which sets the task status from `proposed` to `pending`. This is a thin trigger — it does no execution itself.

### Step 3: Worker Claims the Task

The Railway worker (`worker/index.mjs`) polls Supabase every 5 seconds. When it finds a `pending` task, it claims it with a compare-and-swap update: `status: pending → running` filtered by `id + status`. If another worker already claimed it, the update returns empty and it moves on.

The worker orders tasks by `priority DESC, created_at ASC` — higher priority first, then first-in-first-out.

It runs up to 2 tasks concurrently (`MAX_CONCURRENT=2`). For each claimed task, it:

1. Creates a working directory at `/tmp/agent-tasks/<taskId>`
2. Forks `runner.mjs` as a child process with `TASK_ID`, `CONVERSATION_ID`, and `TASK_WORKDIR` in the environment
3. Pipes stdout/stderr to the worker console with task ID prefixes
4. Cleans up the working directory when the child exits

### Step 4: The Agentic Loop

`runner.mjs` is the core execution engine (~2130 lines). On startup it:

1. **Loads the task** from Supabase
2. **Loads the agent definition** — system prompt, model, temperature, time budget
3. **Injects context** — company brief, active goals, Composio apps, installed skills, relevant memories (FTS)
4. **Checks for a checkpoint** — if this is a retry, it resumes from the saved conversation state
5. **Selects tools** based on the agent slug (orchestrator gets management tools, engineering gets sandbox + deploy, etc.)
6. **Runs the loop:**

```
while (turn < 200 && timeLeft > 0):
    if timeLeft < 60s:  inject urgency warning into conversation
    if timeLeft < 15s:  inject "THIS IS YOUR FINAL STEP"

    response = callClaude(model, systemPrompt, messages, tools)

    if response has tool_use blocks:
        if tool is fail_task AND retries < 2 AND timeLeft > 30s:
            push back ("Don't give up, try different approach")
            continue

        for each tool_use block:
            execute the tool
            log input + output preview
            append tool_result to messages

        saveCheckpoint(messages, turn, toolCalls)
        continue

    else (text response):
        return { status: "completed", text }

if time expired:
    return { status: "time_expired" }
```

The `callClaude` function retries on HTTP 429 (rate limit) with 15s backoff and on 5xx with 5s backoff, up to 3 attempts.

### Step 5: Quality Review

Every completed task goes through `reviewResult()`:

1. **Automated URL check** — `checkOutputUrls()` fetches up to 3 deploy URLs and Google Doc/Sheet links to verify they load
2. **Claude Sonnet review** — A separate Claude call evaluates whether there's a usable deliverable. The prompt asks: "Is there something the user can immediately use — a link that works, a report with real information, a document they can open?"
3. **Verdict:**
   - `ACCEPT:` → task marked completed, deliverables extracted and posted to chat
   - `REJECT:` → agent gets the feedback and runs a revision loop (3-minute budget, same tools)
   - Up to 2 revision attempts. If still rejected, task fails with the rejection reason.

### Step 6: Deliverable Extraction & Notification

`extractDeliverables()` scans all tool calls for actionable outputs:
- `deploy_static_site` → live app URL
- `register_project` → project ID
- `github_create_repo` → repo URL
- `composio_execute` with Google Docs/Sheets/Gmail actions → document links, email confirmations

`formatNotification()` builds a markdown message with the agent name, task title, result summary, and deliverable links. This is inserted into `chat_messages` so you see it in the chat.

### Step 7: Task Chaining (Handoff)

If the original delegation included `next_agent` and `next_instruction` (stored in `task.metadata.handoff`), the runner creates a follow-up task:

- `next_instruction` can include `{RESULT}` which is replaced with the actual output text
- The new task is `pending` immediately — no approval needed
- The `parent_task_id` links back to the original so the chain is traceable

Example: Research agent finishes → system creates a Growth task with the research results injected → Growth agent runs outreach using those findings.

### Step 8: Auto-Retry for Failed Delegated Tasks

If a delegated task (source: `agent`) fails and hasn't been retried yet:

1. A new task is created with the same agent and instruction, plus context about what went wrong
2. The instruction includes: "A previous attempt FAILED with this error: ... You MUST avoid this same mistake."
3. Up to 2 auto-retries (`auto_retry_count` in metadata)
4. A notification is posted to chat: "Task failed — automatically retrying with adjusted approach"

### Stuck Task Recovery

The worker checks for stuck tasks every 10th poll cycle (~50 seconds):

1. Finds tasks with status `running` and `started_at` older than 10 minutes (`STUCK_TIMEOUT_MIN`)
2. Skips tasks that are still running locally (in `activeTasks` map)
3. If the task has a checkpoint and fewer than 2 retries → reset to `pending` for retry
4. Otherwise → mark as `failed` with "Timed out" error

Additionally, when a child process exits, `reconcileRunnerExit()`:
- Abnormal exit (non-zero code or signal) → immediately mark task as `failed`
- Clean exit (code 0) → wait 5 seconds, then check if the task is still `running` (which means the runner didn't update the status itself) → mark as failed

### Checkpoint & Resume

After every tool call, the runner saves a checkpoint to `tasks.metadata.checkpoint`:
- Serialized conversation messages (truncated to avoid bloat)
- Current turn number
- Tools used so far
- Timestamp

If a checkpoint is larger than 500KB, only the last 10 messages are saved. On retry, the runner restores these messages and skips the initial setup, continuing from where it left off.

### Time Budgets

- **Default:** 5 minutes (`DEFAULT_TIME_BUDGET_MS`)
- **Per-agent override:** `agent_definitions.time_budget_seconds` takes priority
- **Legacy:** If `max_turns` is set, time budget = `max(max_turns * 30s, 5 minutes)`
- **Hard cap:** 200 turns absolute maximum regardless of time
- **Turn awareness:** At <60s remaining, a system message warns the agent to wrap up. At <15s, it demands an immediate final answer.
- **Revision budget:** 3 minutes per revision attempt (separate from the main budget)

### Composio Integration

External tools (Gmail, Apollo, Google Docs, Figma, etc.) are managed through [Composio](https://composio.dev):

1. **Discovery:** On startup, `runner.mjs` fetches all active connected accounts from `backend.composio.dev/api/v1/connectedAccounts`
2. **Filtering:** Cross-references active accounts against the agent's `agent_tools` rows (DB-driven, toggled from Company Settings UI)
3. **Access control:** Each agent only sees apps assigned to it. The orchestrator has no Composio access. Attempting to use an unassigned app returns an error.
4. **Two-step workflow:** Agents first call `composio_find_actions(app_name, use_case)` to discover available operations, then `composio_execute(action_id, params)` to run them. Action IDs are never hardcoded.
5. **Account matching:** `composio_execute` finds the right connected account by matching the action ID prefix against app names (handles underscores and casing variations).

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

## Troubleshooting

### Common Issues

**Anthropic 500 errors / MCP beta header issues**

If agents fail with HTTP 500 from Anthropic, check the `anthropic-version` and `anthropic-beta` headers in `runner.mjs`. The Messages API uses `2023-06-01` — do not add MCP beta headers unless you're using Anthropic's MCP connector (which this project does not use).

**Composio toolkit name mismatches**

Composio app names must match exactly what the API returns (e.g., `apollo`, not `loxo`). If `composio_find_actions` returns empty results, verify the app name against connected accounts: the `manage_integrations` tool (via the orchestrator) or the Company Settings UI shows what's actually connected.

**Self-delegation loops**

The orchestrator could previously delegate tasks to itself, creating infinite loops. This is now guarded: `toolDelegateTask` rejects `agentDef.slug === agentSlug`. If you see a loop, check that the delegation target slug doesn't match the current agent.

**`time_expired` treated as success**

If an agent makes >2 tool calls but runs out of time, the system treats it as `completed` (on the theory that it did useful work). This can produce low-quality results. If you see tasks completing with minimal output, check `task_results.data.turns` — a high turn count with `time_expired` status means the budget was too short for the task.

**Tasks stuck in `running` state**

The worker recovers stuck tasks automatically (10-minute timeout), but if the worker itself is down, tasks stay stuck. Check:
- Railway worker health: `system_heartbeats` table, `service_key = 'railway_worker'`
- Worker logs in Railway dashboard or `terminal_logs` with `source = 'railway-worker'`

**CEOChat default export / Vite build failure**

If `npm run build` fails with a default export error, ensure `src/components/CEOChat.tsx` uses `export default` — Vite's code splitting requires it.

**Low Anthropic credit balance**

The system doesn't check credit balance proactively. If agents start failing with billing errors, check your Anthropic account at [console.anthropic.com](https://console.anthropic.com). The orchestrator (Opus) costs significantly more per call than specialists (Sonnet).

### Verifying the System is Working

```bash
# Check worker health (should show recent timestamp)
curl "YOUR_SUPABASE_URL/rest/v1/system_heartbeats?service_key=eq.railway_worker&select=last_seen_at" \
  -H "apikey: YOUR_ANON_KEY"

# Check for stuck tasks
curl "YOUR_SUPABASE_URL/rest/v1/tasks?status=eq.running&select=id,title,started_at" \
  -H "apikey: YOUR_ANON_KEY"

# Check recent terminal logs
curl "YOUR_SUPABASE_URL/rest/v1/terminal_logs?order=created_at.desc&limit=10&select=message,source,log_type" \
  -H "apikey: YOUR_ANON_KEY"
```

---

## License

Private. All rights reserved.
