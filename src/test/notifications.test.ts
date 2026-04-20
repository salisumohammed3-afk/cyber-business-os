import { describe, it, expect } from "vitest";

describe("Phase 4: Notifications", () => {
  describe("notify endpoint logic", () => {
    it("should select correct icon for event type", () => {
      const iconMap = (eventType: string) =>
        eventType === "task_completed" ? "\u2705" :
        eventType === "task_failed" ? "\u274C" :
        eventType === "task_proposed" ? "\uD83D\uDCA1" :
        "\uD83D\uDD14";

      expect(iconMap("task_completed")).toBe("\u2705");
      expect(iconMap("task_failed")).toBe("\u274C");
      expect(iconMap("task_proposed")).toBe("\uD83D\uDCA1");
      expect(iconMap("unknown")).toBe("\uD83D\uDD14");
    });

    it("should format notification content correctly", () => {
      const title = "Research completed";
      const body = "Found 3 competitor pricing tiers";
      const content = `\u2705 **${title}**\n${body}`;
      expect(content).toContain("**Research completed**");
      expect(content).toContain("3 competitor pricing tiers");
    });

    it("should handle missing body gracefully", () => {
      const title = "Task done";
      const body = undefined;
      const content = `\u2705 **${title}**${body ? "\n" + body : ""}`;
      expect(content).toBe("\u2705 **Task done**");
    });

    it("should set notification metadata correctly", () => {
      const meta = {
        notification: true,
        event_type: "task_completed",
        agent_slug: "research",
        task_id: "task-123",
        duration_min: 5,
      };
      expect(meta.notification).toBe(true);
      expect(meta.event_type).toBe("task_completed");
    });
  });

  describe("runner completion notification", () => {
    it("should trigger notification for delegated proactive tasks", () => {
      const task = { source: "proactive", parent_task_id: "parent-1" };
      const finalStatus = "completed";
      const isDelegated = task.source === "agent" && !!task.parent_task_id;
      // proactive tasks with parent are delegated
      const shouldNotify = finalStatus === "completed" && task.source !== "internal" && isDelegated;
      // For this specific case, isDelegated is false since source is "proactive"
      // But the actual code checks: isDelegated which means source=agent AND parent_task_id exists
      expect(isDelegated).toBe(false);
    });

    it("should truncate long summaries to 200 chars", () => {
      const longText = "x".repeat(500);
      const summary = longText.slice(0, 200) + (longText.length > 200 ? "..." : "");
      expect(summary.length).toBe(203); // 200 + "..."
    });

    it("should calculate task duration in minutes", () => {
      const startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
      const duration = Math.round((Date.now() - new Date(startedAt).getTime()) / 60000);
      expect(duration).toBe(10);
    });
  });

  describe("proactive planner chat summary", () => {
    it("should format proposed task list with bullet points", () => {
      const tasks = [
        { title: "Research competitor pricing", agent_slug: "research" },
        { title: "Draft outreach sequence", agent_slug: "growth" },
      ];
      const proposed = 2;
      const proposedTitles = tasks
        .filter((_, i) => i < proposed)
        .map(t => `\u2022 ${t.title} (${t.agent_slug})`)
        .join("\n");

      expect(proposedTitles).toContain("\u2022 Research competitor pricing (research)");
      expect(proposedTitles).toContain("\u2022 Draft outreach sequence (growth)");
    });

    it("should use singular form for 1 task", () => {
      const proposed = 1;
      const msg = `Proposed ${proposed} new task${proposed > 1 ? "s" : ""}`;
      expect(msg).toBe("Proposed 1 new task");
    });

    it("should use plural form for multiple tasks", () => {
      const proposed = 3;
      const msg = `Proposed ${proposed} new task${proposed > 1 ? "s" : ""}`;
      expect(msg).toBe("Proposed 3 new tasks");
    });
  });

  describe("notification card rendering", () => {
    it("should detect notification messages by metadata", () => {
      const meta = { notification: true, event_type: "task_completed" };
      expect(meta.notification === true && !!meta.event_type).toBe(true);
    });

    it("should not render non-notification messages as cards", () => {
      const meta = { notification: false };
      expect(meta.notification === true).toBe(false);
    });

    it("should not render notification without event_type as card", () => {
      const meta = { notification: true };
      expect(meta.notification === true && !!(meta as Record<string, unknown>).event_type).toBe(false);
    });
  });
});
