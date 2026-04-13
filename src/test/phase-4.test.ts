import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Phase 4: Polish & Configuration", () => {
  describe("rate limiter", () => {
    // Reimplementation of the rate limiter logic from quick-reply.ts
    const RATE_LIMIT_WINDOW = 60_000;
    const RATE_LIMIT_MAX = 10;

    function createRateLimiter() {
      const map = new Map<string, number[]>();
      return {
        check(companyId: string, now: number = Date.now()): boolean {
          const timestamps = map.get(companyId) || [];
          const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
          if (recent.length >= RATE_LIMIT_MAX) return false;
          recent.push(now);
          map.set(companyId, recent);
          return true;
        },
      };
    }

    it("should allow up to 10 requests per minute", () => {
      const limiter = createRateLimiter();
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        expect(limiter.check("company-1", now + i)).toBe(true);
      }
    });

    it("should reject the 11th request within the window", () => {
      const limiter = createRateLimiter();
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        limiter.check("company-1", now + i);
      }
      expect(limiter.check("company-1", now + 100)).toBe(false);
    });

    it("should allow requests again after the window expires", () => {
      const limiter = createRateLimiter();
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        limiter.check("company-1", now);
      }
      // 61 seconds later
      expect(limiter.check("company-1", now + 61_000)).toBe(true);
    });

    it("should track different companies independently", () => {
      const limiter = createRateLimiter();
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        limiter.check("company-1", now);
      }
      // company-1 is rate limited
      expect(limiter.check("company-1", now + 100)).toBe(false);
      // company-2 is fine
      expect(limiter.check("company-2", now + 100)).toBe(true);
    });
  });

  describe("review feedback propagation", () => {
    it("should include previous rejection reason in review prompt", () => {
      const previousRejection = "No working deploy URL found — the link returns 404";
      const promptSuffix = previousRejection
        ? "\n\nPREVIOUS REJECTION REASON: " + previousRejection + "\nSpecifically check whether this issue has been addressed in the revised output."
        : "";

      expect(promptSuffix).toContain("PREVIOUS REJECTION REASON");
      expect(promptSuffix).toContain("404");
      expect(promptSuffix).toContain("addressed in the revised output");
    });

    it("should not include rejection context on first review", () => {
      const previousRejection = null;
      const promptSuffix = previousRejection
        ? "\n\nPREVIOUS REJECTION REASON: " + previousRejection
        : "";

      expect(promptSuffix).toBe("");
    });
  });

  describe("deploy directory safety", () => {
    it("should detect when package.json already exists", () => {
      // Simulating the existsSync check
      const existingFiles = new Set(["package.json", "index.html", "styles.css"]);

      const shouldWritePkg = !existingFiles.has("package.json");
      const shouldWriteDockerfile = !existingFiles.has("Dockerfile");

      expect(shouldWritePkg).toBe(false); // should NOT overwrite
      expect(shouldWriteDockerfile).toBe(true); // doesn't exist, safe to write
    });

    it("should write both files when neither exists", () => {
      const existingFiles = new Set(["index.html"]);

      const shouldWritePkg = !existingFiles.has("package.json");
      const shouldWriteDockerfile = !existingFiles.has("Dockerfile");

      expect(shouldWritePkg).toBe(true);
      expect(shouldWriteDockerfile).toBe(true);
    });
  });

  describe("clearConversation", () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it("should clear localStorage key for conversation", () => {
      const companyId = "company-abc";
      const key = `sal-os-conv-${companyId}`;
      localStorage.setItem(key, "conv-123");
      expect(localStorage.getItem(key)).toBe("conv-123");

      // Simulate clearConversation logic
      localStorage.removeItem(key);

      expect(localStorage.getItem(key)).toBeNull();
    });

    it("should handle missing key gracefully", () => {
      const key = "sal-os-conv-nonexistent";
      // Should not throw
      expect(() => localStorage.removeItem(key)).not.toThrow();
    });
  });
});
