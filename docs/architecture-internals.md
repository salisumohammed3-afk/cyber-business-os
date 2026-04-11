# Architecture Internals

Deep-dive companion to the README. Covers the execution engine, tool dispatch, worker internals, and data flows that make Cyber Business OS work.

---

## Two Execution Paths

There are two fundamentally different ways Claude gets called in this system:

### Path 1: Quick-Reply (Chat, No Tools)

```
Browser → POST /api/quick-reply → Claude Opus (text-only) → Response
```

- **File:** `api/quick-reply.ts` (Vercel serverless)
- **Model:** `claude-opus-4-6`
- **Tools:** None — the orchestrator has no tools in chat mode
- **Max tokens:** 1024
- **Temperature:** 0.3
- **Context loaded:** System prompt + company brief + active goals + recent tasks + last 12 chat messages
- **Delegation:** If the response contains `[NEEDS_DELEGATION]`, the frontend creates a proposed task. The text before the marker is shown as the chat reply.

This path is fast (<5s typical) and cheap (no tool loop). It handles conversational messages, status questions, and delegation decisions.

### Path 2: Runner (Full Agent Loop with Tools)

```
POST /api/run-agent → tasks.status = pending
Worker polls → claims task → forks runner.mjs
runner.mjs → Claude loop with tools → quality review → deliver
```

- **File:** `api/agent-scripts/runner.mjs` (Railway Docker)
- **Model:** Per agent definition (default `claude-sonnet-4-20250514`)
- **Tools:** 10-25 depending on agent role
- **Max tokens:** 4096 per turn
- **Temperature:** Per agent definition (default 0.7)
- **Time budget:** 5 minutes default, configurable per agent

This path handles all real work. It's expensive (multi-turn, tool-heavy) but produces actual deliverables.

---

## The Runner: Step by Step

### Startup Sequence

```
main()
  ├── Load task from Supabase
  ├── Load agent_definitions row (prompt, model, temperature, time budget)
  ├── Resolve company_id (from task or agent)
  ├── Inject company context into system prompt
  ├── Inject active goals
  ├── Fetch Composio connected accounts → filter by agent_tools rows
  ├── Inject Composio app list into system prompt
  ├── Load skills (agent_skill_links → skills table)
  ├── Inject operational rules ("verify your work", "don't describe, do")
  ├── Engineering agent: inject engineering-specific instructions + project edit mode
  ├── Select tool array based on agent slug
  ├── Build conversation (chat history + task instruction)
  ├── Inject relevant memories (FTS on instruction keywords)
  ├── Check for checkpoint → resume if available
  └── Enter runLoop()
```

### The Agentic Loop (`runLoop`)

```
runLoop(model, systemPrompt, messages, tools, timeBudgetMs)
│
├── turn = 0, startTime = now
│
├── WHILE turn < 200 AND timeLeft > 0:
│   │
│   ├── turn++
│   │
│   ├── IF timeLeft < 60s AND turn > 2:
│   │   └── Inject urgency message (< 15s: "FINAL STEP, answer NOW")
│   │
│   ├── response = callClaude(...)
│   │   └── Retries: 429 → wait 15s/30s/45s, 5xx → wait 5s/10s/15s (up to 3 attempts)
│   │
│   ├── IF response.stop_reason === "tool_use":
│   │   │
│   │   ├── IF fail_task AND failAttempts < 2 AND timeLeft > 30s:
│   │   │   └── Push back: "Don't give up, try another approach"
│   │   │
│   │   ├── FOR EACH tool_use block:
│   │   │   ├── executeTool(name, input) → dispatch to handler
│   │   │   ├── Log tool call + result preview
│   │   │   └── Append tool_result to messages
│   │   │
│   │   ├── saveCheckpoint(messages, turn, allToolCalls)
│   │   └── continue
│   │
│   └── ELSE (text response / end_turn):
│       └── RETURN { status: "completed", text, turns, toolCalls }
│
└── RETURN { status: "time_expired", turns, toolCalls }
```

### Post-Loop Processing

```
After runLoop returns:
│
├── Determine initial status:
│   ├── completed + real text → "completed"
│   ├── time_expired + >2 tool calls → "completed" (did useful work)
│   └── else → "failed"
│
├── Quality review (if completed):
│   ├── checkOutputUrls() → verify deploy URLs and doc links load
│   ├── reviewResult() → Claude Sonnet judges deliverable quality
│   │   ├── ACCEPT → done
│   │   └── REJECT → revision loop (3 min budget, up to 2 retries)
│   │       └── After max retries → "failed"
│   └── extractDeliverables() → scan tool calls for URLs, docs, repos
│
├── Post notification to chat_messages
├── Update tasks.status + task_results
│
├── Auto-retry (if failed + delegated + retries < 2):
│   └── Create new pending task with error context
│
└── Handoff chain (if completed + metadata.handoff.next_agent):
    └── Create pending task for next agent with {RESULT} substitution
```

