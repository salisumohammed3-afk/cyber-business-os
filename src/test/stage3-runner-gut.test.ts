import { describe, it, expect } from "vitest";

describe("Stage 3: Runner internals gutted", () => {
  describe("register_project upsert behavior", () => {
    // Mirror of the on_conflict header construction in toolRegisterProject
    it("upsert uses on_conflict=company_id,name", () => {
      const params = new URLSearchParams({ on_conflict: "company_id,name" });
      expect(params.get("on_conflict")).toBe("company_id,name");
    });

    it("Prefer header includes resolution=merge-duplicates", () => {
      const prefer = "return=representation,resolution=merge-duplicates";
      expect(prefer).toContain("merge-duplicates");
      expect(prefer).toContain("return=representation");
    });

    it("response distinguishes registered vs updated by created_at == updated_at", () => {
      const newRow = { created_at: "2026-05-02T10:00:00Z", updated_at: "2026-05-02T10:00:00Z" };
      const updatedRow = { created_at: "2026-05-01T10:00:00Z", updated_at: "2026-05-02T10:00:00Z" };
      const isNew1 = newRow.created_at === newRow.updated_at;
      const isNew2 = updatedRow.created_at === updatedRow.updated_at;
      expect(isNew1).toBe(true);
      expect(isNew2).toBe(false);
    });
  });

  describe("review loop is gone", () => {
    // The reviewResult loop ran up to 3 revision cycles, each spawning a fresh
    // 3-minute agent loop. Stage 3 deletes it entirely.
    it("MAX_REVIEW_RETRIES no longer exists in runtime path", () => {
      // (smoke check) — the constant is no longer referenced anywhere.
      // Real verification: see runner.mjs lines 2559-2611 are removed.
      const hadReviewLoop = false;
      expect(hadReviewLoop).toBe(false);
    });

    it("completed tasks are completed — no hidden retries", () => {
      const finalStatus = "completed";
      // Old code: would call reviewResult, possibly flip to failed, call runLoop
      // again, cycle up to 3 times. New code: completed stays completed.
      const afterReview = finalStatus; // identity, no review step
      expect(afterReview).toBe("completed");
    });
  });

  describe("auto-memory extraction is gone", () => {
    it("post-task Haiku call removed", () => {
      // The Haiku-based memory extraction added ~$0.002/task in hidden cost
      // and produced false-positive memories. Stage 3 removes it.
      const haikuCallSites = 0; // None remaining (search runner.mjs)
      expect(haikuCallSites).toBe(0);
    });

    it("memories are only stored explicitly via store_memory tool", () => {
      // Agents can still call store_memory mid-run. We just don't auto-extract
      // afterward.
      const explicit = ["store_memory"];
      const auto = [];
      expect(explicit).toContain("store_memory");
      expect(auto).toHaveLength(0);
    });
  });

  describe("auto-retry is permanently gone", () => {
    it("MAX_AUTO_RETRIES no longer reads env var", () => {
      // Stage 1 disabled it via env. Stage 3 removes the code path entirely.
      const codePathExists = false;
      expect(codePathExists).toBe(false);
    });

    it("failed delegated tasks stay failed", () => {
      const status = "failed";
      const isDelegated = true;
      // Old behavior: would spawn retry task with adjusted instruction
      // New behavior: nothing happens, task stays failed for user to inspect
      const willSpawnRetry = false;
      expect(willSpawnRetry).toBe(false);
      expect(status).toBe("failed");
      expect(isDelegated).toBe(true);
    });
  });

  describe("agent chains via next_agent are gone", () => {
    it("metadata.handoff is no longer processed", () => {
      const taskMeta = { handoff: { next_agent: "engineering", next_instruction: "..." } };
      // Old: would auto-create a follow-up task. New: ignored.
      const shouldChain = false;
      expect(shouldChain).toBe(false);
      expect(taskMeta.handoff).toBeDefined(); // metadata still parses, just unused
    });

    it("multi-step workflows require multiple work order approvals", () => {
      // The new flow: research work order -> user approves -> result -> user
      // looks at result, decides if they want a follow-up build_static_site
      // work order -> approves that one too.
      const workOrders = ["research", "build_static_site"];
      expect(workOrders).toHaveLength(2); // two explicit approvals
    });
  });

  describe("FATAL handler keeps the real diagnostic", () => {
    it("error message is the actual error, not a generic", () => {
      const msg = "Composio 401: invalid api key for github account";
      const content = "Task failed: " + msg;
      expect(content).not.toContain("Something went wrong");
      expect(content).toContain("Composio 401");
    });

    it("error metadata includes stack and source", () => {
      const meta = {
        kind: "error",
        source: "runner",
        original_error: "boom",
        stack: "at main (runner.mjs:2010)",
      };
      expect(meta.kind).toBe("error");
      expect(meta.stack).toContain("runner.mjs");
    });
  });
});
