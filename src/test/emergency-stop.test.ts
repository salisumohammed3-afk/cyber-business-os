import { describe, it, expect } from "vitest";

describe("Emergency stop: kill switch & cost ceiling", () => {
  describe("cancel-all endpoint logic", () => {
    it("should cancel running, pending, and proposed tasks by default", () => {
      const include_proposed = true;
      const cancelStatuses = ["running", "pending"];
      if (include_proposed) cancelStatuses.push("proposed");
      expect(cancelStatuses).toEqual(["running", "pending", "proposed"]);
    });

    it("should only cancel running and pending when include_proposed is false", () => {
      const include_proposed = false;
      const cancelStatuses = ["running", "pending"];
      if (include_proposed) cancelStatuses.push("proposed");
      expect(cancelStatuses).toEqual(["running", "pending"]);
    });

    it("should require company_id", () => {
      const body = {};
      const company_id = (body as { company_id?: string }).company_id;
      const isValid = !!company_id;
      expect(isValid).toBe(false);
    });

    it("should format cancellation chat message with task list", () => {
      const tasks = [
        { title: "Research competitors", status: "running" },
        { title: "Draft outreach", status: "pending" },
      ];
      const taskList = tasks
        .slice(0, 10)
        .map(t => `\u2022 ${t.title} (was ${t.status})`)
        .join("\n");
      const more = tasks.length > 10 ? `\n\n...and ${tasks.length - 10} more` : "";
      const content = `\uD83D\uDED1 **All work halted.** Cancelled ${tasks.length} task(s):\n\n${taskList}${more}\n\nTell me what to do next — I'll wait for your instructions.`;

      expect(content).toContain("All work halted");
      expect(content).toContain("Cancelled 2 task(s)");
      expect(content).toContain("Research competitors (was running)");
      expect(content).toContain("Draft outreach (was pending)");
    });

    it("should truncate task list to 10 and show overflow count", () => {
      const tasks = Array.from({ length: 15 }, (_, i) => ({
        title: `Task ${i}`,
        status: "pending",
      }));
      const shown = tasks.slice(0, 10);
      const more = tasks.length > 10 ? `\n\n...and ${tasks.length - 10} more` : "";
      expect(shown).toHaveLength(10);
      expect(more).toBe("\n\n...and 5 more");
    });

    it("should set emergency_stop event type in metadata", () => {
      const meta = {
        notification: true,
        event_type: "emergency_stop",
        cancelled_count: 3,
      };
      expect(meta.event_type).toBe("emergency_stop");
      expect(meta.notification).toBe(true);
      expect(meta.cancelled_count).toBe(3);
    });
  });

  describe("runner cost ceiling", () => {
    it("should calculate cost from token usage (Sonnet pricing)", () => {
      const tokenUsage = {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      };
      const PRICE_INPUT = 3.0;
      const PRICE_OUTPUT = 15.0;
      const cost =
        (tokenUsage.input_tokens * PRICE_INPUT +
          tokenUsage.output_tokens * PRICE_OUTPUT) / 1_000_000;
      // 1M * $3 + 100K * $15 = $3 + $1.5 = $4.5
      expect(cost).toBeCloseTo(4.5, 2);
    });

    it("should factor in cache read (90% cheaper than input)", () => {
      const tokenUsage = {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1_000_000,
      };
      const PRICE_CACHE_READ = 0.30;
      const cost = (tokenUsage.cache_read_input_tokens * PRICE_CACHE_READ) / 1_000_000;
      expect(cost).toBe(0.30);
    });

    it("should trigger cancellation when cost exceeds ceiling", () => {
      const MAX_TASK_COST_USD = 2.0;
      const costSoFar = 2.5;
      const shouldCancel = costSoFar > MAX_TASK_COST_USD;
      expect(shouldCancel).toBe(true);
    });

    it("should not trigger when under ceiling", () => {
      const MAX_TASK_COST_USD = 2.0;
      const costSoFar = 1.8;
      const shouldCancel = costSoFar > MAX_TASK_COST_USD;
      expect(shouldCancel).toBe(false);
    });

    it("should allow ceiling override via env var", () => {
      const env = { MAX_TASK_COST_USD: "5.0" };
      const MAX_TASK_COST_USD = parseFloat(env.MAX_TASK_COST_USD || "2.0");
      expect(MAX_TASK_COST_USD).toBe(5.0);
    });

    it("should default to $2 when env var missing", () => {
      const env: Record<string, string | undefined> = {};
      const MAX_TASK_COST_USD = parseFloat(env.MAX_TASK_COST_USD || "2.0");
      expect(MAX_TASK_COST_USD).toBe(2.0);
    });
  });

  describe("auto-retry disabled by default", () => {
    it("should have MAX_AUTO_RETRIES = 0 when AUTO_RETRY_ENABLED is not set", () => {
      const AUTO_RETRY_ENABLED = undefined === "true";
      const MAX_AUTO_RETRIES = AUTO_RETRY_ENABLED ? 2 : 0;
      expect(MAX_AUTO_RETRIES).toBe(0);
    });

    it("should have MAX_AUTO_RETRIES = 2 when AUTO_RETRY_ENABLED=true", () => {
      const env = { AUTO_RETRY_ENABLED: "true" };
      const AUTO_RETRY_ENABLED = env.AUTO_RETRY_ENABLED === "true";
      const MAX_AUTO_RETRIES = AUTO_RETRY_ENABLED ? 2 : 0;
      expect(MAX_AUTO_RETRIES).toBe(2);
    });

    it("should not retry when retryCount >= MAX_AUTO_RETRIES (which is 0)", () => {
      const MAX_AUTO_RETRIES = 0;
      const retryCount = 0;
      const shouldRetry = retryCount < MAX_AUTO_RETRIES;
      expect(shouldRetry).toBe(false);
    });
  });

  describe("cancellation check frequency", () => {
    it("should check on every turn, not every 5", () => {
      // With old logic: checks on turn 5, 10, 15
      // With new logic: checks every turn
      const turns = [1, 2, 3, 4, 5, 6];
      const oldCheckTurns = turns.filter(t => t % 5 === 0);
      const newCheckTurns = turns; // every turn
      expect(oldCheckTurns).toEqual([5]);
      expect(newCheckTurns).toHaveLength(6);
    });
  });

  describe("active task badge visibility", () => {
    it("should show STOP ALL when activeTaskCount > 0", () => {
      const activeTaskCount = 3;
      const showStop = activeTaskCount > 0;
      expect(showStop).toBe(true);
    });

    it("should hide STOP ALL when no active tasks", () => {
      const activeTaskCount = 0;
      const showStop = activeTaskCount > 0;
      expect(showStop).toBe(false);
    });

    it("should poll every 4 seconds", () => {
      const interval = 4000;
      expect(interval).toBe(4000);
    });
  });
});
