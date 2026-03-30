// worker/index.mjs — Railway task queue worker
// Polls Supabase for pending tasks and executes them via runner.mjs
import { fork } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const RUNNER_PATH = join(__dirname, "..", "api", "agent-scripts", "runner.mjs");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "5000", 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "2", 10);
const STUCK_TIMEOUT_MIN = parseInt(process.env.STUCK_TIMEOUT_MIN || "10", 10);
const TASK_WORKDIR_ROOT = process.env.TASK_WORKDIR || "/tmp/agent-tasks";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_KEY are required");
  process.exit(1);
}

const activeTasks = new Map(); // taskId -> child process
const USE_JSON_LOG = process.env.LOG_FORMAT === "json" || process.env.NODE_ENV === "production";

function emitWorkerLog(level, message, extra = {}) {
  if (USE_JSON_LOG) {
    console.log(JSON.stringify({ level, msg: message, source: "railway-worker", ts: new Date().toISOString(), ...extra }));
  } else {
    console.log(`[${level}] ${message}`);
  }
}

// ── Supabase helpers ────────────────────────────────────────────────────────

async function sbFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...opts.headers,
  };
  const resp = await fetch(url, { ...opts, headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Supabase ${resp.status}: ${body.slice(0, 200)}`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

async function sbSelect(table, filters = {}, extra = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) params.set(k, v);
  if (extra.select) params.set("select", extra.select);
  if (extra.order) params.set("order", extra.order);
  if (extra.limit) params.set("limit", String(extra.limit));
  return sbFetch(`${table}?${params}`, { method: "GET" });
}

async function sbUpdate(table, data, filters = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) params.set(k, v);
  return sbFetch(`${table}?${params}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    headers: { Prefer: "return=representation" },
  });
}

async function sbInsert(table, data) {
  return sbFetch(table, {
    method: "POST",
    body: JSON.stringify(data),
    headers: { Prefer: "return=representation" },
  });
}

async function termLog(message, opts = {}) {
  try {
    await sbInsert("terminal_logs", {
      message,
      source: "railway-worker",
      task_id: opts.taskId || null,
      log_type: opts.logType || "info",
      company_id: opts.companyId || null,
      metadata: opts.metadata || {},
    });
  } catch {}
  emitWorkerLog(opts.logType === "error" ? "error" : "info", message, {
    log_type: opts.logType || "info",
    task_id: opts.taskId || undefined,
    company_id: opts.companyId || undefined,
    ...(opts.metadata && Object.keys(opts.metadata).length ? { metadata: opts.metadata } : {}),
  });
}

async function upsertHeartbeat(extraMeta = {}) {
  try {
    const ts = new Date().toISOString();
    const updated = await sbUpdate(
      "system_heartbeats",
      { last_seen_at: ts, metadata: extraMeta },
      { service_key: "eq.railway_worker" },
    );
    if (updated?.length) return;
    await sbInsert("system_heartbeats", {
      service_key: "railway_worker",
      last_seen_at: ts,
      metadata: extraMeta,
    });
  } catch (e) {
    emitWorkerLog("warn", "Heartbeat upsert failed: " + e.message, { log_type: "heartbeat_error" });
  }
}

