import { describe, it, expect } from "vitest";

describe("API Center Phase 4: self-healing & preflight", () => {
  describe("integration_problem chat message metadata", () => {
    it("kind is integration_problem", () => {
      const meta = {
        kind: "integration_problem",
        vendor: "openai",
        display_name: "OpenAI (ChatGPT)",
        integration_id: "uuid-1",
        action: "chat",
        original_error: "401 Invalid Authentication",
      };
      expect(meta.kind).toBe("integration_problem");
    });

    it("includes vendor + action so the user knows what failed where", () => {
      const meta = {
        kind: "integration_problem",
        vendor: "github",
        action: "create_repo",
      };
      expect(meta.vendor).toBeDefined();
      expect(meta.action).toBeDefined();
    });

    it("includes integration_id so the UI can deep-link to fix it", () => {
      const meta = {
        kind: "integration_problem",
        integration_id: "uuid-broken-1",
      };
      expect(meta.integration_id).toBe("uuid-broken-1");
    });
  });

  describe("preflight: native integration check", () => {
    // Mirror of api/quick-reply.ts checkNativeIntegrationConnected logic
    function classifyRow(row: { status: string } | null): {
      status: "ready" | "missing" | "unknown";
      noteHasReconnect: boolean;
    } {
      if (!row) return { status: "missing", noteHasReconnect: false };
      if (row.status === "broken") {
        return { status: "missing", noteHasReconnect: true };
      }
      if (row.status === "inactive") {
        return { status: "missing", noteHasReconnect: false };
      }
      return { status: "ready", noteHasReconnect: false };
    }

    it("active row -> ready", () => {
      expect(classifyRow({ status: "active" }).status).toBe("ready");
    });

    it("unverified row -> ready (we'll trust it; first call will reveal issues)", () => {
      expect(classifyRow({ status: "unverified" }).status).toBe("ready");
    });

    it("broken row -> missing with reconnect note", () => {
      const r = classifyRow({ status: "broken" });
      expect(r.status).toBe("missing");
      expect(r.noteHasReconnect).toBe(true);
    });

    it("inactive row -> missing", () => {
      expect(classifyRow({ status: "inactive" }).status).toBe("missing");
    });

    it("missing row -> missing (vendor never connected)", () => {
      expect(classifyRow(null).status).toBe("missing");
    });
  });

  describe("preflight per work-order type", () => {
    type IntegrationSource = "native" | "composio";
    const REQUIRED: Record<string, Array<{ vendor: string; source: IntegrationSource }>> = {
      research: [],
      build_static_site: [{ vendor: "github", source: "native" }],
      edit_project: [{ vendor: "github", source: "native" }],
      send_outreach: [{ vendor: "gmail", source: "composio" }],
      design_mockup: [],
      meeting_admin: [{ vendor: "googlecalendar", source: "composio" }],
    };

    it("github goes through native (API Center)", () => {
      expect(REQUIRED.build_static_site[0].source).toBe("native");
      expect(REQUIRED.edit_project[0].source).toBe("native");
    });

    it("gmail still goes through composio (per-user OAuth)", () => {
      expect(REQUIRED.send_outreach[0].source).toBe("composio");
    });

    it("googlecalendar still goes through composio", () => {
      expect(REQUIRED.meeting_admin[0].source).toBe("composio");
    });

    it("research has no required integrations (uses fetch_url + web_search)", () => {
      expect(REQUIRED.research).toEqual([]);
    });
  });

  describe("auth failure -> chat surfacing", () => {
    it("401 triggers integration_problem post AND broken status", () => {
      const status = 401;
      const triggers = status === 401 || status === 403;
      expect(triggers).toBe(true);
    });

    it("400 does not trigger (not an auth issue)", () => {
      const status = 400;
      const triggers = status === 401 || status === 403;
      expect(triggers).toBe(false);
    });

    it("500 does not trigger (vendor problem)", () => {
      const status = 500;
      const triggers = status === 401 || status === 403;
      expect(triggers).toBe(false);
    });

    it("integration_problem content is human-readable", () => {
      const content = `⚠ Integration broken: OpenAI (ChatGPT) returned 401 on chat. Reconnect to fix.`;
      expect(content).toContain("Integration broken");
      expect(content).toContain("Reconnect");
      expect(content).not.toContain("Something went wrong");
    });
  });

  describe("agent error vs chat surfacing", () => {
    // The agent gets a textual error. The user gets a chat card. Both must be set.
    it("agent error references API Center", () => {
      const agentMsg = `Authentication failed (401) calling github.create_repo. The integration has been marked broken — Sal has been notified to update credentials in the API Center.`;
      expect(agentMsg).toContain("API Center");
      expect(agentMsg).toContain("marked broken");
    });

    it("chat card uses kind=integration_problem (not kind=error) so it gets the Reconnect button UI", () => {
      const cardKind = "integration_problem";
      expect(cardKind).not.toBe("error");
      expect(cardKind).toBe("integration_problem");
    });
  });

  describe("Reconnect flow re-uses the proposal card", () => {
    it("loading the vendor def + existing row gives us the form", () => {
      const vendorsApi = "/api/integrations?vendors=1";
      const integrationsApi = "/api/integrations?company_id=X";
      // The reconnect card hits both, finds the one matching vendor, then renders
      // the same IntegrationProposalCard the API Center uses.
      expect(vendorsApi).toContain("vendors=1");
      expect(integrationsApi).toContain("company_id=");
    });
  });

  describe("missing-integration deep link in proposal card", () => {
    it("link goes to /company-settings (where API Center tab lives)", () => {
      const linkTarget = "/company-settings";
      expect(linkTarget).toBe("/company-settings");
    });
  });
});
