export type AgentStatus = "active" | "idle" | "thinking";

export interface Agent {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  lastAction: string;
  tasksCompleted: number;
}

export interface Task {
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  status: "running" | "completed" | "queued" | "failed";
  progress: number;
  timestamp: string;
  reasoning: string;
  toolOutput: string;
  category: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "orchestrator";
  content: string;
  timestamp: string;
}

export interface Metric {
  label: string;
  value: string;
  change?: string;
  positive?: boolean;
}

export const agents: Agent[] = [
  {
    id: "eng-01",
    name: "Engineering",
    role: "Full-Stack Dev & DevOps",
    status: "active",
    lastAction: "Deployed auth microservice to prod",
    tasksCompleted: 47,
  },
  {
    id: "browser-01",
    name: "Browser",
    role: "Web Scraping & Recon",
    status: "thinking",
    lastAction: "Scraping competitor pricing pages",
    tasksCompleted: 23,
  },
  {
    id: "meta-01",
    name: "Meta Ads",
    role: "Ad Campaign Manager",
    status: "idle",
    lastAction: "Paused underperforming creatives",
    tasksCompleted: 31,
  },
  {
    id: "growth-01",
    name: "Growth",
    role: "Outbound & Lead Gen",
    status: "active",
    lastAction: "Found 10 enterprise prospects",
    tasksCompleted: 56,
  },
  {
    id: "research-01",
    name: "Research",
    role: "Market Intel & Analysis",
    status: "idle",
    lastAction: "Completed TAM analysis for EMEA",
    tasksCompleted: 18,
  },
];

export const tasks: Task[] = [
  {
    id: "TASK-0042",
    title: "Deploy authentication fix to production",
    agentId: "eng-01",
    agentName: "Engineering",
    status: "completed",
    progress: 100,
    timestamp: "2 min ago",
    reasoning: "Identified a session expiry bug in the OAuth2 callback handler. The refresh token was not being rotated on re-authentication, causing 401s after 24h. Applied fix, ran integration tests (14/14 pass), deployed via CI/CD.",
    toolOutput: `diff --git a/src/auth/callback.ts b/src/auth/callback.ts
--- a/src/auth/callback.ts
+++ b/src/auth/callback.ts
@@ -23,6 +23,8 @@ export async function handleCallback(req) {
-  const token = await getToken(code);
+  const token = await getToken(code);
+  await rotateRefreshToken(token.refresh_token);
+  session.expiresAt = Date.now() + token.expires_in * 1000;
   return createSession(token);
 }`,
    category: "deployment",
  },
  {
    id: "TASK-0041",
    title: "Scrape competitor pricing for Q1 report",
    agentId: "browser-01",
    agentName: "Browser",
    status: "running",
    progress: 63,
    timestamp: "8 min ago",
    reasoning: "Navigating through 12 competitor landing pages. Extracting pricing tiers, feature matrices, and any A/B test variants detected. Using headless Chromium with rotating proxies to avoid rate limits.",
    toolOutput: `> Fetching https://competitor-a.com/pricing ... OK (200)
> Extracting tier data ... 3 tiers found
> Fetching https://competitor-b.com/pricing ... OK (200)
> Extracting tier data ... 4 tiers found
> Fetching https://competitor-c.com/pricing ... RETRY (429)
> Rotating proxy ... OK
> Fetching https://competitor-c.com/pricing ... OK (200)
> Progress: 7/12 pages complete`,
    category: "research",
  },
  {
    id: "TASK-0040",
    title: "Generate cold outreach sequence for EMEA leads",
    agentId: "growth-01",
    agentName: "Growth",
    status: "running",
    progress: 85,
    timestamp: "14 min ago",
    reasoning: "Cross-referencing ICP criteria with the 10 verified enterprise prospects. Generating personalized 3-email sequences for each lead. Prioritizing C-suite contacts at companies actively hiring for AI transformation roles.",
    toolOutput: `> Lead 1: Scott Petty (Vodafone CTO) - Sequence drafted
> Lead 2: Anabel Almagro (UniCredit CAI Officer) - Sequence drafted
> Lead 3: Eric Hirschhorn (BNY Mellon CDO) - Sequence drafted
> Lead 4: Ralph Mupita (MTN Group CEO) - In progress...
> Personalizing based on recent AI deployment announcement
> 8/10 sequences complete`,
    category: "growth",
  },
  {
    id: "TASK-0039",
    title: "Pause underperforming Meta Ad creatives",
    agentId: "meta-01",
    agentName: "Meta Ads",
    status: "completed",
    progress: 100,
    timestamp: "32 min ago",
    reasoning: "Analyzed last 7-day performance across 6 active creatives. Identified 2 with CTR < 0.8% and CPA > $45 (2x target). Paused both and reallocated budget to top performer (Creative #3, CTR 2.1%, CPA $18).",
    toolOutput: `Campaign: SalOS_Launch_Q1
  Creative #1: CTR 0.6%, CPA $52 → PAUSED
  Creative #2: CTR 1.4%, CPA $24 → ACTIVE
  Creative #3: CTR 2.1%, CPA $18 → BUDGET +40%
  Creative #4: CTR 0.7%, CPA $48 → PAUSED
  Creative #5: CTR 1.8%, CPA $21 → ACTIVE
  Creative #6: CTR 1.2%, CPA $29 → ACTIVE
Budget reallocation complete.`,
    category: "ads",
  },
  {
    id: "TASK-0038",
    title: "Complete TAM analysis for EMEA market",
    agentId: "research-01",
    agentName: "Research",
    status: "completed",
    progress: 100,
    timestamp: "1h ago",
    reasoning: "Aggregated market data from Gartner, IDC, and McKinsey reports. Cross-referenced with LinkedIn job postings for 'Chief AI Officer' roles across Europe and Africa to estimate enterprise AI adoption readiness.",
    toolOutput: `EMEA AI Consulting TAM Report:
  Total Addressable Market: €4.2B
  Serviceable Market: €1.5B
  Target Segment: Enterprise (500+ employees)
  Geographic split: Europe 72%, Africa 28%
  Growth rate: 34% YoY
  Key verticals: Finance, Telecom, Industrial`,
    category: "research",
  },
  {
    id: "TASK-0037",
    title: "Set up monitoring alerts for API latency",
    agentId: "eng-01",
    agentName: "Engineering",
    status: "queued",
    progress: 0,
    timestamp: "Queued",
    reasoning: "Will configure PagerDuty alerts for p99 latency > 500ms on all production endpoints. Adding Grafana dashboard panels for real-time visualization.",
    toolOutput: "Awaiting execution...",
    category: "infrastructure",
  },
];

