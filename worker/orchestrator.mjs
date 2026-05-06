// worker/orchestrator.mjs — Long-running HTTP orchestrator on Railway.
//
// Sal's instruction (verbatim, 2026-05-06):
//   "There should be nothing you need to add. No run agent, no do this, no
//    do that. If you can do it, it should be able to do it."
//   "Maybe the Vercel function needs to talk to an actual orchestrator that
//    actually has everything you have […]. Maybe that's the option, and
//    actually the Vercel function is just a conduit to the orchestrator."
//
// This file is the FOUNDATION of that rebuild. It is a thin Node HTTP server
// that:
//
//   1. Accepts a chat turn from the Vercel conduit (POST /chat).
//   2. Loads conversation history from Supabase.
//   3. Calls Claude Opus 4.7 with a tool-use loop.
//   4. Exposes one meta-tool — `bash` — that gives the orchestrator the same
//      shell access I have. Everything else (read/write/edit files, git,
//      curl, gh CLI, supabase CLI, npm, deploy) is reachable via bash.
//   5. Also exposes `supabase_sql` for direct DB reads/writes that don't
//      want to go through bash + curl plumbing.
//   6. Persists the assistant reply to chat_messages so the FE realtime
//      subscription picks it up.
//
// Deployment
// ----------
// Runs as a Railway service. Same container image as the existing
// worker/index.mjs poller — both are launched by worker/launcher.mjs. Railway
// gives the container a public URL; Sal sets that URL as
// ORCHESTRATOR_WORKER_URL on Vercel and the conduit (api/quick-reply.ts)
// forwards chat turns here.
//
// What's scaffolded vs. what's left
// ---------------------------------
// Scaffolded:
//   - HTTP server, chat-turn loop, bash + supabase_sql tools, message persist.
//   - Cliffhanger detection (one nudge retry).
//   - Realtime back to FE via chat_messages INSERT.
//
// Not yet ported (still served by api/quick-reply.ts as fallback):
//   - Work-order proposal flow ([PROPOSE_WORK_ORDER]).
//   - Integration-add proposal flow.
//   - Schedule proposal flow.
//   - The full CHAT_TOOLS list (cancel_tasks, delete_tasks, run_agent, etc.).
//
// The orchestrator is expected to grow these itself by editing this file via
// bash and pushing. That's the whole point of the rebuild.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Railway injects $PORT for the public port. Fall back to ORCHESTRATOR_PORT
// (set in the Dockerfile) for local runs.
const PORT = parseInt(process.env.PORT || process.env.ORCHESTRATOR_PORT || "3000", 10);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ORCHESTRATOR_MODEL = process.env.ORCHESTRATOR_MODEL || "claude-opus-4-7";
const WORKSPACE = process.env.ORCHESTRATOR_WORKSPACE || "/workspace";
const MAX_TOOL_TURNS = parseInt(process.env.MAX_TOOL_TURNS || "12", 10);
const BASH_TIMEOUT_MS = parseInt(process.env.BASH_TIMEOUT_MS || "60000", 10);
const BASH_MAX_OUTPUT = parseInt(process.env.BASH_MAX_OUTPUT || "16000", 10);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("[orchestrator] SUPABASE_URL and SUPABASE_KEY are required");
  process.exit(1);
}
if (!ANTHROPIC_KEY) {
  console.error("[orchestrator] ANTHROPIC_API_KEY is required");
  process.exit(1);
}

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ level, msg, source: "orchestrator", ts: new Date().toISOString(), ...extra }));
}

// ── Supabase REST helpers ───────────────────────────────────────────────────

