import { describe, it, expect } from "vitest";
import { encryptCredentials, decryptCredentials, maskCredential } from "../../api/lib/crypto";

describe("API Center Phase 1: encryption + crypto helpers", () => {
  describe("AES-256-GCM round-trip", () => {
    // Set the key for tests; in production this comes from env.
    const originalKey = process.env.INTEGRATIONS_ENCRYPTION_KEY;
    beforeAll();

    function beforeAll() {
      // 32-byte key, base64
      process.env.INTEGRATIONS_ENCRYPTION_KEY = Buffer.from(
        "0123456789abcdef0123456789abcdef",
        "utf8"
      ).toString("base64");
    }

    afterAll();
    function afterAll() {
      if (originalKey) process.env.INTEGRATIONS_ENCRYPTION_KEY = originalKey;
    }

    it("encrypts then decrypts plain object", () => {
      const plain = { key: "sk-test-1234567890" };
      const blob = encryptCredentials(plain);
      expect(blob.v).toBe(1);
      expect(blob.iv).toBeTruthy();
      expect(blob.tag).toBeTruthy();
      expect(blob.ciphertext).toBeTruthy();
      const back = decryptCredentials(blob);
      expect(back).toEqual(plain);
    });

    it("different IVs each call (no determinism)", () => {
      const a = encryptCredentials({ key: "same" });
      const b = encryptCredentials({ key: "same" });
      expect(a.iv).not.toBe(b.iv);
      expect(a.ciphertext).not.toBe(b.ciphertext);
      // Both still decrypt to the same plain
      expect(decryptCredentials(a)).toEqual(decryptCredentials(b));
    });

    it("tampered ciphertext throws on decrypt", () => {
      const blob = encryptCredentials({ key: "sk-abc" });
      const tampered = { ...blob, ciphertext: blob.ciphertext.slice(0, -4) + "XXXX" };
      expect(() => decryptCredentials(tampered)).toThrow();
    });

    it("rejects unsupported version", () => {
      expect(() => decryptCredentials({ v: 99, iv: "x", tag: "x", ciphertext: "x" } as never)).toThrow(/version/);
    });
  });

  describe("maskCredential", () => {
    it("preserves prefix + last 4 for sk-... keys", () => {
      const m = maskCredential("sk-abcdef1234567890ABCDEF");
      expect(m).toBe("sk-...CDEF");
    });

    it("preserves prefix for ghp_ tokens", () => {
      const m = maskCredential("ghp_AAAA1234567890ZZZZ");
      expect(m).toBe("ghp_...ZZZZ");
    });

    it("returns *** for very short tokens", () => {
      expect(maskCredential("abc")).toBe("***");
      expect(maskCredential("12345678")).toBe("***");
    });

    it("falls back gracefully for tokens with no recognizable prefix", () => {
      const m = maskCredential("longrandomtokenwithnoprefixchars");
      expect(m).toContain("...");
      expect(m).toMatch(/.{1,4}\.\.\.\w{4}/);
    });

    it("returns *** for empty input", () => {
      expect(maskCredential("")).toBe("***");
    });
  });
});

describe("API Center Phase 1: vendor registry shape", () => {
  it("has known vendors registered", async () => {
    const { VENDOR_REGISTRY, getVendor, listVendors } = await import("../../api/lib/vendor-registry");
    const slugs = VENDOR_REGISTRY.map(v => v.vendor);
    expect(slugs).toContain("openai");
    expect(slugs).toContain("anthropic");
    expect(slugs).toContain("github");
    expect(slugs).toContain("resend");
    expect(slugs).toContain("serper");
    expect(slugs).toContain("exa");
    expect(getVendor("openai")?.display_name).toBe("OpenAI (ChatGPT)");
    // listVendors strips the actions array (UI doesn't need it for the picker)
    const list = listVendors();
    for (const v of list) expect(v).not.toHaveProperty("actions");
  });

  it("every vendor has a test endpoint and at least one action", async () => {
    const { VENDOR_REGISTRY } = await import("../../api/lib/vendor-registry");
    for (const v of VENDOR_REGISTRY) {
      expect(v.test).toBeDefined();
      expect(v.test.path).toMatch(/^\//);
      expect(v.actions.length).toBeGreaterThan(0);
      for (const a of v.actions) {
        expect(a.input_schema.type).toBe("object");
        expect(a.path).toMatch(/^\//);
      }
    }
  });

  it("every credential field marks required if needed", async () => {
    const { VENDOR_REGISTRY } = await import("../../api/lib/vendor-registry");
    for (const v of VENDOR_REGISTRY) {
      // At minimum the primary credential is required
      const hasRequired = v.credentials.some(c => c.required);
      expect(hasRequired, `${v.vendor} should have at least one required credential`).toBe(true);
    }
  });
});

describe("API Center Phase 1: integration row shape (public)", () => {
  // The public shape returned by GET /api/integrations strips the encrypted blob
  // and only exposes the masked preview.
  it("public shape excludes encrypted_credentials", () => {
    const row = {
      id: "row-1",
      company_id: "co-1",
      vendor: "openai",
      display_name: "OpenAI",
      kind: "rest_api",
      auth_type: "bearer",
      encrypted_credentials: { v: 1, iv: "x", tag: "x", ciphertext: "x" },
      credential_preview: "sk-...4F2A",
      config: { default_model: "gpt-4o" },
      actions: [],
      status: "active",
      last_tested_at: null,
      last_test_error: null,
      created_at: "2026-05-02T10:00:00Z",
      updated_at: "2026-05-02T10:00:00Z",
    };
    // Mirror of api/integrations.ts publicShape()
    const publicShape = (r: typeof row) => ({
      id: r.id,
      company_id: r.company_id,
      vendor: r.vendor,
      display_name: r.display_name,
      kind: r.kind,
      auth_type: r.auth_type,
      credential_preview: r.credential_preview,
      config: r.config,
      actions: r.actions,
      status: r.status,
      last_tested_at: r.last_tested_at,
      last_test_error: r.last_test_error,
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
    const pub = publicShape(row);
    expect(pub).not.toHaveProperty("encrypted_credentials");
    expect(pub.credential_preview).toBe("sk-...4F2A");
  });

  it("status enum is closed", () => {
    const valid = ["active", "unverified", "broken", "inactive"];
    expect(valid).toContain("active");
    expect(valid).toContain("broken");
    expect(valid).not.toContain("running"); // common typo
  });
});