---

## Tool Dispatch Architecture

All tools are defined as JSON schemas (for Claude) and implemented as async functions. The dispatch is a simple switch statement in `executeTool()`.

### Tool Arrays

| Array | When Used | Tools |
|-------|-----------|-------|
| `BASE_TOOLS` | All agents except orchestrator (which gets a filtered subset) | `web_search`, `database_query`, `create_task`, `store_memory`, `recall_memories`, `delegate_task`, `project_query`, `test_url`, `fail_task` |
| `ENGINEERING_TOOLS` | Engineering agent only | `github_create_repo`, `github_push_file`, `database_admin`, `register_project`, `sandbox_bash`, `sandbox_read_file`, `sandbox_write_file`, `sandbox_list_files`, `deploy_static_site` |
| `DESIGNER_TOOLS` | Designer agent only | `design_system_search` |
| `COMPOSIO_TOOLS` | Any agent with Composio apps assigned | `composio_find_actions`, `composio_execute` |
| `MANAGE_INTEGRATIONS_TOOL` | Orchestrator only (when running in the full loop, not chat) | `manage_integrations` |

### Orchestrator Tool Selection

When the orchestrator runs in the full agent loop (not quick-reply chat), it gets a restricted subset:

```javascript
const ORCHESTRATOR_ONLY = [
  "delegate_task", "create_task", "store_memory", "recall_memories",
  "database_query", "test_url", "fail_task"
];
tools = BASE_TOOLS.filter(t => ORCHESTRATOR_ONLY.includes(t.name));
tools.push(MANAGE_INTEGRATIONS_TOOL);
```

No web search, no sandbox, no Composio. The orchestrator manages — it doesn't build.

### Sandbox Tools

The engineering agent's sandbox is a temp directory on the Railway worker host:

- **Path:** `/tmp/agent-tasks/<taskId>/`
- **Lifetime:** Created when the task starts, deleted when the child process exits
- **Bash:** `execSync` with 120s timeout, 2MB max buffer, blocking commands detected and rejected
- **File size limit:** sandbox_read_file truncates at 20KB, deploy_static_site skips files >5MB
- **Blocked commands:** HTTP servers, watchers, nodemon, tail -f — anything that would hang forever

### Deployment Pipeline (`deploy_static_site`)

```
collectFiles(directory) → base64 encode all files < 5MB
│
├── Strategy 1: Vercel Deployments API (/v13/deployments)
│   ├── Upload files as base64 payload
│   ├── On success: disable SSO protection (PATCH /v9/projects/{id})
│   └── Return live URL
│
├── Strategy 2: Railway (fallback)
│   ├── Write package.json + Dockerfile to build directory
│   ├── Create tar.gz archive
│   ├── Create Railway service via GraphQL
│   ├── Generate public domain
│   └── Return domain URL (needs GitHub repo connection to actually serve)
│
└── Strategy 3: GitHub Pages / raw.githack (last resort)
    └── Error message suggesting manual GitHub push
```

---

## Worker Internals

### Process Model

```
worker/index.mjs (Railway Docker, Node 22 Alpine)
│
├── Main loop: poll() every 5s
│   ├── Every 10th poll: recoverStuckTasks()
│   ├── Every 5th poll: upsertHeartbeat()
│   └── While activeTasks.size < MAX_CONCURRENT:
│       ├── claimTask() → CAS update on tasks table
│       └── runTask() → fork(runner.mjs, { env, cwd })
│
├── Child management:
│   ├── activeTasks = Map<taskId, childProcess>
│   ├── stdout/stderr piped with [taskId] prefix
│   └── on exit → reconcileRunnerExit() + cleanup workdir
│
└── Shutdown:
    ├── SIGTERM → running = false, wait 30s for active tasks
    └── SIGINT → immediate exit
```

### Claiming Algorithm

```sql
-- Step 1: Find highest-priority pending task
SELECT id, conversation_id FROM tasks
WHERE status = 'pending'
ORDER BY priority DESC, created_at ASC
LIMIT 1

-- Step 2: Atomically claim it (CAS)
UPDATE tasks SET status = 'running', started_at = now()
WHERE id = <id> AND status = 'pending'
RETURNING *
-- If returns empty → someone else claimed it, move on
```

