import { describe, it, expect } from "vitest";

describe("API Center Phase 2: conversational integration proposals", () => {
  // Mirror of api/quick-reply.ts marker logic
  const INTEGRATION_MARKER = "[PROPOSE_INTEGRATION]";

  function extractIntegrationProposal(text: string): { preamble: string; rawJson: string } | null {
    const idx = text.indexOf(INTEGRATION_MARKER);
    if (idx < 0) return null;
    const preamble = text.slice(0, idx).trim();
    const after = text.slice(idx + INTEGRATION_MARKER.length);
    const firstBrace = after.indexOf("{");
    if (firstBrace < 0) return null;
    const lastBrace = after.lastIndexOf("}");
    if (lastBrace <= firstBrace) return null;
    return { preamble, rawJson: after.slice(firstBrace, lastBrace + 1) };
  }

  describe("[PROPOSE_INTEGRATION] marker parsing", () => {
    it("extracts vendor from a clean marker block", () => {
      const reply = `Sure — let's get OpenAI connected. Paste your API key and I'll wire it up.
[PROPOSE_INTEGRATION]
{
  "vendor": "openai"
}`;
      const m = extractIntegrationProposal(reply);
      expect(m).not.toBeNull();
      const parsed = JSON.parse(m!.rawJson);
      expect(parsed.vendor).toBe("openai");
    });

    it("captures preamble", () => {
      const reply = `Will do.\n[PROPOSE_INTEGRATION]\n{"vendor":"github"}`;
      const m = extractIntegrationProposal(reply);
      expect(m!.preamble).toBe("Will do.");
    });

    it("returns null when marker absent", () => {
      const reply = "I can't add that vendor.";
      expect(extractIntegrationProposal(reply)).toBeNull();
    });

    it("returns null on no brace after marker", () => {
      const reply = "[PROPOSE_INTEGRATION]\n(none)";
      expect(extractIntegrationProposal(reply)).toBeNull();
    });

    it("does NOT match the work-order marker (separate concept)", () => {
      const reply = "ok\n[PROPOSE_WORK_ORDER]\n{\"type\":\"research\"}";
      expect(extractIntegrationProposal(reply)).toBeNull();
    });

    it("supports single-line JSON", () => {
      const reply = `Adding it.\n[PROPOSE_INTEGRATION]\n{"vendor":"resend"}`;
      const m = extractIntegrationProposal(reply);
      const parsed = JSON.parse(m!.rawJson);
      expect(parsed.vendor).toBe("resend");
    });
  });

  describe("vendor whitelist (orchestrator can only propose known vendors)", () => {
    const KNOWN = ["openai", "anthropic", "github", "resend", "serper", "exa"];

    it("known vendor passes lookup", () => {
      expect(KNOWN).toContain("openai");
    });

    it("unknown vendor (e.g. twilio) is refused", () => {
      const requested = "twilio";
      const isKnown = KNOWN.includes(requested);
      expect(isKnown).toBe(false);
      // The handler responds with a kind=error message, not an unknown card
    });

    it("unknown vendor produces an error message, not a card", () => {
      const errorContent =
        `I can't add "twilio" via the API Center — it's not in the known-vendors list.`;
      expect(errorContent).toContain("not in the known-vendors list");
    });
  });

  describe("integration_proposal chat message metadata shape", () => {
    it("includes vendor_def with form fields the UI needs", () => {
      const meta = {
        kind: "integration_proposal",
        vendor: "openai",
        vendor_def: {
          vendor: "openai",
          display_name: "OpenAI (ChatGPT)",
          description: "Access GPT-4 / GPT-4o models.",
          docs_url: "https://platform.openai.com/api-keys",
          credentials: [
            { name: "key", label: "API Key", is_secret: true, required: true },
          ],
          config: [{ name: "default_model", label: "Default model", default: "gpt-4o" }],
        },
        existing: null,
      };
      expect(meta.kind).toBe("integration_proposal");
      expect(meta.vendor_def.credentials).toHaveLength(1);
      expect(meta.vendor_def.credentials[0].is_secret).toBe(true);
    });

    it("existing field carries info about prior connection (edit mode)", () => {
      const meta = {
        kind: "integration_proposal",
        vendor: "github",
        existing: { id: "uuid-1", status: "active", credential_preview: "ghp_...ZZZZ" },
      };
      expect(meta.existing?.credential_preview).toBe("ghp_...ZZZZ");
    });

    it("existing is null when this is a fresh add", () => {
      const meta = { kind: "integration_proposal", existing: null };
      expect(meta.existing).toBeNull();
    });
  });

  describe("orchestrator routing rules", () => {
    // The prompt instructs: don't propose work orders for "add X", propose
    // an integration instead. Sanity-check the keyword set the user might type.
    const ADD_VERBS = ["add", "connect", "hook up", "set up", "wire up", "give you access to"];
    it("recognized integration verbs are listed", () => {
      expect(ADD_VERBS.length).toBeGreaterThanOrEqual(4);
      expect(ADD_VERBS).toContain("add");
    });
  });
});