async function reconcileRunnerExit(taskId, code, signal) {
  try {
    const rows = await sbSelect("tasks", { id: `eq.${taskId}` }, { select: "status,company_id", limit: 1 });
    const task = rows?.[0];
    const companyId = task?.company_id ?? null;

    const abnormalExit = signal != null || (code !== null && code !== 0);
    if (abnormalExit) {
      const exitCode = code === null ? -1 : code;
      const result = await sbUpdate(
        "tasks",
        {
          status: "failed",
          error_message:
            "Runner process exited with code " +
            exitCode +
            (signal ? " (" + signal + ")" : ""),
          completed_at: new Date().toISOString(),
        },
        { id: `eq.${taskId}`, status: "eq.running" },
      );
      if (result?.length) {
        await termLog("Runner exit reconcile: task " + taskId.slice(0, 8) + " marked failed (code " + exitCode + ")", {
          taskId,
          companyId,
          logType: "worker_exit_reconcile",
          metadata: { exit_code: exitCode, signal: signal || null },
        });
      }
      return;
    }

    setTimeout(async () => {
      try {
        const r2 = await sbSelect("tasks", { id: `eq.${taskId}` }, { select: "status,company_id", limit: 1 });
        const t2 = r2?.[0];
        if (t2?.status === "running") {
          await sbUpdate(
            "tasks",
            {
              status: "failed",
              error_message: "Runner exited 0 but task still running (worker reconciliation)",
              completed_at: new Date().toISOString(),
            },
            { id: `eq.${taskId}`, status: "eq.running" },
          );
          await termLog(
            "Runner exit reconcile: task " + taskId.slice(0, 8) + " was still running after clean exit",
            {
              taskId,
              companyId: t2.company_id,
              logType: "worker_exit_reconcile",
              metadata: { anomaly: "running_after_exit_0" },
            },
          );
        }
      } catch (e) {
        emitWorkerLog("error", "Delayed exit reconcile error: " + e.message, { task_id: taskId });
      }
    }, 5000);
  } catch (e) {
    emitWorkerLog("error", "reconcileRunnerExit: " + e.message, { task_id: taskId });
  }
}

// ── Stuck task recovery ─────────────────────────────────────────────────────

async function recoverStuckTasks() {
  const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MIN * 60 * 1000).toISOString();
  try {
    const stuck = await sbSelect("tasks", {
      status: "eq.running",
      "started_at": `lt.${cutoff}`,
    }, { select: "id,metadata", limit: 20 });

    if (!stuck?.length) return;

    for (const task of stuck) {
      if (activeTasks.has(task.id)) continue; // still running locally

      const meta = task.metadata || {};
      const retries = meta.retry_count || 0;
      const hasCheckpoint = !!meta.checkpoint;

      if (hasCheckpoint && retries < 2) {
        await sbUpdate("tasks", {
          status: "pending",
          started_at: null,
          error_message: null,
          metadata: { ...meta, retry_count: retries + 1 },
        }, { id: `eq.${task.id}` });
        await termLog(`Auto-retrying stuck task ${task.id.slice(0, 8)} (retry ${retries + 1}/2)`, {
          taskId: task.id, logType: "auto_retry",
        });
      } else {
        await sbUpdate("tasks", {
          status: "failed",
          error_message: "Timed out" + (retries > 0 ? ` after ${retries} retries` : ""),
          completed_at: new Date().toISOString(),
        }, { id: `eq.${task.id}` });
        await termLog(`Marked stuck task ${task.id.slice(0, 8)} as failed`, {
          taskId: task.id, logType: "stuck_failed",
        });
      }
    }
  } catch (e) {
    emitWorkerLog("error", "Stuck recovery error: " + e.message, { log_type: "stuck_recovery_error" });
  }
}

// ── Claim and run a task ────────────────────────────────────────────────────

async function claimTask() {
  // Atomically claim one pending task
  const pending = await sbSelect("tasks", {
    status: "eq.pending",
  }, { select: "id,conversation_id", order: "priority.desc,created_at.asc", limit: 1 });

  if (!pending?.length) return null;

  const task = pending[0];

  // Ensure a conversation exists
  let conversationId = task.conversation_id;
  if (!conversationId) {
    const conv = await sbInsert("conversations", {
      title: task.id.slice(0, 8) + " task",
    });
    if (conv?.[0]?.id) {
      conversationId = conv[0].id;
      await sbUpdate("tasks", { conversation_id: conversationId }, { id: `eq.${task.id}` });
    }
  }

  // Try to claim it (CAS: only update if still pending)
  const claimed = await sbUpdate("tasks", {
    status: "running",
    started_at: new Date().toISOString(),
  }, { id: `eq.${task.id}`, status: "eq.pending" });

  if (!claimed?.length) return null; // someone else claimed it

  return { taskId: task.id, conversationId };
}

