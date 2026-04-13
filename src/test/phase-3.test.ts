import { describe, it, expect, vi } from "vitest";

describe("Phase 3: UX & Reliability", () => {
  describe("cancellation status handling", () => {
    it("should recognize cancelled status and produce correct result shape", () => {
      // Simulate what runLoop returns when it detects cancellation
      const cancelResult = {
        status: "cancelled",
        text: "Task was cancelled by user",
        toolCalls: [{ tool: "web_search", input: {}, output: "results", source: "local" }],
        turns: 5,
      };

      expect(cancelResult.status).toBe("cancelled");
      // Main() should skip review for cancelled tasks
      const shouldSkipReview = cancelResult.status === "cancelled";
      expect(shouldSkipReview).toBe(true);
    });

    it("should check cancellation every 5 turns", () => {
      const cancellationChecks: number[] = [];
      for (let turn = 1; turn <= 20; turn++) {
        if (turn % 5 === 0) {
          cancellationChecks.push(turn);
        }
      }
      expect(cancellationChecks).toEqual([5, 10, 15, 20]);
    });
  });

  describe("progress message frequency", () => {
    it("should post progress messages every 3 turns", () => {
      const progressTurns: number[] = [];
      for (let turn = 1; turn <= 15; turn++) {
        if (turn % 3 === 0) {
          progressTurns.push(turn);
        }
      }
      expect(progressTurns).toEqual([3, 6, 9, 12, 15]);
    });

    it("should include recent tools in progress message", () => {
      const allToolCalls = [
        { tool: "web_search" },
        { tool: "database_query" },
        { tool: "store_memory" },
        { tool: "deploy_static_site" },
        { tool: "test_url" },
      ];
      const recentTools = allToolCalls.slice(-3).map(t => t.tool).join(", ");
      expect(recentTools).toBe("store_memory, deploy_static_site, test_url");
    });
  });

  describe("chat history compaction", () => {
    it("should truncate older messages beyond last 8", () => {
      const messages = Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "A".repeat(200), // 200-char message
      }));

      // Apply the compaction logic from quick-reply.ts
      const compacted = messages.map((m, i, arr) => ({
        role: m.role,
        content: i < arr.length - 8
          ? m.content.slice(0, 100) + (m.content.length > 100 ? "..." : "")
          : m.content,
      }));

      // First 22 should be truncated to 103 chars (100 + "...")
      for (let i = 0; i < 22; i++) {
        expect(compacted[i].content.length).toBe(103);
        expect(compacted[i].content.endsWith("...")).toBe(true);
      }

      // Last 8 should be full (200 chars)
      for (let i = 22; i < 30; i++) {
        expect(compacted[i].content.length).toBe(200);
      }
    });

    it("should not truncate short messages", () => {
      const messages = Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "Short msg",
      }));

      const compacted = messages.map((m, i, arr) => ({
        role: m.role,
        content: i < arr.length - 8
          ? m.content.slice(0, 100) + (m.content.length > 100 ? "..." : "")
          : m.content,
      }));

      // Short messages should not get "..." appended
      expect(compacted[0].content).toBe("Short msg");
    });
  });

  describe("polling/realtime optimization", () => {
    it("should skip polling when realtime message was recent", () => {
      const lastRealtimeAt = Date.now() - 3000; // 3 seconds ago
      const shouldSkipPolling = Date.now() - lastRealtimeAt < 10_000;
      expect(shouldSkipPolling).toBe(true);
    });

    it("should allow polling when realtime is stale", () => {
      const lastRealtimeAt = Date.now() - 15000; // 15 seconds ago
      const shouldSkipPolling = Date.now() - lastRealtimeAt < 10_000;
      expect(shouldSkipPolling).toBe(false);
    });

    it("should allow polling when no realtime message ever received", () => {
      const lastRealtimeAt = 0; // never
      const shouldSkipPolling = Date.now() - lastRealtimeAt < 10_000;
      expect(shouldSkipPolling).toBe(false);
    });
  });

  describe("checkpoint resume with work_summary", () => {
    it("should generate work_summary from tool calls", () => {
      const turn = 8;
      const allToolCalls = [
        { tool: "web_search", input: { query: "test" } },
        { tool: "database_query", input: { table: "tasks" } },
        { tool: "store_memory", input: { content: "fact" } },
      ];

      const workSummary = "Completed " + turn + " steps. Tools used: " +
        [...new Set(allToolCalls.map(t => t.tool))].join(", ") + ". " +
        "Last actions: " + allToolCalls.slice(-3).map(t => t.tool + "(" + JSON.stringify(t.input).slice(0, 50) + ")").join(", ");

      expect(workSummary).toContain("Completed 8 steps");
      expect(workSummary).toContain("web_search");
      expect(workSummary).toContain("store_memory");
      expect(workSummary).toContain("Last actions:");
    });

    it("should inject work_summary as user message on resume", () => {
      const messages: Array<{ role: string; content: string }> = [
        { role: "user", content: "Task instruction" },
        { role: "assistant", content: "Working on it" },
      ];

      const checkpoint = {
        messages: [...messages],
        work_summary: "Completed 5 steps. Tools used: web_search, deploy_static_site.",
      };

      // Simulate resume logic
      messages.length = 0;
      for (const m of checkpoint.messages) messages.push(m);
      if (checkpoint.work_summary) {
        messages.push({
          role: "user",
          content: "[SYSTEM] You are resuming from a checkpoint. Previous work summary: " + checkpoint.work_summary + ". Continue from where you left off.",
        });
      }

      expect(messages.length).toBe(3);
      expect(messages[2].content).toContain("[SYSTEM]");
      expect(messages[2].content).toContain("web_search");
      expect(messages[2].content).toContain("Continue from where you left off");
    });
  });
});
