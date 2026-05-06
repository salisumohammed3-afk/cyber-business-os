// worker/launcher.mjs — runs both the task poller (index.mjs) and the
// orchestrator HTTP server (orchestrator.mjs) inside one Railway container.
//
// Why one container, not two services: Sal already has a Railway worker
// service deployed. Adding a second service is friction (separate dashboard
// setup, separate env vars). One container with two processes keeps the
// blast radius small. If they need to split later, they split later.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const procs = [
  { name: "task-poller",  script: join(__dirname, "index.mjs") },
  { name: "orchestrator", script: join(__dirname, "orchestrator.mjs") },
];

function start(p) {
  console.log(`[launcher] starting ${p.name}`);
  const child = spawn("node", [p.script], { stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    console.error(`[launcher] ${p.name} exited code=${code} signal=${signal}, restarting in 2s`);
    setTimeout(() => start(p), 2000);
  });
  return child;
}

procs.forEach(start);

// Forward signals so Railway's stop signal hits both children.
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
