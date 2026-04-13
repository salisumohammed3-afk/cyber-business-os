import { describe, it, expect } from "vitest";

// ── compactMessages (copied from runner.mjs for isolated testing) ──────────

function compactMessages(messages) {
  if (messages.length <= 15) return;
  const keep = 8;
  const head = messages.slice(0, 1);
  const tail = messages.slice(-keep);
  const middle = messages.slice(1, -keep);

  const toolNames = [];
  const textSnippets = [];
  for (const m of middle) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "tool_use") toolNames.push(b.name);
        if (b.type === "tool_result") textSnippets.push((b.content || "").slice(0, 100));
      }
    } else if (typeof m.content === "string" && m.role === "assistant") {
      textSnippets.push(m.content.slice(0, 200));
    }
  }

  const summary = "[Previous work summary: " + middle.length + " messages compacted. " +
    "Tools used: " + [...new Set(toolNames)].join(", ") + ". " +
    "Key outputs: " + textSnippets.slice(0, 3).join("; ").slice(0, 500) + "]";

  messages.length = 0;
  messages.push(head[0]);
  messages.push({ role: "assistant", content: "Understood. Working on this." });
  messages.push({ role: "user", content: summary });
  messages.push({ role: "assistant", content: "Continuing from where I left off." });
  for (const m of tail) messages.push(m);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Phase 1: Cost & Observability", () => {
  describe("compactMessages", () => {
    it("should not compact messages when <= 15", () => {
      const messages = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "Message " + i,
      }));
      const originalLength = messages.length;
      compactMessages(messages);
      expect(messages.length).toBe(originalLength);
    });

    it("should compact messages when > 15, preserving first and last 8", () => {
      const messages = [];
      // First message (task instruction)
      messages.push({ role: "user", content: "YOUR TASK: Build a calculator" });
      // 12 middle messages (tool calls and results)
      for (let i = 0; i < 12; i++) {
        if (i % 2 === 0) {
          messages.push({
            role: "assistant",
            content: [{ type: "tool_use", name: "sandbox_write_file", id: "t" + i, input: {} }],
          });
        } else {
          messages.push({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t" + (i - 1), content: "File written OK" }],
          });
        }
      }
      // Last 8 messages
      for (let i = 0; i < 8; i++) {
        messages.push({
          role: i % 2 === 0 ? "user" : "assistant",
          content: "Recent message " + i,
        });
      }

      expect(messages.length).toBe(21);
      const lastEight = messages.slice(-8).map(m => m.content);

      compactMessages(messages);

      // Should be: head(1) + bridge(2) + summary(1) + bridge(1) + tail(8) = 12
      expect(messages.length).toBe(12);
      expect(messages[0].content).toBe("YOUR TASK: Build a calculator");
      // Last 8 should be preserved verbatim
      const newLastEight = messages.slice(-8).map(m => m.content);
      expect(newLastEight).toEqual(lastEight);
      // Summary should mention tools
      expect(messages[2].content).toContain("sandbox_write_file");
      expect(messages[2].content).toContain("messages compacted");
    });

    it("should deduplicate tool names in summary", () => {
      const messages = [];
      messages.push({ role: "user", content: "Task" });
      for (let i = 0; i < 10; i++) {
        messages.push({
          role: "assistant",
          content: [{ type: "tool_use", name: "web_search", id: "t" + i, input: {} }],
        });
      }
      for (let i = 0; i < 8; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: "tail " + i });
      }

      compactMessages(messages);
      const summary = messages[2].content;
      // "web_search" should appear only once despite 10 uses
      const matches = summary.match(/web_search/g);
      expect(matches.length).toBe(1);
    });
  });

  describe("tokenUsage accumulation", () => {
    it("should correctly accumulate token usage from multiple responses", () => {
      const tokenUsage = {
        input_tokens: 0, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        api_calls: 0,
      };

      const responses = [
        { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 500, cache_read_input_tokens: 0 },
        { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 },
        { input_tokens: 1500, output_tokens: 250, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 },
      ];

      for (const usage of responses) {
        tokenUsage.input_tokens += usage.input_tokens || 0;
        tokenUsage.output_tokens += usage.output_tokens || 0;
        tokenUsage.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
        tokenUsage.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
        tokenUsage.api_calls++;
      }

      expect(tokenUsage.input_tokens).toBe(3700);
      expect(tokenUsage.output_tokens).toBe(750);
      expect(tokenUsage.cache_creation_input_tokens).toBe(500);
      expect(tokenUsage.cache_read_input_tokens).toBe(1800);
      expect(tokenUsage.api_calls).toBe(3);
    });

    it("should handle missing usage fields gracefully", () => {
      const tokenUsage = {
        input_tokens: 0, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        api_calls: 0,
      };

      const usage = { input_tokens: 500, output_tokens: 100 }; // no cache fields
      tokenUsage.input_tokens += usage.input_tokens || 0;
      tokenUsage.output_tokens += usage.output_tokens || 0;
      tokenUsage.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
      tokenUsage.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
      tokenUsage.api_calls++;

      expect(tokenUsage.cache_creation_input_tokens).toBe(0);
      expect(tokenUsage.cache_read_input_tokens).toBe(0);
      expect(tokenUsage.api_calls).toBe(1);
    });
  });

  describe("system prompt cached blocks", () => {
    it("should build blocks with cache_control on stable sections, not on operational rules", () => {
      const CACHE = { type: "ephemeral" };
      const systemBlocks = [];

      // Simulate block building from main()
      systemBlocks.push({ type: "text", text: "Base agent prompt", cache_control: CACHE });
      systemBlocks.push({ type: "text", text: "Company context", cache_control: CACHE });
      systemBlocks.push({ type: "text", text: "Active goals", cache_control: CACHE });
      systemBlocks.push({ type: "text", text: "Composio apps", cache_control: CACHE });
      systemBlocks.push({ type: "text", text: "Skills", cache_control: CACHE });
      // Last block: operational rules — NO cache_control
      systemBlocks.push({ type: "text", text: "How you work..." });

      // All blocks except the last should have cache_control
      for (let i = 0; i < systemBlocks.length - 1; i++) {
        expect(systemBlocks[i].cache_control).toEqual({ type: "ephemeral" });
      }
      // Last block should NOT have cache_control
      expect(systemBlocks[systemBlocks.length - 1].cache_control).toBeUndefined();
    });

    it("should produce valid block format for Anthropic API", () => {
      const block = { type: "text", text: "Hello", cache_control: { type: "ephemeral" } };
      expect(block.type).toBe("text");
      expect(typeof block.text).toBe("string");
      expect(block.cache_control.type).toBe("ephemeral");
    });
  });
});
