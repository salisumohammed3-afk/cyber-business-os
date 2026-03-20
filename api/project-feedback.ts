import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 30;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: "Supabase not configured" });

  const { project_id, message } = req.body || {};
  if (!project_id || !message) return res.status(400).json({ error: "project_id and message are required" });

  const supabase = createClient(supabaseUrl, supabaseKey);

  // 1. Load project
  const { data: project, error: projErr } = await supabase
    .from("projects")
    .select("id, company_id, name, repo_url, deploy_url, branch, edit_conversation_id")
    .eq("id", project_id)
    .single();

  if (projErr || !project) return res.status(404).json({ error: "Project not found" });

  // 2. Ensure edit conversation exists
  let conversationId = project.edit_conversation_id;
  if (!conversationId) {
    const { data: conv, error: convErr } = await supabase
      .from("conversations")
      .insert({
        title: `Edit: ${project.name}`,
        company_id: project.company_id,
      })
      .select("id")
      .single();

    if (convErr || !conv?.id) return res.status(500).json({ error: "Failed to create conversation" });
    conversationId = conv.id;

    await supabase
      .from("projects")
      .update({ edit_conversation_id: conversationId })
      .eq("id", project_id);
  }

  // 3. Insert user message
  await supabase.from("chat_messages").insert({
    conversation_id: conversationId,
    role: "user",
    content: message,
    timestamp: new Date().toISOString(),
  });

  // 4. Fetch repo file tree for context (best-effort)
  let fileTree = "";
  if (project.repo_url) {
    try {
      const match = project.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (match) {
        const [, owner, repo] = match;
        const branch = project.branch || "main";
        const treeRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo.replace(/\.git$/, "")}/git/trees/${branch}?recursive=1`,
          { headers: { "User-Agent": "cyber-business-os", Accept: "application/vnd.github.v3+json" } }
        );
        if (treeRes.ok) {
          const treeData = await treeRes.json();
          const paths = (treeData.tree || [])
            .filter((t: { type: string }) => t.type === "blob")
            .map((t: { path: string; size: number }) => `  ${t.path} (${t.size}b)`)
            .slice(0, 100);
          fileTree = paths.join("\n");
        }
      }
    } catch {
      fileTree = "(Could not fetch file tree)";
    }
  }

  // 5. Find engineering agent
  const { data: engAgent } = await supabase
    .from("agent_definitions")
    .select("id")
    .eq("slug", "engineering")
    .eq("company_id", project.company_id)
    .single();

  if (!engAgent?.id) return res.status(500).json({ error: "Engineering agent not found" });

  // 6. Create engineering task
  const description = [
    `User feedback for project "${project.name}":`,
    message,
    "",
    `Repo: ${project.repo_url || "N/A"}`,
    `Live: ${project.deploy_url || "N/A"}`,
    `Branch: ${project.branch || "main"}`,
  ].join("\n");

  const { data: newTask, error: taskErr } = await supabase
    .from("tasks")
    .insert({
      conversation_id: conversationId,
      agent_definition_id: engAgent.id,
      company_id: project.company_id,
      status: "pending",
      title: `Edit: ${message.slice(0, 60)}${message.length > 60 ? "..." : ""}`,
      description,
      source: "internal",
      input_data: {
        project_id: project.id,
        repo_url: project.repo_url,
        deploy_url: project.deploy_url,
        branch: project.branch || "main",
        file_tree: fileTree,
        feedback: message,
      },
    })
    .select("id")
    .single();

  if (taskErr || !newTask?.id) return res.status(500).json({ error: "Failed to create task" });

  // 7. Trigger agent execution
  const selfUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://cyber-business-os.vercel.app";

  fetch(`${selfUrl}/api/run-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task_id: newTask.id, conversation_id: conversationId }),
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    task_id: newTask.id,
    conversation_id: conversationId,
  });
}
