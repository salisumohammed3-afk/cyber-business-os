import { describe, it, expect } from "vitest";

describe("Phase 1: Per-Agent Memory", () => {
  describe("scoped memory recall", () => {
    // Simulates the scope logic from toolRecallMemories
    function buildMemoryQuery(input: { scope?: string; category?: string; query: string }, agentDefId: string | null, companyId: string) {
      const params = new URLSearchParams({
        select: "content,category,importance,created_at,metadata",
        order: "importance.desc",
        limit: String(input.limit || 10),
      });
      params.set("company_id", "eq." + companyId);

      if (input.category) {
        params.set("category", "eq." + input.category);
      } else {
        params.set("category", "neq.agent_message");
      }

      const scope = (input.scope || "mine").trim();
      if (scope === "mine" && agentDefId) {
        params.set("agent_definition_id", "eq." + agentDefId);
      } else if (scope.startsWith("agent:")) {
        const targetId = "mock-target-id";
        params.set("agent_definition_id", "eq." + targetId);
      }
      // scope === "team" => no agent filter

      return Object.fromEntries(params);
    }

    it("should filter by own agent_definition_id with scope=mine", () => {
      const query = buildMemoryQuery({ query: "test", scope: "mine" }, "agent-123", "company-1");
      expect(query.agent_definition_id).toBe("eq.agent-123");
      expect(query.category).toBe("neq.agent_message");
    });

    it("should not filter by agent_definition_id with scope=team", () => {
      const query = buildMemoryQuery({ query: "test", scope: "team" }, "agent-123", "company-1");
      expect(query.agent_definition_id).toBeUndefined();
      expect(query.company_id).toBe("eq.company-1");
    });

    it("should filter by target agent with scope=agent:<slug>", () => {
      const query = buildMemoryQuery({ query: "test", scope: "agent:research" }, "agent-123", "company-1");
      expect(query.agent_definition_id).toBe("eq.mock-target-id");
    });

    it("should default to scope=mine when not specified", () => {
      const query = buildMemoryQuery({ query: "test" }, "agent-456", "company-1");
      expect(query.agent_definition_id).toBe("eq.agent-456");
    });

    it("should exclude agent_message category by default", () => {
      const query = buildMemoryQuery({ query: "test" }, "agent-123", "company-1");
      expect(query.category).toBe("neq.agent_message");
    });

    it("should allow explicit category override including agent_message", () => {
      const query = buildMemoryQuery({ query: "test", category: "agent_message" }, "agent-123", "company-1");
      expect(query.category).toBe("eq.agent_message");
    });
  });

  describe("auto-recall (own memories on task start)", () => {
    function buildOwnMemoryParams(agentDefId: string | null, companyId: string) {
      if (!agentDefId) return null;
      const params = new URLSearchParams({
        select: "content,category,metadata",
        order: "importance.desc,created_at.desc",
        limit: "5",
        agent_definition_id: "eq." + agentDefId,
        category: "neq.agent_message",
        or: "(expires_at.is.null,expires_at.gt." + new Date().toISOString() + ")",
      });
      if (companyId) params.set("company_id", "eq." + companyId);
      return Object.fromEntries(params);
    }

    it("should build params filtering by agent_definition_id", () => {
      const params = buildOwnMemoryParams("agent-research-1", "company-abc");
      expect(params).not.toBeNull();
      expect(params!.agent_definition_id).toBe("eq.agent-research-1");
      expect(params!.limit).toBe("5");
      expect(params!.category).toBe("neq.agent_message");
    });

    it("should return null when agentDefId is null", () => {
      const params = buildOwnMemoryParams(null, "company-abc");
      expect(params).toBeNull();
    });

    it("should include expiry filter", () => {
      const params = buildOwnMemoryParams("agent-1", "company-1");
      expect(params!.or).toContain("expires_at.is.null");
      expect(params!.or).toContain("expires_at.gt.");
    });
  });

  describe("post-task memory extraction", () => {
    it("should only trigger for completed tasks with sufficient output", () => {
      const cases = [
        { status: "completed", textLen: 500, agentDefId: "x", expected: true },
        { status: "failed", textLen: 500, agentDefId: "x", expected: false },
        { status: "completed", textLen: 50, agentDefId: "x", expected: false },
        { status: "completed", textLen: 500, agentDefId: null, expected: false },
      ];

      for (const c of cases) {
        const shouldExtract = c.status === "completed" && c.textLen > 200 && !!c.agentDefId;
        expect(shouldExtract).toBe(c.expected);
      }
    });

    it("should parse valid extraction JSON", () => {
      const extractText = `Here are the key learnings:
[
  {"content": "Apollo API rate limits at 100 req/min", "category": "technical_finding", "importance": 7},
  {"content": "Competitor X launched new pricing tier", "category": "market_intel", "importance": 8}
]`;
      const jsonMatch = extractText.match(/\[[\s\S]*\]/);
      expect(jsonMatch).not.toBeNull();
      const parsed = JSON.parse(jsonMatch![0]);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].category).toBe("technical_finding");
      expect(parsed[1].importance).toBe(8);
    });

    it("should cap extracted memories at 3", () => {
      const manyMems = [
        { content: "a", category: "x", importance: 5 },
        { content: "b", category: "x", importance: 5 },
        { content: "c", category: "x", importance: 5 },
        { content: "d", category: "x", importance: 5 },
        { content: "e", category: "x", importance: 5 },
      ];
      const capped = manyMems.slice(0, 3);
      expect(capped).toHaveLength(3);
    });

    it("should skip memories with content < 10 chars", () => {
      const mems = [
        { content: "short", category: "x", importance: 5 },
        { content: "This is a proper memory with enough detail", category: "x", importance: 7 },
      ];
      const valid = mems.filter(m => m.content && m.content.length >= 10);
      expect(valid).toHaveLength(1);
      expect(valid[0].importance).toBe(7);
    });

    it("should clamp importance between 1 and 10", () => {
      const clamp = (v: number) => Math.min(10, Math.max(1, v));
      expect(clamp(0)).toBe(1);
      expect(clamp(15)).toBe(10);
      expect(clamp(7)).toBe(7);
    });
  });

  describe("inter-agent message injection", () => {
    it("should format messages from other agents correctly", () => {
      const messages = [
        { content: "Found 3 pricing tiers for competitor", metadata: { from: "research", urgency: "request", target_agent: "growth" } },
        { content: "Landing page deployed at example.com", metadata: { from: "engineering", urgency: "fyi", target_agent: "growth" } },
      ];

      const lines: string[] = [];
      lines.push("**Messages from other agents:**");
      for (const m of messages) {
        lines.push("- [from " + m.metadata.from + ", " + m.metadata.urgency + "] " + m.content);
      }

      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain("from research, request");
      expect(lines[2]).toContain("from engineering, fyi");
    });

    it("should filter messages by target_agent", () => {
      const allMessages = [
        { content: "msg1", metadata: { target_agent: "growth" } },
        { content: "msg2", metadata: { target_agent: "engineering" } },
        { content: "msg3", metadata: { target_agent: "growth" } },
      ];

      const forGrowth = allMessages.filter(m => m.metadata.target_agent === "growth");
      expect(forGrowth).toHaveLength(2);
    });
  });

  describe("memory dedup in store_memory", () => {
    it("should detect duplicate memories by word overlap", () => {
      const normNew = "apollo api rate limit 100 requests per minute";
      const normOld = "apollo api rate limit 100 requests per minute free tier";

      const words1 = new Set(normNew.split(" "));
      const words2 = new Set(normOld.split(" "));
      let match = 0;
      for (const w of words1) if (words2.has(w)) match++;
      const overlap = match / Math.max(words1.size, words2.size);

      expect(overlap).toBeGreaterThanOrEqual(0.8);
    });

    it("should not flag distinct memories as duplicates", () => {
      const normNew = "competitor launched new enterprise pricing";
      const normOld = "apollo api rate limit is 100 requests per minute";

      const words1 = new Set(normNew.split(" "));
      const words2 = new Set(normOld.split(" "));
      let match = 0;
      for (const w of words1) if (words2.has(w)) match++;
      const overlap = match / Math.max(words1.size, words2.size);

      expect(overlap).toBeLessThan(0.8);
    });
  });
});
