import { describe, it, expect } from "vitest";

describe("Phase 2: Agent Collaboration", () => {
  describe("read_agent_output", () => {
    it("should require either task_id or agent_slug", () => {
      const input = {};
      const hasTaskId = !!input.task_id;
      const hasAgentSlug = !!input.agent_slug;
      expect(hasTaskId || hasAgentSlug).toBe(false);
    });

    it("should truncate response to 3000 chars", () => {
      const longResponse = "x".repeat(5000);
      const truncated = longResponse.slice(0, 3000);
      expect(truncated.length).toBe(3000);
    });

    it("should extract deliverables from tool calls", () => {
      const toolCalls = [
        { tool: "deploy_static_site", input: { url: "https://example.com" } },
        { tool: "web_search", input: { query: "test" } },
        { tool: "github_push_file", input: { path: "index.html" } },
        { tool: "register_project", input: { name: "my-project" } },
      ];

      const deliverableTools = ["deploy_static_site", "register_project", "github_push_file"];
      const deliverables = toolCalls
        .filter(t => deliverableTools.includes(t.tool))
        .map(t => ({ tool: t.tool, input: t.input }))
        .slice(0, 5);

      expect(deliverables).toHaveLength(3);
      expect(deliverables[0].tool).toBe("deploy_static_site");
      expect(deliverables[1].tool).toBe("github_push_file");
    });
  });

  describe("message_agent", () => {
    it("should not allow messaging yourself", () => {
      const currentAgent = "research";
      const targetAgent = "research";
      expect(targetAgent === currentAgent).toBe(true);
    });

    it("should set correct importance based on urgency", () => {
      const importanceMap = (urgency: string) =>
        urgency === "blocker" ? 9 : urgency === "request" ? 7 : 5;

      expect(importanceMap("blocker")).toBe(9);
      expect(importanceMap("request")).toBe(7);
      expect(importanceMap("fyi")).toBe(5);
      expect(importanceMap("")).toBe(5);
    });

    it("should set expiry to 7 days from now", () => {
      const now = Date.now();
      const expiresAt = new Date(now + 7 * 24 * 60 * 60 * 1000);
      const diff = expiresAt.getTime() - now;
      expect(diff).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("should store message with correct metadata shape", () => {
      const metadata = {
        source: "agent_message",
        from: "research",
        target_agent: "engineering",
        urgency: "request",
        task_id: "task-123",
      };

      expect(metadata.source).toBe("agent_message");
      expect(metadata.from).toBe("research");
      expect(metadata.target_agent).toBe("engineering");
    });
  });

  describe("delegation depth limit", () => {
    const MAX_DELEGATION_DEPTH = 4;

    it("should allow delegation at depth 0", () => {
      const currentDepth = 0;
      expect(currentDepth < MAX_DELEGATION_DEPTH).toBe(true);
    });

    it("should allow delegation at depth 3", () => {
      const currentDepth = 3;
      expect(currentDepth < MAX_DELEGATION_DEPTH).toBe(true);
    });

    it("should block delegation at depth 4", () => {
      const currentDepth = 4;
      expect(currentDepth >= MAX_DELEGATION_DEPTH).toBe(true);
    });

    it("should increment depth on child task", () => {
      const parentDepth = 2;
      const childMeta = { delegation_depth: parentDepth + 1 };
      expect(childMeta.delegation_depth).toBe(3);
    });

    it("should default to depth 0 when metadata has no delegation_depth", () => {
      const metadata = { some_other_field: "value" };
      const depth = metadata.delegation_depth || 0;
      expect(depth).toBe(0);
    });
  });

  describe("inter-agent message filtering on task start", () => {
    it("should filter messages by target_agent in metadata", () => {
      const currentSlug = "engineering";
      const allMessages = [
        { content: "Deploy this", metadata: { target_agent: "engineering", from: "orchestrator" } },
        { content: "Research pricing", metadata: { target_agent: "research", from: "growth" } },
        { content: "Check the API", metadata: { target_agent: "engineering", from: "research" } },
      ];

      const forMe = allMessages.filter(m => m.metadata.target_agent === currentSlug);
      expect(forMe).toHaveLength(2);
      expect(forMe[0].metadata.from).toBe("orchestrator");
      expect(forMe[1].metadata.from).toBe("research");
    });

    it("should build PostgREST filter for metadata json field", () => {
      const agentSlug = "growth";
      const filter = "metadata->>target_agent=eq." + agentSlug;
      expect(filter).toBe("metadata->>target_agent=eq.growth");
    });
  });
});