async function sb(path, opts = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Supabase ${resp.status}: ${body.slice(0, 200)}`);
  }
  const txt = await resp.text();
  return txt ? JSON.parse(txt) : null;
}

async function loadOrchestratorPrompt(companyId) {
  // Pull the orchestrator's system_prompt from agent_definitions. Same
  // source of truth as the Vercel conduit uses today.
  const params = new URLSearchParams({
    select: "system_prompt",
    company_id: `eq.${companyId}`,
    slug: "eq.orchestrator",
  });
  const rows = await sb(`agent_definitions?${params}`);
  return rows?.[0]?.system_prompt || "You are an orchestrator agent.";
}

async function loadHistory(conversationId, limit = 60) {
  const params = new URLSearchParams({
    select: "role,kind,content,created_at",
    conversation_id: `eq.${conversationId}`,
    order: "created_at.asc",
    limit: String(limit),
  });
  return sb(`chat_messages?${params}`);
}

async function persistAssistant(conversationId, content, kind = "reply", metadata = {}) {
  await sb("chat_messages", {
    method: "POST",
    body: JSON.stringify({
      conversation_id: conversationId,
      role: "assistant",
      kind,
      content,
      metadata,
    }),
  });
}

// ── Tools ───────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "bash",
    description:
      "Run a shell command on the orchestrator's Railway container. The container has git, curl, gh CLI, node, npm, and a clone of the cyber-business-os repo at /workspace. " +
      "This is the meta-tool — anything you can do with a shell, you can do here. To self-modify: cd /workspace, edit files, git commit, git push origin main. Vercel auto-deploys on push.\n\n" +
      "Output is capped at " + BASH_MAX_OUTPUT + " chars and the command times out at " + (BASH_TIMEOUT_MS / 1000) + "s. " +
      "Set `cwd` to override the working directory (defaults to " + WORKSPACE + ").",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute (passed to /bin/sh -c)." },
        cwd: { type: "string", description: "Working directory. Defaults to " + WORKSPACE + "." },
      },
      required: ["command"],
    },
  },
  {
    name: "supabase_sql",
    description:
      "Run SQL against the project's Postgres. Goes through the Supabase REST RPC `execute_sql` if present, else falls back to PostgREST table reads. " +
      "Use this for direct DB reads/writes that would be ugly through bash + curl. The orchestrator runs with the service-role key, so RLS does not apply.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL to execute. Single statement; multi-statement via semicolons works only if your RPC supports it." },
      },
      required: ["sql"],
    },
  },
  {
    name: "send_partial",
    description:
      "Stream a partial reply to the user mid-turn so they see progress. Persists a chat_messages row with kind='reply'. Use sparingly — only when a tool call is going to take a while and the user would otherwise see a blank UI.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    },
  },
];

async function runBash(input) {
  const cmd = String(input?.command || "").trim();
  if (!cmd) return JSON.stringify({ error: "command is required" });
  const cwd = input?.cwd || WORKSPACE;
  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", cmd], {
      cwd,
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    });
    const out = (stdout || "").slice(0, BASH_MAX_OUTPUT);
    const err = (stderr || "").slice(0, 4000);
    return JSON.stringify({ ok: true, stdout: out, stderr: err, truncated: (stdout || "").length > BASH_MAX_OUTPUT });
  } catch (e) {
    return JSON.stringify({
      ok: false,
      error: String(e?.message || e).slice(0, 2000),
      stdout: (e?.stdout || "").slice(0, BASH_MAX_OUTPUT),
      stderr: (e?.stderr || "").slice(0, 4000),
      code: e?.code,
    });
  }
}

async function runSupabaseSql(input) {
  const sql = String(input?.sql || "").trim();
  if (!sql) return JSON.stringify({ error: "sql is required" });
  // Try the RPC pattern first — works if the project has an `execute_sql`
  // function deployed. If not, return a clear error so the orchestrator
  // knows to fall back to bash + curl PostgREST.
  try {
    const data = await sb("rpc/execute_sql", {
      method: "POST",
      body: JSON.stringify({ query: sql }),
    });
    return JSON.stringify({ ok: true, data });
  } catch (e) {
    return JSON.stringify({
      ok: false,
      error: String(e?.message || e).slice(0, 1000),
      hint: "If execute_sql RPC is missing, use bash with curl against /rest/v1/<table> directly.",
    });
  }
}

async function runSendPartial(conversationId, input) {
  const text = String(input?.text || "").trim();
  if (!text) return JSON.stringify({ error: "text is required" });
  await persistAssistant(conversationId, text, "reply", { partial: true });
  return JSON.stringify({ ok: true });
}

async function dispatchTool(name, input, ctx) {
  if (name === "bash") return runBash(input);
  if (name === "supabase_sql") return runSupabaseSql(input);
  if (name === "send_partial") return runSendPartial(ctx.conversationId, input);
  return JSON.stringify({ error: `Unknown tool: ${name}` });
}

// ── Anthropic call ──────────────────────────────────────────────────────────

async function callClaude({ system, messages }) {
  const supportsTemperature = !(ORCHESTRATOR_MODEL.includes("opus-4-7") || ORCHESTRATOR_MODEL.includes("opus-4-8"));
  const body = {
    model: ORCHESTRATOR_MODEL,
    max_tokens: 4096,
    system,
    messages,
    tools: TOOLS,
    ...(supportsTemperature ? { temperature: 0.7 } : {}),
  };
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(`Anthropic ${resp.status}: ${errBody.slice(0, 400)}`);
  }
  return resp.json();
}

// ── Cliffhanger detection (mirrors quick-reply.ts) ──────────────────────────

function looksLikeCliffhanger(text) {
  const t = (text || "").trim();
  if (t.length === 0) return false;
  if (/[:`,—–-]\s*$/.test(t)) return true;
  if (/[({[]\s*$/.test(t)) return true;
  if (/\*\*\s*$/.test(t)) return true;
  if (/\b(let me check|let me look|let me verify|let me grab|let me pull|i'?ll check|i'?ll look|i'?ll verify|one moment|hold on|checking now|looking that up|give me a sec|on it now)\b[^.!?]*$/i.test(t)) {
    return true;
  }
  return false;
}

// ── Chat turn handler ───────────────────────────────────────────────────────

async function handleChatTurn(payload) {
  const { company_id, conversation_id, user_message, attachments } = payload;
  if (!company_id || !conversation_id || !user_message) {
    throw new Error("company_id, conversation_id, and user_message are required");
  }

  // Persist the user message first so realtime sees it immediately.
  await sb("chat_messages", {
    method: "POST",
    body: JSON.stringify({
      conversation_id,
      role: "user",
      kind: "user_msg",
      content: user_message,
      metadata: attachments?.length ? { attachments } : {},
    }),
  });

  const system = await loadOrchestratorPrompt(company_id);
  const history = await loadHistory(conversation_id);

  const messages = (history || []).map(row => {
    if (row.role === "user") {
      return { role: "user", content: row.content || "" };
    }
    return { role: "assistant", content: row.content || "" };
  });

  let nudged = false;
  let toolTurns = 0;
  let finalText = "";

  while (toolTurns <= MAX_TOOL_TURNS) {
    const data = await callClaude({ system, messages });
    const blocks = data.content || [];
    const stopReason = data.stop_reason;
    const toolUses = blocks.filter(b => b.type === "tool_use");
    const textBlocks = blocks.filter(b => b.type === "text");
    const text = textBlocks.map(b => b.text).join("\n").trim();

    const stopping = stopReason !== "tool_use" || toolUses.length === 0 || toolTurns >= MAX_TOOL_TURNS;
    if (stopping) {
      if (looksLikeCliffhanger(text) && !nudged && stopReason !== "tool_use") {
        nudged = true;
        messages.push({ role: "assistant", content: blocks });
        messages.push({
          role: "user",
          content: "Continue your previous response — finish what you started. Do not promise to check something without doing it. Either call the tool you were going to call, or give a complete answer now.",
        });
        continue;
      }
      finalText = text || "Sorry, I couldn't generate a reply.";
      break;
    }

    messages.push({ role: "assistant", content: blocks });
    const toolResults = [];
    for (const tu of toolUses) {
      const result = await dispatchTool(tu.name, tu.input, { conversationId: conversation_id, companyId: company_id });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: result.slice(0, 12000),
      });
    }
    messages.push({ role: "user", content: toolResults });
    toolTurns++;
  }

  await persistAssistant(conversation_id, finalText, "reply", { source: "orchestrator-worker" });
  return { reply: finalText };
}

// ── HTTP server ─────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Conduit-Secret");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: true, service: "orchestrator", model: ORCHESTRATOR_MODEL, workspace: WORKSPACE }));
  }

  if (req.method === "POST" && req.url === "/chat") {
    const expectedSecret = process.env.CONDUIT_SECRET;
    if (expectedSecret && req.headers["x-conduit-secret"] !== expectedSecret) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    try {
      const payload = await readBody(req);
      log("info", "chat turn", { conversation_id: payload.conversation_id, company_id: payload.company_id });
      const result = await handleChatTurn(payload);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(result));
    } catch (e) {
      log("error", "chat turn failed", { err: String(e?.message || e) });
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
  log("info", `orchestrator listening on :${PORT}`, { model: ORCHESTRATOR_MODEL, workspace: WORKSPACE });
});

// Graceful shutdown
process.on("SIGTERM", () => { log("info", "SIGTERM, closing"); server.close(() => process.exit(0)); });
process.on("SIGINT", () => { log("info", "SIGINT, closing"); server.close(() => process.exit(0)); });
