// Known vendors. Each entry is what the API Center / orchestrator needs to
// (a) ask the user for the right credentials, (b) test the connection, and
// (c) seed an action catalog so agents can call the service.
//
// Adding a new "Tier 1 known vendor": add an entry here. The API Center page
// reads from this list to populate the vendor dropdown. The conversational
// add flow uses these fields to drive the form card.
//
// Tier 2 (custom REST APIs the user defines themselves) is NOT here — those
// rows are created without a registry match; the user provides the action
// shape via the UI directly. (Future Tier 2 form lives in this same module.)

export type AuthType = "api_key" | "bearer" | "basic" | "none" | "jwt_es256";

export interface CredentialField {
  name: string;            // key in the credentials object, e.g. "api_key"
  label: string;           // shown to user
  description?: string;    // help text, e.g. "Get from platform.openai.com"
  placeholder?: string;
  is_secret: boolean;
  required: boolean;
}

export interface ConfigField {
  name: string;
  label: string;
  description?: string;
  default?: string;
  required?: boolean;
}

export interface VendorAction {
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;                          // appended to base_url. May contain {{var}} placeholders.
  body_template?: Record<string, unknown>; // JSON template; {{var}} substitution from input.
  // Substitution rules (handled in runner):
  //   - If a string value is exactly "{{var}}", replace with raw params.var (preserves type).
  //   - Otherwise do plain string substitution within the value.
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; description?: string; enum?: string[]; items?: unknown }>;
    required?: string[];
  };
}

export interface VendorDef {
  vendor: string;             // canonical slug
  display_name: string;
  category: "ai" | "git" | "email" | "crm" | "scraping" | "search" | "data" | "other";
  description: string;
  docs_url: string;
  auth_type: AuthType;
  base_url: string;
  // How to inject the credential into HTTP calls. Built once at runner-side
  // when issuing the request.
  auth_header_template?: string; // e.g. "Bearer {{key}}"  or  "{{key}}" for raw API keys
  auth_header_name?: string;     // e.g. "Authorization", "x-api-key"
  // What the user must provide
  credentials: CredentialField[];
  // Optional knobs (base_url override, default model, etc.)
  config: ConfigField[];
  // Used by /api/integrations/:id/test — a known-safe GET that proves the key works
  test: {
    method: "GET" | "POST";
    path: string;            // appended to base_url
    expect_status?: number;  // default 200
  };
  // Default action catalog the agent gets to call
  actions: VendorAction[];
}

