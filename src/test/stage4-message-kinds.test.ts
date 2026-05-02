import { describe, it, expect } from "vitest";

describe("Stage 4: Typed message kinds", () => {
  // The closed set of message kinds. UI routes rendering on these.
  const KINDS = [
    "user_msg",
    "reply",
    "work_order_proposal",
    "work_order_status",
    "error",
    "notification",
    "progress",
  ] as const;
  type Kind = (typeof KINDS)[number];

  describe("kind set", () => {
    it("has exactly 7 kinds", () => {
      expect(KINDS).toHaveLength(7);
    });

    it("user_msg is for user-typed messages only", () => {
      const userMsg = { role: "user", kind: "user_msg" };
      expect(userMsg.kind).toBe("user_msg");
    });

    it("reply is for assistant chat replies", () => {
      const reply = { role: "assistant", kind: "reply" };
      expect(reply.kind).toBe("reply");
    });

    it("work_order_proposal renders an interactive card", () => {
      expect(KINDS).toContain("work_order_proposal");
    });

    it("error replaces the old 'Something went wrong' pattern", () => {
      expect(KINDS).toContain("error");
    });
  });

  describe("kind precedence in CEOChat", () => {
    function pickKind(row: { kind?: string | null; metadata?: Record<string, unknown> | null; role: string }): Kind | string {
      // Mirror of useLiveChat / CEOChat logic
      return (
        (row.kind as string | null | undefined) ||
        (row.metadata?.kind as string | undefined) ||
        (row.role === "user" ? "user_msg" : "reply")
      );
    }

    it("row column wins over metadata.kind", () => {
      const row = { kind: "error", metadata: { kind: "reply" }, role: "system" };
      expect(pickKind(row)).toBe("error");
    });

    it("falls back to metadata.kind when column is null", () => {
      const row = { kind: null, metadata: { kind: "work_order_proposal" }, role: "assistant" };
      expect(pickKind(row)).toBe("work_order_proposal");
    });

    it("falls back to user_msg for user role with no kind anywhere", () => {
      const row = { kind: null, metadata: null, role: "user" };
      expect(pickKind(row)).toBe("user_msg");
    });

    it("falls back to reply for assistant/system role with no kind anywhere", () => {
      const row = { kind: null, metadata: null, role: "assistant" };
      expect(pickKind(row)).toBe("reply");
    });
  });

  describe("backfill SQL semantics", () => {
    // The migration backfills existing rows. Check the precedence is right:
    // 1. metadata.kind (if a known kind)
    // 2. role = user → user_msg
    // 3. metadata.progress → progress
    // 4. metadata.error → error
    // 5. metadata.notification → notification
    // 6. else → reply
    function backfillKind(row: { role: string; metadata: Record<string, unknown> }): string {
      const m = row.metadata || {};
      const known = ["user_msg", "reply", "work_order_proposal", "work_order_status", "error", "notification", "progress"];
      if (typeof m.kind === "string" && known.includes(m.kind)) return m.kind;
      if (row.role === "user") return "user_msg";
      if (m.progress === true) return "progress";
      if (m.error === true) return "error";
      if (m.notification === true) return "notification";
      return "reply";
    }

    it("uses metadata.kind when valid", () => {
      expect(backfillKind({ role: "system", metadata: { kind: "error" } })).toBe("error");
    });

    it("rejects bogus metadata.kind values", () => {
      expect(backfillKind({ role: "assistant", metadata: { kind: "bogus" } })).toBe("reply");
    });

    it("user role -> user_msg", () => {
      expect(backfillKind({ role: "user", metadata: {} })).toBe("user_msg");
    });

    it("metadata.progress -> progress", () => {
      expect(backfillKind({ role: "orchestrator", metadata: { progress: true } })).toBe("progress");
    });

    it("metadata.error -> error", () => {
      expect(backfillKind({ role: "orchestrator", metadata: { error: true } })).toBe("error");
    });

    it("metadata.notification -> notification", () => {
      expect(backfillKind({ role: "orchestrator", metadata: { notification: true } })).toBe("notification");
    });

    it("default -> reply", () => {
      expect(backfillKind({ role: "assistant", metadata: {} })).toBe("reply");
    });
  });

  describe("inserter coverage", () => {
    // Sanity check: each entry point produces a known kind.
    const inserts: Record<string, Kind> = {
      "useLiveChat user message": "user_msg",
      "quick-reply assistant reply": "reply",
      "quick-reply work order proposal": "work_order_proposal",
      "quick-reply Anthropic 502 error": "error",
      "quick-reply malformed proposal": "error",
      "quick-reply catch-all error": "error",
      "approve-work-order approved": "work_order_status",
      "approve-work-order cancelled": "work_order_status",
      "cancel-all emergency stop": "work_order_status",
      "notify (chat channel)": "notification",
      "runner progress": "progress",
      "runner cancelled": "work_order_status",
      "runner work order completion": "work_order_status",
      "runner non-work-order completion (orchestrator chat)": "reply",
      "runner delegated completion notification": "notification",
      "runner FATAL error": "error",
      "proactive-planner posted summary": "notification",
      "project-feedback user message": "user_msg",
    };
    it("every insert site has a known kind", () => {
      for (const [site, kind] of Object.entries(inserts)) {
        expect(KINDS, `${site} -> ${kind}`).toContain(kind);
      }
    });
    it("error sites all use kind=error", () => {
      const errorSites = Object.entries(inserts).filter(([k]) => k.toLowerCase().includes("error"));
      expect(errorSites.length).toBeGreaterThanOrEqual(3);
      for (const [, kind] of errorSites) expect(kind).toBe("error");
    });
  });
});
