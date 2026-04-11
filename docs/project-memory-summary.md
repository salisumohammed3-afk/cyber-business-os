# Project Memory — Cyber Business OS

Complete history of development sessions, decisions, and context for agent handoff. This document captures everything discussed across all Cursor sessions as of April 2026.

---

## Session History

### Session 1: Initial Setup and Deployment
**UUID:** `5174ce00-4ab6-4882-8499-811fbebbf14b`

**What happened:**
- Created `useAgentDefinitions` TanStack Query hook for fetching agent data
- Resolved git push authentication — switched from HTTPS to SSH remote
- Set up Vercel project via CLI (`npx vercel`)
- Fixed CEOChat default export for Vite build (named export → default export)
- Configured `vercel.json` for SPA routing

**Key outcomes:**
- Frontend deployed to Vercel
- GitHub repo connected via SSH
- Build pipeline working

---

### Session 2: System Overview Documentation
**UUID:** `63e75088-67d2-49d2-8471-4c11e6d394b2`

**What happened:**
- Authored `docs/system-overview.md` (~350 lines)
- Documented all infrastructure, agents, tools, flows, and cron schedules

**Key outcomes:**
- First comprehensive system documentation created

---

### Session 3: End-to-End Debugging (Major Session)
**UUID:** `c5f6d027-d5e1-4fff-8458-af26d0c23ab6`

This was the longest and most impactful session — a multi-day debugging effort that touched nearly every component.

**Problems identified and fixed:**
1. **Anthropic 500 errors** — Caused by deprecated MCP beta headers. Removed `mcp_toolset` references and beta header injection.
2. **Composio toolkit mismatches** — "Loxo" was not a valid toolkit; the correct name is "Apollo". Composio SDK was partially vindicated after initial suspicion.
3. **Self-delegation loops** — Orchestrator was delegating tasks to itself. Added guard: `agentDef.slug === agentSlug` rejection in `toolDelegateTask`.
4. **Tasks completing without useful output** — Multiple causes: empty response handling, `time_expired` treated as success when agent did tool calls, notification using raw `result.text` instead of revised text.
5. **Vercel timeout confusion** — Clarified that `run-agent.ts` is a thin trigger only; execution happens on Railway, not in the Vercel function.
6. **Orchestrator routing** — Updated orchestrator prompt with routing addendum to improve delegation accuracy (growth vs Apollo-holding agent).
7. **Agent verification** — Added `test_url` tool so agents can verify their own deployed sites before declaring completion.

**Architecture clarifications:**
- Vercel functions kick off tasks and track them — they don't execute agent loops
- Railway worker + runner.mjs handles all heavy execution
- Composio is the tool provider for external services, not a replacement for the agent loop

**Commits produced:**
- MCP beta/toolset changes
- Orchestrator prompt updates (tool routing)
- Self-delegation guard
- Empty-response handling
- Previously uncommitted UI code
- Turn awareness and time-budget model

---

### Session 4: Runner and Worker Audit
**UUID:** `08e358f7-513c-46b7-8107-3444c6452089`

**What happened:**
- Structured PASS/FAIL audit of `runner.mjs` and `worker/index.mjs`
- Engineering agent deployment pipeline verified (Vercel → Railway → GitHub Pages)
- SSO protection auto-disable on Vercel confirmed working
- Quality review confirmed running for all completed tasks

**Issues found:**
- `toolStoreMemory` has a closure dependency on `agentDefId` (set in `main()`) — would break if tools are extracted to separate files
- Railway fallback deployment is PARTIAL — creates service + domain but needs GitHub repo connection to actually serve files

---

### Session 5: Supabase and HTTP Smoke Checks
**UUID:** `53413f1e-d394-4bed-be6c-ba79209768e8`

**What happened:**
- Verified orchestrator system prompt starts with correct "CEO's right-hand" wording
- Confirmed engineering agent row exists in `agent_definitions`
- Checked `agent_tools` assignments for Composio integrations
- Verified conversation IDs are functional
- Confirmed health endpoint and site return HTTP 200

**Key outcomes:**
- Data-driven prompts and tool assignments confirmed working in live database

---

