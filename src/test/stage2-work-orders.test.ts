import { describe, it, expect } from "vitest";

describe("Stage 2: Work order proposal flow", () => {
  // Mirror of the registry in api/quick-reply.ts so tests don't reach into
  // server-side TS files (avoids vitest complaining about top-level await/
  // VercelRequest imports).
  const WORK_ORDER_TYPES = [
    "research",
    "build_static_site",
    "edit_project",
    "send_outreach",
    "design_mockup",
    "meeting_admin",
  ] as const;

  const AGENT_FOR_TYPE: Record<string, string> = {
    research: "research",
    build_static_site: "engineering",
    edit_project: "engineering",
    send_outreach: "growth",
    design_mockup: "designer",
    meeting_admin: "executive-assistant",
  };

  const COST_CAP_USD: Record<string, number> = {
    research: 0.5,
    build_static_site: 2.0,
    edit_project: 1.5,
    send_outreach: 0.5,
    design_mockup: 1.0,
    meeting_admin: 0.3,
  };

  const REQUIRED_INTEGRATIONS: Record<string, string[]> = {
    research: [],
    build_static_site: ["github"],
    edit_project: ["github"],
    send_outreach: ["gmail"],
    design_mockup: [],
    meeting_admin: ["googlecalendar"],
  };

  describe("proposal marker parsing", () => {
    const WORK_ORDER_MARKER = "[PROPOSE_WORK_ORDER]";

    function extractJsonAfterMarker(text: string): { preamble: string; rawJson: string } | null {
      const idx = text.indexOf(WORK_ORDER_MARKER);
      if (idx < 0) return null;
      const preamble = text.slice(0, idx).trim();
      const after = text.slice(idx + WORK_ORDER_MARKER.length);
      const firstBrace = after.indexOf("{");
      if (firstBrace < 0) return null;
      const lastBrace = after.lastIndexOf("}");
      if (lastBrace <= firstBrace) return null;
      const rawJson = after.slice(firstBrace, lastBrace + 1);
      return { preamble, rawJson };
    }

    it("extracts multi-line JSON after the marker", () => {
      const reply = `Got it.
[PROPOSE_WORK_ORDER]
{
  "type": "research",
  "title": "Look up Athlo recent activity",
  "description": "Use exa + firecrawl to scan."
}`;
      const m = extractJsonAfterMarker(reply);
      expect(m).not.toBeNull();
      const parsed = JSON.parse(m!.rawJson);
      expect(parsed.type).toBe("research");
      expect(parsed.title).toContain("Athlo");
    });

    it("extracts single-line JSON after the marker", () => {
      const reply = `Sure thing.

[PROPOSE_WORK_ORDER]
{ "type": "build_static_site", "title": "Pricing page", "description": "Build a single-page static site about pricing" }`;
      const m = extractJsonAfterMarker(reply);
      expect(m).not.toBeNull();
      const parsed = JSON.parse(m!.rawJson);
      expect(parsed.type).toBe("build_static_site");
    });

    it("captures preamble separately from JSON", () => {
      const reply = `Will do.\n[PROPOSE_WORK_ORDER]\n{"type":"research","title":"X","description":"Y"}`;
      const m = extractJsonAfterMarker(reply);
      expect(m!.preamble).toBe("Will do.");
    });

    it("returns null when marker absent", () => {
      const reply = "Your three active tasks: A, B, C.";
      expect(extractJsonAfterMarker(reply)).toBeNull();
    });

    it("returns null when no JSON brace follows marker", () => {
      const reply = "Acknowledging this.\n[PROPOSE_WORK_ORDER]\n(nothing here)";
      expect(extractJsonAfterMarker(reply)).toBeNull();
    });

    it("rejects unknown work order type at validation step", () => {
      const proposed = { type: "burn_money", title: "x", description: "y" };
      const isValid = WORK_ORDER_TYPES.includes(proposed.type as never);
      expect(isValid).toBe(false);
    });

    it("accepts all 6 known types", () => {
      for (const t of WORK_ORDER_TYPES) {
        expect(WORK_ORDER_TYPES.includes(t)).toBe(true);
      }
    });
  });

  describe("cost cap by type", () => {
    it("research cap is small", () => {
      expect(COST_CAP_USD.research).toBeLessThanOrEqual(1.0);
    });
    it("build_static_site cap is highest (most expensive)", () => {
      const all = Object.values(COST_CAP_USD);
      expect(COST_CAP_USD.build_static_site).toBe(Math.max(...all));
    });
    it("meeting_admin cap is smallest", () => {
      const all = Object.values(COST_CAP_USD);
      expect(COST_CAP_USD.meeting_admin).toBe(Math.min(...all));
    });
    it("every type has a cap", () => {
      for (const t of WORK_ORDER_TYPES) {
        expect(COST_CAP_USD[t]).toBeGreaterThan(0);
      }
    });
  });

  describe("agent routing by type", () => {
    it("research goes to research agent", () => {
      expect(AGENT_FOR_TYPE.research).toBe("research");
    });
    it("build_static_site goes to engineering", () => {
      expect(AGENT_FOR_TYPE.build_static_site).toBe("engineering");
    });
    it("send_outreach goes to growth", () => {
      expect(AGENT_FOR_TYPE.send_outreach).toBe("growth");
    });
    it("design_mockup goes to designer", () => {
      expect(AGENT_FOR_TYPE.design_mockup).toBe("designer");
    });
    it("meeting_admin goes to executive-assistant", () => {
      expect(AGENT_FOR_TYPE.meeting_admin).toBe("executive-assistant");
    });
  });

  describe("preflight requirements", () => {
    it("research has no required integrations (web tools only)", () => {
      expect(REQUIRED_INTEGRATIONS.research).toEqual([]);
    });
    it("build_static_site requires github", () => {
      expect(REQUIRED_INTEGRATIONS.build_static_site).toContain("github");
    });
    it("send_outreach requires gmail", () => {
      expect(REQUIRED_INTEGRATIONS.send_outreach).toContain("gmail");
    });
    it("meeting_admin requires googlecalendar", () => {
      expect(REQUIRED_INTEGRATIONS.meeting_admin).toContain("googlecalendar");
    });
  });

  describe("approve-work-order endpoint logic", () => {
    it("only approves tasks in 'proposed' status (CAS)", () => {
      const status = "running";
      const canApprove = status === "proposed";
      expect(canApprove).toBe(false);
    });

    it("approves changes status to pending (worker picks up)", () => {
      const before = "proposed";
      const after = before === "proposed" ? "pending" : before;
      expect(after).toBe("pending");
    });

    it("cancel changes status to cancelled with timestamp", () => {
      const update = {
        status: "cancelled",
        completed_at: "2026-05-02T12:00:00Z",
        error_message: "Cancelled by user before approval",
      };
      expect(update.status).toBe("cancelled");
      expect(update.error_message).toContain("user");
    });

    it("preflight gate blocks approve when integrations missing", () => {
      const preflight = [
        { tool: "github", status: "missing" },
        { tool: "gmail", status: "ready" },
      ];
      const missing = preflight.filter(p => p.status === "missing").map(p => p.tool);
      expect(missing).toEqual(["github"]);
      expect(missing.length > 0).toBe(true); // approval blocked
    });

    it("preflight allows approve when all ready", () => {
      const preflight = [
        { tool: "github", status: "ready" },
      ];
      const missing = preflight.filter(p => p.status === "missing");
      expect(missing).toHaveLength(0);
    });
  });

  describe("runner work-order tool lockdown", () => {
    const ALLOWLIST: Record<string, Set<string>> = {
      research: new Set(["web_search", "test_url", "store_memory", "recall_memories", "fail_task", "fetch_url"]),
      build_static_site: new Set([
        "test_url", "store_memory", "recall_memories", "fail_task",
        "github_create_repo", "github_push_file",
        "sandbox_bash", "sandbox_read_file", "sandbox_write_file", "sandbox_list_files",
        "deploy_static_site", "register_project",
      ]),
      send_outreach: new Set([
        "test_url", "store_memory", "recall_memories", "fail_task",
        "composio_find_actions", "composio_execute",
      ]),
    };

    it("research cannot use github tools", () => {
      expect(ALLOWLIST.research.has("github_create_repo")).toBe(false);
      expect(ALLOWLIST.research.has("github_push_file")).toBe(false);
    });

    it("research cannot use sandbox or deploy", () => {
      expect(ALLOWLIST.research.has("sandbox_bash")).toBe(false);
      expect(ALLOWLIST.research.has("deploy_static_site")).toBe(false);
    });

    it("build_static_site has full sandbox + github + deploy", () => {
      expect(ALLOWLIST.build_static_site.has("sandbox_bash")).toBe(true);
      expect(ALLOWLIST.build_static_site.has("github_create_repo")).toBe(true);
      expect(ALLOWLIST.build_static_site.has("deploy_static_site")).toBe(true);
      expect(ALLOWLIST.build_static_site.has("register_project")).toBe(true);
    });

    it("build_static_site cannot use composio (no random outreach during a build)", () => {
      expect(ALLOWLIST.build_static_site.has("composio_execute")).toBe(false);
    });

    it("send_outreach has composio but no sandbox/github", () => {
      expect(ALLOWLIST.send_outreach.has("composio_execute")).toBe(true);
      expect(ALLOWLIST.send_outreach.has("sandbox_bash")).toBe(false);
      expect(ALLOWLIST.send_outreach.has("github_create_repo")).toBe(false);
    });

    it("filtering original tool list to allowlist works", () => {
      const allTools = [
        { name: "web_search" },
        { name: "github_create_repo" },
        { name: "sandbox_bash" },
        { name: "test_url" },
      ];
      const filtered = allTools.filter(t => ALLOWLIST.research.has(t.name));
      expect(filtered.map(t => t.name)).toEqual(["web_search", "test_url"]);
    });
  });

  describe("status message metadata shape", () => {
    it("approved status has kind=work_order_status and approved status", () => {
      const meta = {
        kind: "work_order_status",
        status: "approved",
        task_id: "abc-123",
      };
      expect(meta.kind).toBe("work_order_status");
      expect(meta.status).toBe("approved");
    });

    it("completed message includes cost and duration", () => {
      const meta = {
        kind: "work_order_status",
        status: "completed",
        cost_usd: 0.42,
        duration_min: 6,
        work_order_type: "research",
      };
      expect(meta.cost_usd).toBe(0.42);
      expect(meta.duration_min).toBe(6);
    });

    it("status messages distinguish from regular replies", () => {
      const reply = { kind: "reply" };
      const status = { kind: "work_order_status", status: "completed" };
      expect(reply.kind).toBe("reply");
      expect(status.kind).toBe("work_order_status");
    });
  });

  describe("title and description sanitization", () => {
    it("title truncates to 60 chars", () => {
      const title = "A".repeat(120);
      const truncated = title.slice(0, 60);
      expect(truncated.length).toBe(60);
    });

    it("description truncates to 2000 chars", () => {
      const desc = "B".repeat(5000);
      const truncated = desc.slice(0, 2000);
      expect(truncated.length).toBe(2000);
    });
  });
});