export const VENDOR_REGISTRY: VendorDef[] = [
  {
    vendor: "openai",
    display_name: "OpenAI (ChatGPT)",
    category: "ai",
    description: "Access GPT-4 / GPT-4o / o1 models for chat, reasoning, and tool use.",
    docs_url: "https://platform.openai.com/api-keys",
    auth_type: "bearer",
    base_url: "https://api.openai.com/v1",
    auth_header_name: "Authorization",
    auth_header_template: "Bearer {{key}}",
    credentials: [
      {
        name: "key",
        label: "API Key",
        description: "Get from platform.openai.com/api-keys (starts with sk-)",
        placeholder: "sk-...",
        is_secret: true,
        required: true,
      },
    ],
    // No user-facing config knobs — system picks the best model per call.
    // Agents using `call_integration` should default to gpt-4o unless there's
    // a specific reason for o1 / o1-mini.
    config: [],
    test: { method: "GET", path: "/models" },
    actions: [
      {
        name: "chat",
        description:
          "Send a chat completion request to OpenAI. Returns the model's response. " +
          "Just pass `messages` — model defaults to gpt-4o, max_tokens to 2048, temperature to 0.7. " +
          "Override only if you specifically need o1 reasoning or custom limits.",
        method: "POST",
        path: "/chat/completions",
        body_template: {
          model: "{{model}}",
          messages: "{{messages}}",
          max_tokens: "{{max_tokens}}",
          temperature: "{{temperature}}",
        },
        input_schema: {
          type: "object",
          properties: {
            messages: {
              type: "array",
              description: "Array of {role, content} objects. Roles: system, user, assistant.",
              items: { type: "object" },
            },
            model: { type: "string", description: "Optional. Default gpt-4o. Use o1-preview for hard reasoning." },
            max_tokens: { type: "number", description: "Optional. Default 2048." },
            temperature: { type: "number", description: "Optional. Default 0.7. Range 0.0 - 2.0." },
          },
          required: ["messages"],
        },
      },
    ],
  },
  {
    vendor: "anthropic",
    display_name: "Anthropic (Claude)",
    category: "ai",
    description: "Direct access to Claude — separate from the platform's built-in usage.",
    docs_url: "https://console.anthropic.com/settings/keys",
    auth_type: "api_key",
    base_url: "https://api.anthropic.com/v1",
    auth_header_name: "x-api-key",
    auth_header_template: "{{key}}",
    credentials: [
      {
        name: "key",
        label: "API Key",
        description: "Get from console.anthropic.com (starts with sk-ant-)",
        placeholder: "sk-ant-...",
        is_secret: true,
        required: true,
      },
    ],
    // No user-facing config knobs — system picks the latest Sonnet by default.
    config: [],
    test: { method: "POST", path: "/messages", expect_status: 400 },
    // ^ /messages requires a body; an empty POST returns 400 if the key is valid,
    //   401/403 if it isn't. We treat 400 as "auth ok" for the probe.
    actions: [
      {
        name: "messages",
        description:
          "Call Claude's messages API directly. Just pass `messages` — model defaults to " +
          "claude-sonnet-4-20250514, max_tokens to 2048. Override only if you need Opus or different limits.",
        method: "POST",
        path: "/messages",
        body_template: {
          model: "{{model}}",
          max_tokens: "{{max_tokens}}",
          messages: "{{messages}}",
        },
        input_schema: {
          type: "object",
          properties: {
            messages: {
              type: "array",
              description: "Array of {role, content} objects.",
              items: { type: "object" },
            },
            model: { type: "string", description: "Optional. Default claude-sonnet-4-20250514." },
            max_tokens: { type: "number", description: "Optional. Default 2048." },
          },
          required: ["messages"],
        },
      },
    ],
  },
  {
    vendor: "github",
    display_name: "GitHub",
    category: "git",
    description: "Create repos, push files, read repo contents.",
    docs_url: "https://github.com/settings/tokens",
    auth_type: "bearer",
    base_url: "https://api.github.com",
    auth_header_name: "Authorization",
    auth_header_template: "Bearer {{key}}",
    credentials: [
      {
        name: "key",
        label: "Personal Access Token",
        description: "github.com/settings/tokens — needs 'repo' scope (classic) or 'Contents: read & write' (fine-grained)",
        placeholder: "ghp_... or github_pat_...",
        is_secret: true,
        required: true,
      },
    ],
    config: [],
    test: { method: "GET", path: "/user" },
    actions: [
      {
        name: "create_repo",
        description: "Create a new repository on the authenticated user's account.",
        method: "POST",
        path: "/user/repos",
        body_template: {
          name: "{{name}}",
          description: "{{description}}",
          private: "{{private}}",
          auto_init: true,
        },
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Repo name (lowercase, hyphens)" },
            description: { type: "string" },
            private: { type: "boolean", description: "true to create private (default false)" },
          },
          required: ["name"],
        },
      },
    ],
  },
  {
    vendor: "resend",
    display_name: "Resend (Email)",
    category: "email",
    description: "Send transactional email via Resend's API.",
    docs_url: "https://resend.com/api-keys",
    auth_type: "bearer",
    base_url: "https://api.resend.com",
    auth_header_name: "Authorization",
    auth_header_template: "Bearer {{key}}",
    credentials: [
      {
        name: "key",
        label: "API Key",
        description: "resend.com/api-keys (starts with re_)",
        placeholder: "re_...",
        is_secret: true,
        required: true,
      },
    ],
    config: [
      {
        name: "from_email",
        label: "Default 'from' address",
        description: "Must be verified in Resend. e.g. digest@yourdomain.com",
      },
    ],
    test: { method: "GET", path: "/api-keys" },
    actions: [
      {
        name: "send",
        description: "Send a single email.",
        method: "POST",
        path: "/emails",
        body_template: {
          from: "{{from}}",
          to: "{{to}}",
          subject: "{{subject}}",
          html: "{{html}}",
        },
        input_schema: {
          type: "object",
          properties: {
            from: { type: "string", description: "From address (must be verified)" },
            to: { type: "string", description: "Recipient (string or comma-separated)" },
            subject: { type: "string" },
            html: { type: "string", description: "HTML body" },
          },
          required: ["to", "subject", "html"],
        },
      },
    ],
  },
  {
    vendor: "serper",
    display_name: "Serper (Google search)",
    category: "search",
    description: "Fast Google search results via Serper.dev.",
    docs_url: "https://serper.dev/api-key",
    auth_type: "api_key",
    base_url: "https://google.serper.dev",
    auth_header_name: "X-API-KEY",
    auth_header_template: "{{key}}",
    credentials: [
      {
        name: "key",
        label: "API Key",
        description: "serper.dev/api-key",
        placeholder: "...",
        is_secret: true,
        required: true,
      },
    ],
    config: [],
    test: { method: "POST", path: "/search", expect_status: 200 },
    actions: [
      {
        name: "search",
        description: "Run a Google search and return results.",
        method: "POST",
        path: "/search",
        body_template: { q: "{{q}}", num: "{{num}}" },
        input_schema: {
          type: "object",
          properties: {
            q: { type: "string", description: "Search query" },
            num: { type: "number", description: "Number of results (default 10)" },
          },
          required: ["q"],
        },
      },
    ],
  },
  {
    vendor: "appstoreconnect",
    display_name: "App Store Connect",
    category: "data",
    description:
      "Apple App Store Connect API. Read app analytics, builds, customer reviews, " +
      "TestFlight, App Store versions. Authentication is JWT ES256 signed per request.",
    docs_url: "https://appstoreconnect.apple.com/access/integrations/api",
    auth_type: "jwt_es256",
    base_url: "https://api.appstoreconnect.apple.com/v1",
    // For JWT auth, the runner signs a fresh token each call — header_template is
    // a placeholder that the runtime fills with the signed JWT.
    auth_header_name: "Authorization",
    auth_header_template: "Bearer {{__jwt__}}",
    credentials: [
      {
        name: "key_id",
        label: "Key ID",
        description: "From appstoreconnect.apple.com → Users and Access → Integrations → Keys (e.g. ABC123XYZ)",
        placeholder: "ABCDEF1234",
        is_secret: false,
        required: true,
      },
      {
        name: "issuer_id",
        label: "Issuer ID",
        description: "UUID at the top of the Keys page (every key under one team shares this)",
        placeholder: "00000000-0000-0000-0000-000000000000",
        is_secret: false,
        required: true,
      },
      {
        name: "private_key",
        label: "Private Key (.p8 file contents)",
        description:
          "Paste the FULL contents of the .p8 file including the -----BEGIN PRIVATE KEY----- " +
          "and -----END PRIVATE KEY----- lines. Apple only lets you download this once — keep a backup.",
        placeholder: "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
        is_secret: true,
        required: true,
      },
    ],
    config: [],
    test: { method: "GET", path: "/apps?limit=1" },
    actions: [
      {
        name: "list_apps",
        description: "List all apps in this team's App Store Connect account.",
        method: "GET",
        path: "/apps",
        input_schema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max apps (default 200, max 200)" },
          },
        },
      },
      {
        name: "get_app",
        description: "Fetch one app by App Store Connect id.",
        method: "GET",
        path: "/apps/{{app_id}}",
        input_schema: {
          type: "object",
          properties: { app_id: { type: "string", description: "App Store Connect app id (numeric string)" } },
          required: ["app_id"],
        },
      },
      {
        name: "list_builds",
        description: "List recent builds across all apps for this team.",
        method: "GET",
        path: "/builds?sort=-uploadedDate&limit={{limit}}",
        input_schema: {
          type: "object",
          properties: { limit: { type: "number", description: "Default 20, max 200" } },
        },
      },
      {
        name: "list_app_store_versions",
        description: "List App Store versions for one app (live + in-progress).",
        method: "GET",
        path: "/apps/{{app_id}}/appStoreVersions",
        input_schema: {
          type: "object",
          properties: { app_id: { type: "string" } },
          required: ["app_id"],
        },
      },
      {
        name: "list_customer_reviews",
        description: "List customer reviews for one app, newest first.",
        method: "GET",
        path: "/apps/{{app_id}}/customerReviews?sort=-createdDate&limit={{limit}}",
        input_schema: {
          type: "object",
          properties: {
            app_id: { type: "string" },
            limit: { type: "number", description: "Default 50, max 200" },
          },
          required: ["app_id"],
        },
      },
      {
        name: "list_beta_app_review_submissions",
        description: "TestFlight: list pending / approved beta review submissions.",
        method: "GET",
        path: "/betaAppReviewSubmissions?limit={{limit}}",
        input_schema: {
          type: "object",
          properties: { limit: { type: "number" } },
        },
      },
      {
        name: "get_path",
        description:
          "Escape hatch: GET an arbitrary App Store Connect API path (must start with /). " +
          "Use for endpoints not in the catalog above. Example: '/users'.",
        method: "GET",
        path: "{{path}}",
        input_schema: {
          type: "object",
          properties: { path: { type: "string", description: "Path starting with / e.g. '/users'" } },
          required: ["path"],
        },
      },
    ],
  },
  {
    vendor: "exa",
    display_name: "Exa (Neural search)",
    category: "search",
    description: "Semantic web search optimized for finding sources, not just keywords.",
    docs_url: "https://dashboard.exa.ai/api-keys",
    auth_type: "api_key",
    base_url: "https://api.exa.ai",
    auth_header_name: "x-api-key",
    auth_header_template: "{{key}}",
    credentials: [
      {
        name: "key",
        label: "API Key",
        description: "dashboard.exa.ai/api-keys",
        placeholder: "...",
        is_secret: true,
        required: true,
      },
    ],
    config: [],
    test: { method: "POST", path: "/search" },
    actions: [
      {
        name: "search",
        description: "Neural / keyword search across the web.",
        method: "POST",
        path: "/search",
        body_template: { query: "{{query}}", numResults: "{{numResults}}" },
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string" },
            numResults: { type: "number", description: "Default 10" },
          },
          required: ["query"],
        },
      },
    ],
  },
];

export function getVendor(slug: string): VendorDef | undefined {
  return VENDOR_REGISTRY.find(v => v.vendor === slug);
}

export function listVendors(): Array<Omit<VendorDef, "actions">> {
  // For the API Center vendor picker, we don't need to ship the full action
  // catalog up front — that's loaded when a vendor is selected.
  return VENDOR_REGISTRY.map(({ actions: _actions, ...rest }) => rest);
}
