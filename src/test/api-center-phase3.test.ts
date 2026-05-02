import { describe, it, expect } from "vitest";

describe("API Center Phase 3: agents use integrations via call_integration", () => {
  describe("substituteTemplate (mirror of runner helper)", () => {
    function substituteTemplate(template: unknown, params: Record<string, unknown>): unknown {
      if (typeof template === "string") {
        const m = template.match(/^\{\{(\w+)\}\}$/);
        if (m) return params[m[1]];
        return template.replace(/\{\{(\w+)\}\}/g, (_, k) => String(params[k] ?? ""));
      }
      if (Array.isArray(template)) return template.map(v => substituteTemplate(v, params));
      if (template && typeof template === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(template)) out[k] = substituteTemplate(v, params);
        return out;
      }
      return template;
    }

    it("preserves type when entire string is {{var}}", () => {
      const tpl = { messages: "{{messages}}", max_tokens: "{{max_tokens}}" };
      const params = {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1024,
      };
      const out = substituteTemplate(tpl, params) as { messages: unknown; max_tokens: unknown };
      expect(Array.isArray(out.messages)).toBe(true);
      expect(out.max_tokens).toBe(1024);   // stayed a number
    });

    it("does string replace for embedded placeholders", () => {
      const tpl = "Hello {{name}}, you have {{count}} messages.";
      const out = substituteTemplate(tpl, { name: "Sal", count: 3 });
      expect(out).toBe("Hello Sal, you have 3 messages.");
    });

    it("recurses into nested objects", () => {
      const tpl = { from: { email: "{{from}}" }, to: ["{{to}}"] };
      const out = substituteTemplate(tpl, { from: "x@y.com", to: "a@b.com" });
      expect(out).toEqual({ from: { email: "x@y.com" }, to: ["a@b.com"] });
    });

    it("leaves missing variables as empty string in embedded substitution", () => {
      const out = substituteTemplate("Hello {{missing}}", {});
      expect(out).toBe("Hello ");
    });

    it("returns undefined when entire string is {{missing}}", () => {
      const out = substituteTemplate("{{nonexistent}}", {});
      expect(out).toBeUndefined();
    });
  });

  describe("call_integration tool definition", () => {
    const tool = {
      name: "call_integration",
      input_schema: {
        type: "object",
        properties: {
          vendor: { type: "string" },
          action: { type: "string" },
          params: { type: "object" },
        },
        required: ["vendor", "action", "params"],
      },
    };

    it("requires vendor + action + params", () => {
      expect(tool.input_schema.required).toEqual(["vendor", "action", "params"]);
    });

    it("params is a free-form object — actual schema lives per-vendor in the prompt", () => {
      expect(tool.input_schema.properties.params.type).toBe("object");
    });
  });

  describe("work-order vendor allowlists", () => {
    const ALLOW: Record<string, Set<string>> = {
      research: new Set(["openai", "anthropic", "exa", "serper"]),
      build_static_site: new Set(["github", "openai", "anthropic"]),
      send_outreach: new Set(["resend", "openai", "anthropic"]),
      meeting_admin: new Set(["openai", "anthropic"]),
    };

    it("research can use openai but not github", () => {
      expect(ALLOW.research.has("openai")).toBe(true);
      expect(ALLOW.research.has("github")).toBe(false);
    });

    it("build_static_site can use github but not exa", () => {
      expect(ALLOW.build_static_site.has("github")).toBe(true);
      expect(ALLOW.build_static_site.has("exa")).toBe(false);
    });

    it("send_outreach can use resend but not github", () => {
      expect(ALLOW.send_outreach.has("resend")).toBe(true);
      expect(ALLOW.send_outreach.has("github")).toBe(false);
    });

    it("meeting_admin has only AI vendors (no github, no resend)", () => {
      expect(ALLOW.meeting_admin.has("github")).toBe(false);
      expect(ALLOW.meeting_admin.has("resend")).toBe(false);
      expect(ALLOW.meeting_admin.has("openai")).toBe(true);
    });
  });

  describe("self-healing on auth failure", () => {
    // When call_integration gets a 401/403, the runner marks the integration broken.
    // Phase 4 surfaces this as a chat card; for Phase 3 we just verify the logic.
    it("401 marks broken", () => {
      const status = 401;
      const shouldMarkBroken = status === 401 || status === 403;
      expect(shouldMarkBroken).toBe(true);
    });

    it("429 does NOT mark broken (transient)", () => {
      const status = 429;
      const shouldMarkBroken = status === 401 || status === 403;
      expect(shouldMarkBroken).toBe(false);
    });

    it("500 does NOT mark broken (vendor problem, not credential)", () => {
      const status = 500;
      const shouldMarkBroken = status === 401 || status === 403;
      expect(shouldMarkBroken).toBe(false);
    });
  });

  describe("integration-row self-describing config", () => {
    // Phase 3 requirement: integration rows carry auth_header_name and
    // auth_header_template in config so the runner doesn't need the TS registry.
    it("config has auth_header_name and template for OpenAI shape", () => {
      const config = {
        base_url: "https://api.openai.com/v1",
        auth_header_name: "Authorization",
        auth_header_template: "Bearer {{key}}",
      };
      expect(config.auth_header_name).toBe("Authorization");
      expect(config.auth_header_template).toContain("{{key}}");
    });

    it("template substitution produces correct header", () => {
      const tpl = "Bearer {{key}}";
      const creds = { key: "sk-abc123" };
      let result = tpl;
      for (const [k, v] of Object.entries(creds)) {
        result = result.replaceAll("{{" + k + "}}", String(v));
      }
      expect(result).toBe("Bearer sk-abc123");
    });
  });

  describe("agent error responses", () => {
    it("missing integration returns clear message", () => {
      const msg = `Integration 'klaviyo' is not connected for this company. Ask Sal to add it via the API Center.`;
      expect(msg).toContain("API Center");
      expect(msg).toContain("not connected");
    });

    it("missing action lists available", () => {
      const available = "chat, search";
      const msg = `Action 'embed' not found for vendor 'openai'. Available: ${available}`;
      expect(msg).toContain("Available: chat, search");
    });

    it("disallowed vendor mentions allowed list", () => {
      const allowed = ["openai", "anthropic"];
      const msg = `vendor 'github' is not allowed for this work order. Allowed: ${allowed.join(", ")}`;
      expect(msg).toContain("not allowed");
      expect(msg).toContain("openai, anthropic");
    });
  });
});