### Heartbeats

The worker upserts `system_heartbeats` (key: `railway_worker`) every 5th poll with:
- `last_seen_at` timestamp
- `poll_count` and `active_tasks` count in metadata

This lets you monitor worker health from the database.

### Stuck Recovery

Every 10th poll (~50s), the worker scans for tasks that have been `running` longer than `STUCK_TIMEOUT_MIN` (default 10 minutes):

| Condition | Action |
|-----------|--------|
| Still in local `activeTasks` map | Skip — still running on this worker |
| Has checkpoint + retries < 2 | Reset to `pending` with incremented retry count |
| No checkpoint or retries >= 2 | Mark as `failed` |

---

## Data Flow Diagrams

### Chat Message Flow

```
User types message
  → CEOChat component stores in chat_messages (role: user)
  → POST /api/quick-reply
  → Loads: orchestrator prompt, company, goals, tasks, 12 recent messages
  → Anthropic Messages API (Opus, no tools)
  → Response contains [NEEDS_DELEGATION]?
      YES → Parse task title + description
          → Insert tasks row (status: proposed)
          → Insert chat_messages (acknowledgment text)
          → Return { mode: "proposed", task_id }
      NO  → Insert chat_messages (reply text)
          → Return { mode: "direct" }
```

### Task Execution Flow

```
User approves task in ActionPipeline
  → POST /api/run-agent
  → tasks.status = pending

Railway worker (polling every 5s)
  → claimTask(): pending → running (CAS)
  → fork runner.mjs with env vars

runner.mjs:
  → Load task + agent def + context
  → runLoop(model, prompt, messages, tools, timeBudget)
  → Quality review (Sonnet)
  → Extract deliverables
  → Insert task_results
  → Insert chat_messages (notification)
  → Update tasks.status = completed/failed

  If handoff.next_agent:
    → Insert new tasks row (pending) for next agent
  If failed + isDelegated + retries < 2:
    → Insert retry tasks row (pending)
```

### Real-Time Updates

```
runner.mjs → sbInsert("terminal_logs", {...})
  → Supabase Realtime broadcasts insert
  → Frontend BottomTerminal/LiveTerminal subscribes
  → Live logs appear in the UI as agents work

runner.mjs → sbInsert("chat_messages", {...})
  → Supabase Realtime broadcasts insert
  → Frontend CEOChat subscribes
  → Notifications appear as agent messages
```

---

## Cron Jobs

All cron jobs run as Vercel serverless functions, scheduled in `vercel.json`.

| Job | Schedule | File | Model | Purpose |
|-----|----------|------|-------|---------|
| Proactive Planner | 8:00 AM daily | `api/proactive-planner.ts` | Sonnet | Analyzes current state and suggests tasks/priorities |
| Daily Digest | 8:05 AM daily | `api/daily-digest.ts` | Sonnet | Summarizes completed tasks, outputs, and issues |
| Skill Recommender | 8:10 AM daily | `api/skill-recommender.ts` | Sonnet | Recommends skill improvements based on recent performance |

Each cron job:
1. Fetches relevant data from Supabase (tasks, agents, skills)
2. Makes a single Claude Sonnet call
3. Inserts results (suggested tasks, digest messages, skill recommendations)
4. Logs execution to `job_runs` table

---

## Key Constants

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `MAX_CONCURRENT` | 2 | `worker/index.mjs` | Parallel tasks per worker |
| `POLL_INTERVAL` | 5000ms | `worker/index.mjs` | Worker poll frequency |
| `STUCK_TIMEOUT_MIN` | 10 | `worker/index.mjs` | Minutes before task is stuck |
| `DEFAULT_TIME_BUDGET_MS` | 300000 (5 min) | `runner.mjs` | Default agent execution time |
| `HARD_TURN_CAP` | 200 | `runner.mjs` | Absolute maximum turns |
| `MAX_FAIL_RETRIES` | 2 | `runner.mjs` | Pushbacks before accepting fail_task |
| `MAX_REVIEW_RETRIES` | 2 | `runner.mjs` | Quality review revision attempts |
| `REVISION_TIME_BUDGET` | 180000 (3 min) | `runner.mjs` | Time for each revision attempt |
| `MAX_AUTO_RETRIES` | 2 | `runner.mjs` | Auto-retries for failed delegated tasks |
| `callClaude MAX_RETRIES` | 3 | `runner.mjs` | API call retries on 429/5xx |

---

*Document generated: April 2026*
