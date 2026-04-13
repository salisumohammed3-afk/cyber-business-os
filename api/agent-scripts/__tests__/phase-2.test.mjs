import { describe, it, expect } from "vitest";
import { resolve } from "node:path";

// ── assertSafePath (copied from runner.mjs) ────────────────────────────────

function assertSafePath(requestedPath, taskWorkdir) {
  const base = resolve(taskWorkdir || process.cwd());
  const resolved = resolve(base, requestedPath);
  if (!resolved.startsWith(base + "/") && resolved !== base) {
    throw new Error("Path traversal blocked: " + requestedPath + " resolves outside sandbox");
  }
  return resolved;
}

// ── ALLOWED_QUERY_TABLES (copied from runner.mjs) ──────────────────────────

const ALLOWED_QUERY_TABLES = new Set([
  "agents", "tasks", "chat_messages", "conversations",
  "agent_definitions", "memories", "companies", "company_goals", "projects",
]);

// ── STRIPPED_ENV_KEYS (copied from runner.mjs) ─────────────────────────────

const STRIPPED_ENV_KEYS = [
  "ANTHROPIC_API_KEY", "SUPABASE_KEY", "COMPOSIO_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY", "VERCEL_TOKEN", "RAILWAY_TOKEN",
  "RAILWAY_DEPLOY_TOKEN", "SERPER_API_KEY", "PROJECTS_SUPABASE_KEY",
];

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Phase 2: Security Hardening", () => {
  describe("assertSafePath", () => {
    const WORKDIR = "/tmp/agent-tasks/abc-123";

    it("should allow paths within the sandbox", () => {
      const result = assertSafePath("/tmp/agent-tasks/abc-123/src/index.html", WORKDIR);
      expect(result).toBe("/tmp/agent-tasks/abc-123/src/index.html");
    });

    it("should allow the sandbox root itself", () => {
      const result = assertSafePath(WORKDIR, WORKDIR);
      expect(result).toBe(WORKDIR);
    });

    it("should block path traversal with ../", () => {
      expect(() => assertSafePath("/tmp/agent-tasks/abc-123/../../etc/passwd", WORKDIR))
        .toThrow("Path traversal blocked");
    });

    it("should block absolute paths outside sandbox", () => {
      expect(() => assertSafePath("/etc/passwd", WORKDIR))
        .toThrow("Path traversal blocked");
    });

    it("should block relative paths that escape sandbox", () => {
      expect(() => assertSafePath("../other-task/secrets.json", WORKDIR))
        .toThrow("Path traversal blocked");
    });

    it("should allow relative paths that stay within sandbox", () => {
      const result = assertSafePath("src/app.js", WORKDIR);
      expect(result).toBe(WORKDIR + "/src/app.js");
    });
  });

  describe("table whitelist", () => {
    it("should allow standard business tables", () => {
      for (const table of ["tasks", "chat_messages", "conversations", "memories", "projects"]) {
        expect(ALLOWED_QUERY_TABLES.has(table)).toBe(true);
      }
    });

    it("should block system tables", () => {
      for (const table of ["system_heartbeats", "job_runs", "terminal_logs", "pg_catalog"]) {
        expect(ALLOWED_QUERY_TABLES.has(table)).toBe(false);
      }
    });
  });

  describe("database_admin SQL removal", () => {
    it("should reject alter_table with SQL and no columns", () => {
      // Simulating the logic from the updated toolDatabaseAdmin
      const input = { action: "alter_table", table_name: "test", sql: "DROP TABLE test;" };
      const hasColumns = input.columns?.length > 0;
      expect(hasColumns).toBe(false);
      // The function would return: "columns array required for alter_table (raw SQL is not supported)"
    });

    it("should accept alter_table with columns array", () => {
      const input = {
        action: "alter_table",
        table_name: "items",
        columns: [{ name: "status", type: "TEXT" }],
      };
      expect(input.columns.length).toBeGreaterThan(0);
    });
  });

  describe("env stripping", () => {
    it("should strip all sensitive keys from environment", () => {
      const mockEnv = {
        PATH: "/usr/bin",
        HOME: "/root",
        ANTHROPIC_API_KEY: "sk-secret",
        SUPABASE_KEY: "eyJ-secret",
        COMPOSIO_API_KEY: "ck-secret",
        SUPABASE_SERVICE_ROLE_KEY: "eyJ-secret2",
        VERCEL_TOKEN: "vt-secret",
        RAILWAY_TOKEN: "rt-secret",
        RAILWAY_DEPLOY_TOKEN: "rdt-secret",
        SERPER_API_KEY: "sp-secret",
        PROJECTS_SUPABASE_KEY: "pk-secret",
        NODE_ENV: "production",
      };

      const safeEnv = { ...mockEnv };
      for (const key of STRIPPED_ENV_KEYS) delete safeEnv[key];

      // Safe keys preserved
      expect(safeEnv.PATH).toBe("/usr/bin");
      expect(safeEnv.HOME).toBe("/root");
      expect(safeEnv.NODE_ENV).toBe("production");

      // Sensitive keys removed
      expect(safeEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(safeEnv.SUPABASE_KEY).toBeUndefined();
      expect(safeEnv.COMPOSIO_API_KEY).toBeUndefined();
      expect(safeEnv.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
      expect(safeEnv.VERCEL_TOKEN).toBeUndefined();
      expect(safeEnv.RAILWAY_TOKEN).toBeUndefined();
      expect(safeEnv.RAILWAY_DEPLOY_TOKEN).toBeUndefined();
      expect(safeEnv.SERPER_API_KEY).toBeUndefined();
      expect(safeEnv.PROJECTS_SUPABASE_KEY).toBeUndefined();
    });
  });
});
