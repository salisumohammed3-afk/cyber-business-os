# AGENTS.md — AI Agent Handoff Guide

This file is for any AI agent (Claude, Codex, Cursor, etc.) that picks up work on this project. Read this before changing anything.

---

## What This Project Is

Cyber Business OS is an AI-powered business operating system. A user chats with a CEO-level orchestrator agent that manages a team of specialist AI agents (engineering, research, growth, designer, executive assistant). Each agent has its own tools, memory, and external integrations. Tasks flow through a Supabase-backed queue, are executed by a Railway worker running an agentic Claude loop, go through quality review, and deliver real outputs (live apps, reports, documents, emails) back to the chat.

**This is not a demo or prototype.** It's a production system deployed on Vercel (frontend + API), Railway (worker), and Supabase (database + realtime). Changes you make will affect live task execution.

---

## Key Files — Know These Before Touching Anything

| File | What It Does | Danger Level |
|------|-------------|-------------|
| `api/agent-scripts/runner.mjs` | **The entire agent execution engine.** Agentic loop, all tool implementations, quality review, checkpointing, task chaining, deliverable extraction. ~2130 lines of ESM JavaScript. | **Critical** — breaking this breaks all agent execution |
| `worker/index.mjs` | **Task queue worker.** Polls Supabase, claims tasks, forks runner.mjs, handles stuck recovery and graceful shutdown. | **Critical** — breaking this stops all task processing |
| `api/quick-reply.ts` | **Chat endpoint.** Calls Claude Opus for fast replies, parses `[NEEDS_DELEGATION]` markers to create task proposals. | **High** — breaking this breaks the chat |
| `api/run-agent.ts` | **Task trigger.** Sets task status from proposed/failed to pending. Thin layer. | Medium |
| `src/components/CEOChat.tsx` | **Chat UI.** Handles message sending, file attachments, delegation marker parsing, task card creation. | Medium |
| `src/components/ActionPipeline.tsx` | **Task queue UI.** Shows pending/running/completed tasks, approval controls. | Medium |
| `src/hooks/useLiveChat.ts` | **Chat state management.** Manages conversation IDs (persisted in localStorage per company), Supabase Realtime subscriptions. | Medium |
| `src/hooks/useSupabaseData.ts` | **Data fetching.** TanStack Query hooks for agents, tasks, tools, conversations, terminal logs. | Low |
| `supabase/migrations/` | **Database schema.** 24 migration files. Schema changes must go through migrations. | **High** — bad migrations can break the live database |
| `worker/Dockerfile` | **Worker container.** Node 22 Alpine, copies worker + agent-scripts, runs index.mjs. | Medium |
| `.github/workflows/deploy-railway.yml` | **CI/CD.** Auto-deploys worker to Railway when worker/ or api/agent-scripts/ change. | Medium |
| `vercel.json` | **Vercel config.** Build output, API routes, cron schedules, maxDuration. | Medium |

---

## Architecture Decisions — Why Things Are This Way

### Why Vercel + Railway instead of just one?

Vercel serverless functions have a 10-second timeout (free tier) or 60-second max. Agent execution takes 1-10 minutes with many tool calls. The chat endpoint (`quick-reply.ts`) is fast and fits Vercel perfectly. The agent loop needs a persistent process — hence Railway with a Docker container.

### Why `runner.mjs` is one huge file

It started as a module and grew. All tool implementations, the agentic loop, quality review, and task lifecycle live in one file because:
- The runner is forked as a child process — it needs to be self-contained
- It uses zero external dependencies (only Node.js builtins + fetch)
- Splitting it would require a build step for the worker, which currently just copies files

### Why Supabase REST instead of the JS client in runner.mjs

The runner uses raw `fetch` against Supabase's PostgREST API instead of `@supabase/supabase-js`. This avoids adding dependencies to the worker (which has no `package.json` / `npm install` step — it relies on Node builtins only).

### Why Composio instead of direct API integrations

Composio manages OAuth tokens, API versioning, and connection lifecycle for 30+ services. Without it, every integration (Gmail, Apollo, Google Docs, LinkedIn, etc.) would need its own OAuth flow, token refresh, and API client. The trade-off is another dependency and Composio's API being the bottleneck.

### Why the orchestrator has no tools in chat mode

The chat path (`quick-reply.ts`) is a single Anthropic API call with no tool loop. Adding tools would require either: (a) a tool loop in a serverless function (timeout risk), or (b) routing every chat message through the worker (latency). The current design keeps chat fast and delegates real work through the task queue.