function runTask(taskId, conversationId) {
  const workdir = join(TASK_WORKDIR_ROOT, taskId);
  if (!existsSync(workdir)) mkdirSync(workdir, { recursive: true });

  const env = {
    ...process.env,
    TASK_ID: taskId,
    CONVERSATION_ID: conversationId,
    TASK_WORKDIR: workdir,
  };

  const child = fork(RUNNER_PATH, [], {
    cwd: workdir,
    env,
    stdio: "pipe",
  });

  activeTasks.set(taskId, child);

  child.stdout?.on("data", (d) => process.stdout.write(`[${taskId.slice(0, 8)}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[${taskId.slice(0, 8)}] ${d}`));

  child.on("exit", (code, signal) => {
    activeTasks.delete(taskId);
    // Clean up workdir
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
    emitWorkerLog("info", `Child ${taskId.slice(0, 8)} exited code ${code}`, {
      task_id: taskId,
      log_type: "worker_child_exit",
      exit_code: code,
      signal: signal || undefined,
    });
    void reconcileRunnerExit(taskId, code, signal);
  });

  child.on("error", (err) => {
    activeTasks.delete(taskId);
    emitWorkerLog("error", `Child ${taskId.slice(0, 8)} process error: ` + err.message, {
      task_id: taskId,
      log_type: "worker_child_error",
    });
  });

  return child;
}

// ── Main poll loop ──────────────────────────────────────────────────────────

let running = true;
let pollCount = 0;

async function poll() {
  // Recover stuck tasks every 10th poll
  if (pollCount % 10 === 0) {
    await recoverStuckTasks();
  }
  pollCount++;

  if (pollCount % 5 === 0) {
    void upsertHeartbeat({ poll_count: pollCount, active_tasks: activeTasks.size });
  }

  if (activeTasks.size >= MAX_CONCURRENT) return;

  const slots = MAX_CONCURRENT - activeTasks.size;
  for (let i = 0; i < slots; i++) {
    try {
      const claimed = await claimTask();
      if (!claimed) break; // no more pending tasks
      await termLog(`Claimed task ${claimed.taskId.slice(0, 8)}, starting runner`, {
        taskId: claimed.taskId, logType: "worker_claimed",
      });
      runTask(claimed.taskId, claimed.conversationId);
    } catch (e) {
      emitWorkerLog("error", "Poll error: " + e.message, { log_type: "poll_error" });
      break;
    }
  }
}

async function main() {
  emitWorkerLog("info", "Railway worker starting", {
    poll_interval_ms: POLL_INTERVAL,
    max_concurrent: MAX_CONCURRENT,
    stuck_timeout_min: STUCK_TIMEOUT_MIN,
    runner_path: RUNNER_PATH,
    json_log: USE_JSON_LOG,
  });

  if (!existsSync(TASK_WORKDIR_ROOT)) mkdirSync(TASK_WORKDIR_ROOT, { recursive: true });

  await termLog("Railway worker started", { logType: "worker_start" });
  void upsertHeartbeat({ boot: true });

  while (running) {
    try {
      await poll();
    } catch (e) {
      emitWorkerLog("error", "Poll loop error: " + e.message, { log_type: "poll_loop_error" });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

process.on("SIGTERM", async () => {
  emitWorkerLog("info", "SIGTERM received, shutting down", { log_type: "worker_stop" });
  running = false;
  await termLog("Railway worker shutting down (SIGTERM)", { logType: "worker_stop" });
  // Give running tasks 30s to finish
  if (activeTasks.size > 0) {
    emitWorkerLog("info", `Waiting for ${activeTasks.size} active task(s)...`, { log_type: "worker_drain" });
    await new Promise((r) => setTimeout(r, 30_000));
  }
  process.exit(0);
});

process.on("SIGINT", () => {
  running = false;
  process.exit(0);
});

main().catch((e) => {
  emitWorkerLog("error", "Worker fatal: " + (e.message || String(e)), { log_type: "worker_fatal" });
  process.exit(1);
});
