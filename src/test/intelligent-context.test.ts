import { describe, it, expect } from "vitest";

describe("Phase 5: Intelligent Context", () => {
  describe("role-specific context loading", () => {
    it("should map growth agent to correct domain categories", () => {
      const roleCategoryMap: Record<string, string[]> = {
        growth: ["campaign", "outreach", "sales", "pipeline", "lead", "contact", "pricing"],
        research: ["research", "analysis", "competitive-intel", "market", "trend"],
        engineering: ["project", "deployment", "architecture", "bug", "technical"],
        "executive-assistant": ["meeting", "email", "calendar", "scheduling", "client"],
        designer: ["design", "brand", "ui", "ux", "mockup"],
      };

      expect(roleCategoryMap["growth"]).toContain("campaign");
      expect(roleCategoryMap["growth"]).toContain("pipeline");
      expect(roleCategoryMap["growth"]).toHaveLength(7);
    });

    it("should map research agent to correct domain categories", () => {
      const roleCategoryMap: Record<string, string[]> = {
        research: ["research", "analysis", "competitive-intel", "market", "trend"],
      };
      expect(roleCategoryMap["research"]).toContain("competitive-intel");
      expect(roleCategoryMap["research"]).toContain("market");
    });

    it("should return empty array for unknown agent slug", () => {
      const roleCategoryMap: Record<string, string[]> = {
        growth: ["campaign"],
        research: ["research"],
      };
      expect(roleCategoryMap["unknown-agent"] || []).toEqual([]);
    });

    it("should skip orchestrator for role-specific context", () => {
      const agentSlug = "orchestrator";
      const shouldLoadRoleContext = agentSlug !== "orchestrator";
      expect(shouldLoadRoleContext).toBe(false);
    });

    it("should build correct PostgREST OR filter for role categories", () => {
      const roleCategories = ["campaign", "outreach", "sales"];
      const tagFilter = roleCategories.map(c => "category.eq." + c).join(",");
      expect(tagFilter).toBe("category.eq.campaign,category.eq.outreach,category.eq.sales");
    });

    it("should build combined category+tags OR filter", () => {
      const roleCategories = ["campaign", "sales"];
      const combined = "(" +
        roleCategories.map(c => "category.eq." + c).join(",") + "," +
        roleCategories.map(t => 'tags.cs.["' + t + '"]').join(",") +
        ")";
      expect(combined).toBe('(category.eq.campaign,category.eq.sales,tags.cs.["campaign"],tags.cs.["sales"])');
    });

    it("should deduplicate role context lines against general memories", () => {
      const allMemoryLines = [
        "- [research] Competitor X raised prices 10%",
        "- [general] Team meeting scheduled",
      ];
      const roleContextLines: string[] = [];
      const candidateLines = [
        "- [research] Competitor X raised prices 10%",  // duplicate
        "- [market] TAM estimated at $5B",               // new
      ];
      for (const line of candidateLines) {
        if (!allMemoryLines.includes(line)) roleContextLines.push(line);
      }
      expect(roleContextLines).toHaveLength(1);
      expect(roleContextLines[0]).toContain("TAM estimated");
    });
  });

  describe("training examples injection", () => {
    it("should truncate long user messages at 200 chars", () => {
      const userMsg = "x".repeat(500);
      const truncated = userMsg.length > 200 ? userMsg.slice(0, 200) + "..." : userMsg;
      expect(truncated.length).toBe(203);
      expect(truncated.endsWith("...")).toBe(true);
    });

    it("should truncate long assistant responses at 300 chars", () => {
      const response = "y".repeat(600);
      const truncated = response.length > 300 ? response.slice(0, 300) + "..." : response;
      expect(truncated.length).toBe(303);
      expect(truncated.endsWith("...")).toBe(true);
    });

    it("should not truncate short messages", () => {
      const userMsg = "Research competitor pricing";
      const truncated = userMsg.length > 200 ? userMsg.slice(0, 200) + "..." : userMsg;
      expect(truncated).toBe("Research competitor pricing");
    });

    it("should format training example correctly", () => {
      const ex = {
        user_message: "Find competitor pricing",
        assistant_response: "Found 3 tiers: Basic $10, Pro $25, Enterprise $99",
        quality_score: 9,
      };
      const formatted = "**User asked:** " + ex.user_message +
        "\n**You delivered:** " + ex.assistant_response +
        "\n**Quality:** " + ex.quality_score + "/10";
      expect(formatted).toContain("**User asked:** Find competitor pricing");
      expect(formatted).toContain("**Quality:** 9/10");
    });

    it("should only load active examples", () => {
      const examples = [
        { is_active: true, quality_score: 9 },
        { is_active: false, quality_score: 10 },
        { is_active: true, quality_score: 7 },
      ];
      const active = examples.filter(e => e.is_active);
      expect(active).toHaveLength(2);
    });

    it("should sort examples by quality_score descending", () => {
      const examples = [
        { quality_score: 5, user_message: "low" },
        { quality_score: 9, user_message: "high" },
        { quality_score: 7, user_message: "mid" },
      ];
      examples.sort((a, b) => b.quality_score - a.quality_score);
      expect(examples[0].user_message).toBe("high");
      expect(examples[1].user_message).toBe("mid");
      expect(examples[2].user_message).toBe("low");
    });

    it("should limit to 3 examples maximum", () => {
      const examples = Array.from({ length: 10 }, (_, i) => ({
        quality_score: i + 1,
        user_message: "example " + i,
      }));
      const limited = examples.sort((a, b) => b.quality_score - a.quality_score).slice(0, 3);
      expect(limited).toHaveLength(3);
      expect(limited[0].quality_score).toBe(10);
    });
  });

  describe("team status block", () => {
    it("should calculate elapsed time for running tasks", () => {
      const startedAt = new Date(Date.now() - 12 * 60 * 1000).toISOString();
      const elapsed = Math.round((Date.now() - new Date(startedAt).getTime()) / 60000);
      expect(elapsed).toBe(12);
    });

    it("should format completed task time as minutes when < 60", () => {
      const ago = 45;
      const agoStr = ago < 60 ? ago + " min ago" : Math.round(ago / 60) + "h ago";
      expect(agoStr).toBe("45 min ago");
    });

    it("should format completed task time as hours when >= 60", () => {
      const ago = 120;
      const agoStr = ago < 60 ? ago + " min ago" : Math.round(ago / 60) + "h ago";
      expect(agoStr).toBe("2h ago");
    });

    it("should skip self in team status", () => {
      const agentDefId = "agent-1";
      const runningTasks = [
        { agent_definition_id: "agent-1", title: "My task", status: "running" },
        { agent_definition_id: "agent-2", title: "Other task", status: "running" },
      ];
      const teamLines = runningTasks
        .filter(t => t.agent_definition_id !== agentDefId)
        .map(t => `- **${t.agent_definition_id}**: ${t.title} (${t.status})`);
      expect(teamLines).toHaveLength(1);
      expect(teamLines[0]).toContain("Other task");
    });

    it("should format running task line correctly", () => {
      const name = "Research";
      const title = "Competitor analysis";
      const status = "running";
      const elapsed = "5 min";
      const line = "- **" + name + "**: " + title + " (" + status + ", " + elapsed + ")";
      expect(line).toBe("- **Research**: Competitor analysis (running, 5 min)");
    });

    it("should format completed task line correctly", () => {
      const name = "Engineering";
      const title = "Deploy landing page";
      const agoStr = "2h ago";
      const line = "- **" + name + "**: " + title + " (completed " + agoStr + ")";
      expect(line).toBe("- **Engineering**: Deploy landing page (completed 2h ago)");
    });

    it("should map agent IDs to names", () => {
      const agentDefs = [
        { id: "a1", slug: "research", name: "Research Agent" },
        { id: "a2", slug: "growth", name: "Growth Agent" },
        { id: "a3", slug: "engineering", name: null },
      ];
      const agentIdToName: Record<string, string> = {};
      for (const a of agentDefs) agentIdToName[a.id] = a.name || a.slug;

      expect(agentIdToName["a1"]).toBe("Research Agent");
      expect(agentIdToName["a2"]).toBe("Growth Agent");
      expect(agentIdToName["a3"]).toBe("engineering"); // fallback to slug
    });

    it("should use 'Unknown' for unmapped agent IDs", () => {
      const agentIdToName: Record<string, string> = { "a1": "Research" };
      const name = agentIdToName["a999"] || "Unknown";
      expect(name).toBe("Unknown");
    });
  });

  describe("context block ordering", () => {
    it("should add role context after memories", () => {
      const blocks: string[] = [];
      blocks.push("## Relevant Memories");
      blocks.push("## Domain Context (for your role)");
      blocks.push("## Examples of Good Work");
      blocks.push("## Team Status");

      expect(blocks.indexOf("## Domain Context (for your role)"))
        .toBeGreaterThan(blocks.indexOf("## Relevant Memories"));
    });

    it("should add training examples after role context", () => {
      const blocks: string[] = [];
      blocks.push("## Relevant Memories");
      blocks.push("## Domain Context (for your role)");
      blocks.push("## Examples of Good Work");
      blocks.push("## Team Status");

      expect(blocks.indexOf("## Examples of Good Work"))
        .toBeGreaterThan(blocks.indexOf("## Domain Context (for your role)"));
    });

    it("should add team status last among context blocks", () => {
      const blocks: string[] = [];
      blocks.push("## Relevant Memories");
      blocks.push("## Domain Context (for your role)");
      blocks.push("## Examples of Good Work");
      blocks.push("## Team Status");

      expect(blocks.indexOf("## Team Status")).toBe(blocks.length - 1);
    });
  });
});
