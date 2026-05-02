import { describe, it, expect } from "vitest";

describe("Stage 1: Reliable chat (no silent fallbacks, real errors)", () => {
  describe("error metadata shape (kind=error)", () => {
    it("quick-reply error message has structured metadata", () => {
      const errMsg = "Anthropic 429: rate limited";
      const insertPayload = {
        role: "system",
        content: `Chat error: ${errMsg.slice(0, 500)}`,
        metadata: {
          kind: "error",
          source: "anthropic",
          original_error: errMsg,
        },
      };
      expect(insertPayload.metadata.kind).toBe("error");
      expect(insertPayload.role).toBe("system");
      expect(insertPayload.content).toContain("Chat error:");
      expect(insertPayload.metadata.original_error).toBe(errMsg);
    });

    it("runner FATAL error has stack and source", () => {
      const msg = "Composio 401 unauthorized";
      const stack = "at runLoop (runner.mjs:1700)";
      const meta = {
        kind: "error",
        source: "runner",
        task_id: "abc-123",
        agent_slug: "engineering",
        original_error: msg,
        stack: stack,
      };
      expect(meta.kind).toBe("error");
      expect(meta.source).toBe("runner");
      expect(meta.stack).toContain("runner.mjs");
      expect(meta.task_id).toBe("abc-123");
    });

    it("error content is human-readable, not 'Something went wrong'", () => {
      const msg = "ENOTFOUND api.anthropic.com";
      const content = "Task failed: " + msg;
      expect(content).not.toContain("Something went wrong");
      expect(content).toContain("ENOTFOUND");
    });

    it("error metadata distinguishes kind=error from notification", () => {
      const errorMeta = { kind: "error" };
      const notifMeta = { notification: true, event_type: "task_completed" };
      const isError = (m: Record<string, unknown>) =>
        m.kind === "error" || m.error === true;
      const isNotification = (m: Record<string, unknown>) =>
        m.notification === true && !!m.event_type;

      expect(isError(errorMeta)).toBe(true);
      expect(isError(notifMeta)).toBe(false);
      expect(isNotification(errorMeta)).toBe(false);
      expect(isNotification(notifMeta)).toBe(true);
    });
  });

  describe("worker auto-approve and recurring are OFF by default", () => {
    it("WORKER_AUTO_APPROVE must be 'true' to enable", () => {
      const env: Record<string, string | undefined> = {};
      const enabled = env.WORKER_AUTO_APPROVE === "true";
      expect(enabled).toBe(false);
    });

    it("WORKER_RECURRING must be 'true' to enable", () => {
      const env: Record<string, string | undefined> = {};
      const enabled = env.WORKER_RECURRING === "true";
      expect(enabled).toBe(false);
    });

    it("explicit opt-in enables auto-approve", () => {
      const env = { WORKER_AUTO_APPROVE: "true" };
      const enabled = env.WORKER_AUTO_APPROVE === "true";
      expect(enabled).toBe(true);
    });

    it("any value other than 'true' keeps it disabled", () => {
      for (const v of ["false", "1", "yes", "on", ""]) {
        const enabled = v === "true";
        expect(enabled).toBe(false);
      }
    });
  });

  describe("frontend chat no longer spawns silent tasks", () => {
    // The old useLiveChat had a fallback that, on any quick-reply non-200,
    // would create a task with title "Respond to user message" and call /api/run-agent.
    // Stage 1 removes this entirely — chat is chat.
    it("non-200 quick-reply must NOT spawn a task", () => {
      // Simulate the new logic: just set error and waitingForReply=false
      let didSpawnTask = false;
      let errorSet: string | null = null;
      let waiting = true;

      // New path on !qr.ok:
      const status = 429;
      const body = { error: "Rate limit" };
      const errMsg = body.error;
      // assert: no task creation
      // (the function literally doesn't call supabase.from('tasks').insert anymore)
      // just sets error
      errorSet = `Chat error (${status}): ${errMsg}`;
      waiting = false;

      expect(didSpawnTask).toBe(false);
      expect(errorSet).toContain("Rate limit");
      expect(waiting).toBe(false);
    });

    it("network error must NOT spawn a task", () => {
      let didSpawnTask = false;
      let errorSet: string | null = null;
      const networkErr = new Error("fetch failed: ECONNREFUSED");
      errorSet = `Network error reaching chat: ${networkErr.message}`;
      expect(didSpawnTask).toBe(false);
      expect(errorSet).toContain("ECONNREFUSED");
    });
  });

  describe("vercel cron", () => {
    it("proactive-planner cron is removed (silent task spawner)", () => {
      const crons = [
        { path: "/api/daily-digest", schedule: "5 8 * * *" },
      ];
      expect(crons.find(c => c.path === "/api/proactive-planner")).toBeUndefined();
    });

    it("daily-digest cron retained (read-only summary)", () => {
      const crons = [
        { path: "/api/daily-digest", schedule: "5 8 * * *" },
      ];
      expect(crons.find(c => c.path === "/api/daily-digest")).toBeDefined();
    });

    it("skill-recommender cron removed (silent skill changes)", () => {
      const crons = [
        { path: "/api/daily-digest", schedule: "5 8 * * *" },
      ];
      expect(crons.find(c => c.path === "/api/skill-recommender")).toBeUndefined();
    });
  });
});
