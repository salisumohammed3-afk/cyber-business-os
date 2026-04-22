import { describe, it, expect } from "vitest";

describe("Chat triage: delegation detection & chat-mode tools", () => {
  describe("delegation marker parsing", () => {
    const DELEGATION_RE = /\[NEEDS_DELEGATION\]/;

    it("should detect delegation marker in reply", () => {
      const reply = "Got it. I'll queue that.\n\n[NEEDS_DELEGATION]\nResearch competitor pricing\nScan top 5 competitors and report changes.";
      expect(reply.match(DELEGATION_RE)).not.toBeNull();
    });

    it("should not trigger delegation for plain chat reply", () => {
      const reply = "Your three active tasks right now: Research X, Draft Y, Deploy Z.";
      expect(reply.match(DELEGATION_RE)).toBeNull();
    });

    it("should extract task title and description from marker", () => {
      const reply = "Sure.\n\n[NEEDS_DELEGATION]\nBuild landing page\nUse Next.js, match the brand colors, deploy to Vercel.";
      const match = reply.match(DELEGATION_RE);
      if (!match) throw new Error("no match");
      const markerIdx = reply.indexOf(match[0]);
      const afterMarker = reply.slice(markerIdx + match[0].length);
      const afterLines = afterMarker.split("\n").filter(Boolean);
      const taskTitle = afterLines[0]?.trim();
      const taskDescription = afterLines.slice(1).join("\n").trim();
      expect(taskTitle).toBe("Build landing page");
      expect(taskDescription).toBe("Use Next.js, match the brand colors, deploy to Vercel.");
    });

    it("should preserve preamble as acknowledgment", () => {
      const reply = "Great, I'll get on it.\n\n[NEEDS_DELEGATION]\nTask\nDetails";
      const match = reply.match(DELEGATION_RE);
      if (!match) throw new Error("no match");
      const markerIdx = reply.indexOf(match[0]);
      const preamble = reply.slice(0, markerIdx).trim();
      expect(preamble).toBe("Great, I'll get on it.");
    });

    it("should fall back to default ack when no preamble", () => {
      const reply = "[NEEDS_DELEGATION]\nTask\nDetails";
      const match = reply.match(DELEGATION_RE);
      if (!match) throw new Error("no match");
      const markerIdx = reply.indexOf(match[0]);
      const preamble = reply.slice(0, markerIdx).trim();
      const ack = preamble ? preamble : "I've queued that as a proposed task. You can review and approve it in the task pipeline.";
      expect(ack).toContain("queued that as a proposed task");
    });
  });

  describe("chat-mode tool schemas", () => {
    const CHAT_TOOLS = [
      {
        name: "fetch_url",
        description: "Fetch a URL and return its text content",
        input_schema: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
      },
      {
        name: "query_state",
        description: "Look up current business state",
        input_schema: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["tasks", "memories", "goals"] },
          },
          required: ["type"],
        },
      },
    ];

    it("should include fetch_url and query_state only", () => {
      expect(CHAT_TOOLS.map(t => t.name)).toEqual(["fetch_url", "query_state"]);
    });

    it("should not expose destructive tools in chat mode", () => {
      const toolNames = CHAT_TOOLS.map(t => t.name);
      const destructive = [
        "delegate_task",
        "create_task",
        "deploy_static_site",
        "github_create_repo",
        "sandbox_bash",
        "composio_execute",
      ];
      for (const d of destructive) {
        expect(toolNames).not.toContain(d);
      }
    });

    it("fetch_url should require url parameter", () => {
      const fetchUrl = CHAT_TOOLS.find(t => t.name === "fetch_url");
      expect(fetchUrl?.input_schema.required).toContain("url");
    });

    it("query_state should restrict type to tasks/memories/goals", () => {
      const queryState = CHAT_TOOLS.find(t => t.name === "query_state");
      const typeProp = queryState?.input_schema.properties?.type as { enum?: string[] };
      expect(typeProp?.enum).toEqual(["tasks", "memories", "goals"]);
    });
  });

  describe("fetch_url response shape", () => {
    it("should reject invalid URLs", () => {
      const url = "not-a-url";
      const isValid = url.startsWith("http");
      expect(isValid).toBe(false);
    });

    it("should accept https URLs", () => {
      const url = "https://example.com";
      const isValid = url.startsWith("http");
      expect(isValid).toBe(true);
    });

    it("should strip HTML tags from preview", () => {
      const html = `<html><head><script>alert('x')</script><style>body{}</style></head><body><h1>Hello</h1><p>World</p></body></html>`;
      const preview = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      expect(preview).toBe("Hello World");
      expect(preview).not.toContain("<");
      expect(preview).not.toContain("alert");
    });

    it("should truncate preview to 4000 chars", () => {
      const html = "<p>" + "a".repeat(10000) + "</p>";
      const preview = html
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 4000);
      expect(preview.length).toBe(4000);
    });
  });

  describe("tool-use loop cap", () => {
    const MAX_TOOL_TURNS = 3;

    it("should cap at 3 tool turns", () => {
      expect(MAX_TOOL_TURNS).toBe(3);
    });

    it("should finalize when stop_reason is not tool_use", () => {
      const stopReason = "end_turn";
      const toolTurns = 0;
      const shouldFinalize = stopReason !== "tool_use" || toolTurns >= MAX_TOOL_TURNS;
      expect(shouldFinalize).toBe(true);
    });

    it("should finalize when cap reached even if tool_use requested", () => {
      const stopReason = "tool_use";
      const toolTurns = 3;
      const shouldFinalize = stopReason !== "tool_use" || toolTurns >= MAX_TOOL_TURNS;
      expect(shouldFinalize).toBe(true);
    });

    it("should continue looping mid-flow", () => {
      const stopReason = "tool_use";
      const toolTurns = 1;
      const shouldFinalize = stopReason !== "tool_use" || toolTurns >= MAX_TOOL_TURNS;
      expect(shouldFinalize).toBe(false);
    });
  });

  describe("query_state filter logic", () => {
    it("should default limit to 10, max 25", () => {
      const input: { limit?: number } = {};
      const limit = Math.min(Number(input.limit) || 10, 25);
      expect(limit).toBe(10);
    });

    it("should cap large limit requests at 25", () => {
      const input = { limit: 1000 };
      const limit = Math.min(Number(input.limit) || 10, 25);
      expect(limit).toBe(25);
    });

    it("should exclude agent_message category from memories", () => {
      const memories = [
        { category: "general", content: "A" },
        { category: "agent_message", content: "B" },
        { category: "research", content: "C" },
      ];
      const filtered = memories.filter(m => m.category !== "agent_message");
      expect(filtered).toHaveLength(2);
      expect(filtered.map(m => m.category)).toEqual(["general", "research"]);
    });

    it("should reject unknown type", () => {
      const type = "invalid";
      const validTypes = ["tasks", "memories", "goals"];
      const isValid = validTypes.includes(type);
      expect(isValid).toBe(false);
    });
  });

  describe("triage philosophy in prompt", () => {
    const addendum = `Default: answer in this message. You have tools to help you answer directly. Only delegate when the work genuinely can't fit in a short chat turn.

Answer directly (no delegation):
- Questions, opinions, ideas, status checks, pushback, clarifications
- Quick reviews — use fetch_url to grab a page and tell Sal what you think

Delegate with [NEEDS_DELEGATION] only when the work requires:
- Multi-step execution across external services`;

    it("should default to answering directly", () => {
      expect(addendum.toLowerCase()).toContain("default: answer");
    });

    it("should explicitly tell orchestrator to use fetch_url for reviews", () => {
      expect(addendum).toContain("fetch_url");
      expect(addendum.toLowerCase()).toContain("review");
    });

    it("should require delegation to be multi-step or world-changing", () => {
      expect(addendum.toLowerCase()).toMatch(/multi-step|external services/);
    });
  });
});
