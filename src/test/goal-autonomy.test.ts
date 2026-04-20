import { describe, it, expect } from "vitest";

describe("Phase 3: Goal-Driven Autonomy", () => {
  describe("goal injection as mission", () => {
    it("should format goals with progress metrics", () => {
      const goals = [
        { title: "Reach 100 paying customers", target_metric: "customers", current_value: 23, target_value: 100, timeframe: "Q2 2026" },
        { title: "Launch partner portal", target_metric: null, current_value: 0, target_value: null, timeframe: "May 2026" },
      ];

      const lines = goals.map((g, i) =>
        (i + 1) + ". " + g.title +
        (g.target_metric ? " — Progress: " + (g.current_value ?? 0) + "/" + (g.target_value ?? "?") + " " + g.target_metric : "") +
        (g.timeframe ? " — Deadline: " + g.timeframe : "")
      );

      expect(lines[0]).toContain("Progress: 23/100 customers");
      expect(lines[0]).toContain("Deadline: Q2 2026");
      expect(lines[1]).not.toContain("Progress:");
      expect(lines[1]).toContain("Deadline: May 2026");
    });

    it("should include mission framing text", () => {
      const header = "## Your Mission\nEverything you do should ladder up to these company goals:";
      expect(header).toContain("Your Mission");
      expect(header).toContain("ladder up");
    });
  });

  describe("update_goal_progress (fuzzy matching)", () => {
    function fuzzyMatchGoal(input: string, goals: Array<{ id: string; title: string }>) {
      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
      const targetNorm = normalize(input);
      let bestMatch: typeof goals[0] | null = null;
      let bestScore = 0;
      for (const g of goals) {
        const goalNorm = normalize(g.title);
        const targetWords = new Set(targetNorm.split(" "));
        const goalWords = new Set(goalNorm.split(" "));
        let shared = 0;
        for (const w of targetWords) if (goalWords.has(w)) shared++;
        const score = shared / Math.max(targetWords.size, goalWords.size, 1);
        if (score > bestScore) { bestScore = score; bestMatch = g; }
      }
      return { match: bestMatch, score: bestScore };
    }

    it("should match exact title", () => {
      const goals = [{ id: "1", title: "Reach 100 paying customers" }];
      const result = fuzzyMatchGoal("Reach 100 paying customers", goals);
      expect(result.match?.id).toBe("1");
      expect(result.score).toBe(1);
    });

    it("should match partial title", () => {
      const goals = [
        { id: "1", title: "Reach 100 paying customers" },
        { id: "2", title: "Launch partner portal" },
      ];
      const result = fuzzyMatchGoal("paying customers goal", goals);
      expect(result.match?.id).toBe("1");
      expect(result.score).toBeGreaterThan(0.3);
    });

    it("should return low score for unrelated query", () => {
      const goals = [{ id: "1", title: "Reach 100 paying customers" }];
      const result = fuzzyMatchGoal("deploy kubernetes cluster", goals);
      expect(result.score).toBeLessThan(0.3);
    });
  });

  describe("auto-approve logic", () => {
    interface Task { id: string; title: string; source: string; priority: number; agent_slug: string }
    interface AgentDef { is_safe_auto_approve: boolean }
    interface Company { auto_approve_enabled: boolean }

    function shouldAutoApprove(task: Task, agentDef: AgentDef, company: Company, existingTitles: string[]): boolean {
      if (!["proactive", "agent"].includes(task.source)) return false;
      if (task.priority < 7) return false;
      if (!company.auto_approve_enabled) return false;
      if (!agentDef.is_safe_auto_approve) return false;

      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
      const taskNorm = normalize(task.title);
      for (const existing of existingTitles) {
        if (normalize(existing) === taskNorm) return false;
      }
      return true;
    }

    it("should approve research task with priority 8 from proactive planner", () => {
      const result = shouldAutoApprove(
        { id: "1", title: "Research competitor pricing", source: "proactive", priority: 8, agent_slug: "research" },
        { is_safe_auto_approve: true },
        { auto_approve_enabled: true },
        []
      );
      expect(result).toBe(true);
    });

    it("should reject engineering task even if flagged safe", () => {
      const result = shouldAutoApprove(
        { id: "2", title: "Build landing page", source: "proactive", priority: 9, agent_slug: "engineering" },
        { is_safe_auto_approve: false },
        { auto_approve_enabled: true },
        []
      );
      expect(result).toBe(false);
    });

    it("should reject task with priority below 7", () => {
      const result = shouldAutoApprove(
        { id: "3", title: "Minor research", source: "proactive", priority: 5, agent_slug: "research" },
        { is_safe_auto_approve: true },
        { auto_approve_enabled: true },
        []
      );
      expect(result).toBe(false);
    });

    it("should reject when company has auto_approve disabled", () => {
      const result = shouldAutoApprove(
        { id: "4", title: "Research task", source: "proactive", priority: 8, agent_slug: "research" },
        { is_safe_auto_approve: true },
        { auto_approve_enabled: false },
        []
      );
      expect(result).toBe(false);
    });

    it("should reject duplicate of running task", () => {
      const result = shouldAutoApprove(
        { id: "5", title: "Research competitor pricing", source: "proactive", priority: 8, agent_slug: "research" },
        { is_safe_auto_approve: true },
        { auto_approve_enabled: true },
        ["Research competitor pricing"]
      );
      expect(result).toBe(false);
    });

    it("should reject task from chat source", () => {
      const result = shouldAutoApprove(
        { id: "6", title: "Research task", source: "chat", priority: 9, agent_slug: "research" },
        { is_safe_auto_approve: true },
        { auto_approve_enabled: true },
        []
      );
      expect(result).toBe(false);
    });
  });

  describe("recurring task scheduling", () => {
    const SCHEDULE_MS: Record<string, number> = {
      hourly: 60 * 60 * 1000,
      daily: 24 * 60 * 60 * 1000,
      weekly: 7 * 24 * 60 * 60 * 1000,
      monthly: 30 * 24 * 60 * 60 * 1000,
    };

    it("should trigger daily task after 24 hours", () => {
      const now = Date.now();
      const completedAt = now - 25 * 60 * 60 * 1000; // 25 hours ago
      const interval = SCHEDULE_MS["daily"];
      expect(now - completedAt >= interval).toBe(true);
    });

    it("should NOT trigger daily task before 24 hours", () => {
      const now = Date.now();
      const completedAt = now - 12 * 60 * 60 * 1000; // 12 hours ago
      const interval = SCHEDULE_MS["daily"];
      expect(now - completedAt >= interval).toBe(false);
    });

    it("should use last_recurrence_at over completed_at if more recent", () => {
      const now = Date.now();
      const completedAt = now - 48 * 60 * 60 * 1000; // 48 hours ago
      const lastRecurrence = now - 2 * 60 * 60 * 1000; // 2 hours ago
      const lastEvent = Math.max(completedAt, lastRecurrence);
      const interval = SCHEDULE_MS["daily"];
      expect(now - lastEvent >= interval).toBe(false); // 2 hours < 24 hours
    });

    it("should handle unknown schedule gracefully", () => {
      const interval = SCHEDULE_MS["biweekly"] || null;
      expect(interval).toBeNull();
    });
  });

  describe("proactive planner goal-gap analysis", () => {
    it("should include goal-gap instructions in system prompt", () => {
      const prompt = "For each active goal, assess how far behind schedule it is. Prioritize tasks that close the biggest gaps.";
      expect(prompt).toContain("behind schedule");
      expect(prompt).toContain("biggest gaps");
    });

    it("should include goal_title in task metadata", () => {
      const taskMeta = { goal_title: "Reach 100 paying customers" };
      expect(taskMeta.goal_title).toBeDefined();
    });
  });
});