export const chatMessages: ChatMessage[] = [
  {
    id: "msg-1",
    role: "orchestrator",
    content: "Good morning. All systems nominal. Engineering deployed the auth fix overnight. Growth found 10 high-value EMEA prospects. Ready for your direction.",
    timestamp: "9:00 AM",
  },
  {
    id: "msg-2",
    role: "user",
    content: "Focus on the EMEA pipeline today. I want cold outreach deployed by EOD. Also, kill any Meta Ads burning cash.",
    timestamp: "9:02 AM",
  },
  {
    id: "msg-3",
    role: "orchestrator",
    content: "Understood. Executing:\n\n1. Growth Agent → Drafting personalized sequences for all 10 EMEA leads. ETA: 45 min.\n2. Meta Ads Agent → Analyzing 7-day creative performance. Will pause anything with CPA > 2x target.\n3. Engineering → Auth fix is live. Queuing API monitoring setup next.\n\nI'll notify you when outreach is ready for review.",
    timestamp: "9:02 AM",
  },
  {
    id: "msg-4",
    role: "user",
    content: "Perfect. What's our burn rate looking like?",
    timestamp: "9:15 AM",
  },
  {
    id: "msg-5",
    role: "orchestrator",
    content: "Current daily burn: $47.20\n• Compute: $12.40\n• Meta Ads: $30.00 (reduced from $42 after pausing underperformers)\n• API calls: $4.80\n\nAt this rate, your $2,847 wallet covers ~60 days. Recommend reviewing ad spend after outreach results come in Day 5-7.",
    timestamp: "9:15 AM",
  },
];

export const metrics: Metric[] = [
  { label: "Time Reclaimed", value: "42.5h", change: "+6.2h", positive: true },
  { label: "System Burn Rate", value: "$47/day", change: "-$12", positive: true },
  { label: "Av Time Per Task", value: "1m 24s", change: "-18s", positive: true },
];

export const terminalLogs: string[] = [
  "MCP_CONNECT: handshake OK → latency 12ms",
  "agent:growth → scraping linkedin for EMEA CTO contacts",
  "agent:engineering → running integration tests (14/14 pass)",
  "agent:browser → rotating proxy pool (3/5 active)",
  "openclaw:search → indexing competitor-c.com/pricing",
  "agent:meta_ads → budget reallocation complete",
  "agent:growth → personalizing sequence for lead #4",
  "mcp:heartbeat → all agents responsive",
  "agent:research → caching TAM report to knowledge base",
  "openclaw:inference → generating outreach copy variant #3",
  "agent:engineering → deploying auth-fix-v2 to production",
  "mcp:sync → syncing agent states to dashboard",
];