### Session 6: Railway Worker Health Check
**UUID:** `dde8935d-4113-4f82-a330-a6ce69fd131f`

**What happened:**
- Checked `system_heartbeats` for worker health (initially used wrong column `created_at`, corrected to `last_seen_at`)
- Confirmed heartbeat timestamp is recent
- Verified Railway deployment was successful
- No stuck `running` tasks found in sample

---

### Session 7: External API Token Verification
**UUID:** `38216589-2e68-474d-a414-aa6b58808387`

**What happened:**
- Verified Vercel token — working
- Verified Composio API key — working
- Verified Anthropic API key — returned low credit balance (billing issue), not an invalid key
- Advised credential rotation after secrets were pasted in chat sessions

**Key outcomes:**
- All API tokens functional
- Anthropic billing flagged as concern
- Security recommendation: rotate credentials

---

### Session 8: Claude Managed Agents Comparison
**UUID:** `1582fb20-3450-4c44-9611-690b2a0b666b`

**What happened:**
- Compared Claude Managed Agents architecture (Anthropic's hosted agent runtime) against the current system
- Analyzed trade-offs: Managed Agents replaces infrastructure (container, loop, sandbox) but not business logic (task state machine, multi-agent delegation, quality review, memory)
- Confirmed all code is pushed to `origin/main` — zero unpushed commits
- Noted 8 untracked screenshot PNGs in repo root

**Key conclusions:**
- Managed Agents is NOT a clean replacement — it solves the infra problem, not the business logic problem
- If starting from scratch today, Managed Agents would be a good foundation for the worker/runner layer
- Given current state, migration would be a significant rewrite for incremental gains
- Biggest concrete wins from Managed Agents would be sandboxed execution and prompt caching — both achievable without migration
- Multi-agent and memory features in Managed Agents are still in "research preview" — worth revisiting when they mature

**Recommended improvements (independent of Managed Agents):**
1. Add Anthropic prompt caching to `callClaude` (cache breakpoints)
2. Add conversation compaction (summarize history when it gets long)
3. Improve sandbox security (Docker-in-Docker or Firecracker instead of bare `/tmp` dirs)

---

## Cross-Session Themes

These issues kept coming up across multiple sessions:

1. **Execution split tension** — Vercel for fast chat vs Railway for heavy agent loops. The boundary is clear in the code but confusing to newcomers. `run-agent.ts` does NOT run agents — it just triggers them.

2. **Anthropic API reliability** — Rate limits (429), server errors (5xx), and billing/credit limits are recurring concerns. The retry logic in `callClaude` handles the first two; billing needs manual monitoring.

3. **Composio app naming** — Connected account names don't always match what you'd expect. Always discover via API, never hardcode.

4. **Quality control calibration** — The review system sometimes accepts mediocre output (especially when `time_expired` with tool calls) and sometimes rejects work that's actually usable. The prompt in `reviewResult()` has been iterated several times.

5. **Frontend deployment gaps** — Some UI changes (completed tasks tab, task detail modal) were developed but not initially committed/deployed. Always verify that UI changes are built and deployed after committing.

---

## Open Items

| Item | Priority | Context |
|------|----------|---------|
| Apollo auth via Composio | High | Need to verify connected account exists and actions work for lead search |
| Prompt caching | Medium | Would significantly reduce costs on multi-turn conversations |
| Conversation compaction | Medium | Long conversations waste tokens by sending full history every turn |
| Sandbox security | Medium | Agent tasks run in bare `/tmp` dirs — should be containerized |
| Claude Managed Agents | Low | Revisit when multi-agent and memory features exit research preview |
| Screenshot PNGs cleanup | Low | 8 untracked screenshots in repo root — commit, gitignore, or delete |
| Credential rotation | Medium | API keys were pasted in Cursor sessions — should be rotated |

---

## Git State (as of April 9, 2026)

- **Branch:** `main`
- **Remote:** `origin` → `https://github.com/salisumohammed3-afk/cyber-business-os.git`
- **Status:** Up to date with `origin/main`, zero unpushed commits
- **Latest commit:** `81ee99f` — "Comprehensive README with setup guide and agent docs"
- **Untracked:** 8 screenshot PNG files in repo root

---

*Generated: April 9, 2026*