### Why quality review uses a separate Claude call

The working agent is biased toward declaring success. A separate reviewer (Sonnet, not the working model) evaluates the output objectively. This catches: empty deployments, broken URLs, vague reports with no data, and tools-used-but-nothing-produced scenarios.

---

## Known Gotchas

1. **`runner.mjs` line numbers shift constantly.** Don't reference specific line numbers in comments or docs — use function names or section headers.

2. **The `ROUTING_ADDENDUM` in `quick-reply.ts` is critical.** It tells the orchestrator how to delegate. If you change the wording, test that delegation still triggers correctly.

3. **`tasks.metadata` is a JSONB grab bag.** It stores checkpoints, handoff chains, retry counts, and agent-specific data. Treat it as append-only — don't overwrite the whole object without merging.

4. **Composio action IDs are case-sensitive and unpredictable.** Always use `composio_find_actions` first. Never hardcode action IDs like `APOLLO_PEOPLE_SEARCH` — they change when Composio updates their API.

5. **The worker uses `fork()`, not `spawn()`.** This means runner.mjs runs in a V8 isolate with IPC channel. The worker can send messages to the child (though it currently doesn't use this).

6. **`agentDefId` scope in `toolStoreMemory`.** The `agentDefId` variable used in `store_memory` is set in `main()`. If you refactor the tool implementations into separate files, this closure dependency breaks.

7. **The self-delegation guard only checks slug equality.** If two different agents have the same slug (shouldn't happen but could with bad data), the guard won't catch cross-delegation between them.

8. **`deploy_static_site` modifies the source directory.** It writes `package.json` and `Dockerfile` into the deploy directory for the Railway fallback. If the engineering agent calls deploy twice on the same directory, these files will already exist.

9. **Supabase Realtime subscriptions in the frontend are per-table.** `terminal_logs` and `chat_messages` both have Realtime subscriptions. If you add new tables that need real-time updates, you need to enable Realtime on them in Supabase.

10. **The `companies` table gates everything.** Every task, agent, goal, and memory is scoped to a `company_id`. If this is null or wrong, agents can't see their own data.

---

## What NOT to Change Without Understanding Consequences

- **The `callClaude` retry logic** — changing retry delays or removing retries will cause cascading failures when Anthropic rate-limits or has outages
- **The `saveCheckpoint` format** — existing checkpoints in the database are in this format; changing it breaks resume-from-checkpoint for in-flight tasks
- **The `tasks.status` state machine** — `proposed → pending → running → completed/failed`. The frontend, worker, and runner all depend on these exact status values
- **The `[NEEDS_DELEGATION]` regex** — both `quick-reply.ts` and the frontend parse this exact string. Changing it breaks delegation
- **The `terminal_logs` insert format** — the frontend LiveTerminal and BottomTerminal components parse `message`, `source`, `log_type`, and `agent_slug` from these rows

---

## Environment Variables

The system needs these to function. Missing any critical one causes silent failures (agents run but can't do their job).

| Variable | Required | Where | Notes |
|----------|----------|-------|-------|
| `ANTHROPIC_API_KEY` | Yes | Vercel + Railway | Without this, nothing works |
| `SUPABASE_URL` / `VITE_SUPABASE_URL` | Yes | Both | Different names for different contexts |
| `SUPABASE_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Yes | Railway / Vercel | Service role key, not anon |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Yes | Vercel | Anon key for frontend |
| `VERCEL_TOKEN` | Recommended | Railway | Without this, deploy_static_site fails |
| `COMPOSIO_API_KEY` | Optional | Railway | Without this, no external tool integrations |
| `SERPER_API_KEY` | Optional | Railway | Without this, web_search fails |
| `RAILWAY_DEPLOY_TOKEN` | Optional | Railway | Fallback deployment target |

---

## Testing

- **Unit tests:** `vitest` — run with `npx vitest run`
- **E2E tests:** `playwright` — run with `npx playwright test`
- **Manual smoke test:** Send "What can you do?" in chat → should get a direct response (no delegation). Then "Build me a calculator app" → should produce a proposed task card.

---

## Further Reading

- `README.md` — Setup guide, agent descriptions, customization, credentials
- `docs/system-overview.md` — Component-level overview with tool references
- `docs/architecture-internals.md` — Execution engine deep-dive with flowcharts
- `docs/project-memory-summary.md` — History of all development sessions and decisions
