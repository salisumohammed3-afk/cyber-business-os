import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl =
    process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey)
    return res.status(500).json({ error: "Supabase not configured" });

  const {
    company_id,
    conversation_id,
    event_type,
    title,
    body,
    channel = "chat",
    metadata = {},
  } = req.body || {};

  if (!company_id || !title)
    return res.status(400).json({ error: "company_id and title are required" });

  const supabase = createClient(supabaseUrl, supabaseKey);
  const results: { chat?: boolean; email?: boolean } = {};

  try {
    // Chat notification
    if (channel === "chat" || channel === "both") {
      // Find active conversation for this company
      let convId = conversation_id;
      if (!convId) {
        const { data: conv } = await supabase
          .from("conversations")
          .select("id")
          .eq("company_id", company_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .single();
        convId = conv?.id;
      }

      if (convId) {
        const icon =
          event_type === "task_completed" ? "\u2705" :
          event_type === "task_failed" ? "\u274C" :
          event_type === "task_proposed" ? "\uD83D\uDCA1" :
          "\uD83D\uDD14";

        const content = `${icon} **${title}**${body ? "\n" + body : ""}`;

        await supabase.from("chat_messages").insert({
          conversation_id: convId,
          role: "system",
          kind: "notification",
          content,
          timestamp: new Date().toISOString(),
          metadata: {
            kind: "notification",
            notification: true,
            event_type,
            ...metadata,
          },
        });
        results.chat = true;
      }
    }

    // Email notification
    if (channel === "email" || channel === "both") {
      const resendKey = process.env.RESEND_API_KEY;
      const fromEmail = process.env.DIGEST_FROM_EMAIL || "digest@salos.app";

      if (resendKey) {
        // Get company digest email
        const { data: company } = await supabase
          .from("companies")
          .select("digest_email, name")
          .eq("id", company_id)
          .single();

        if (company?.digest_email) {
          try {
            const { Resend } = await import("resend");
            const resend = new Resend(resendKey);
            await resend.emails.send({
              from: fromEmail,
              to: company.digest_email,
              subject: `[${company.name}] ${title}`,
              html: `<div style="font-family: sans-serif; padding: 20px;"><h2>${title}</h2>${body ? `<p>${body}</p>` : ""}</div>`,
            });
            results.email = true;
          } catch (emailErr) {
            console.error("Email notification failed:", emailErr);
          }
        }
      }
    }

    return res.status(200).json({ success: true, ...results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Notify error:", msg);
    return res.status(500).json({ error: msg });
  }
}
