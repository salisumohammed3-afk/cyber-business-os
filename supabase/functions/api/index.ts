import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400) {
  return json({ error: message }, status);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const url = new URL(req.url);
  // Path after /api/ e.g. /api/agents -> ["agents"]
  const segments = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const resource = segments[0];
  const id = segments[1];
  const method = req.method;

  try {
    // ── AGENTS ──
    if (resource === "agents") {
      if (method === "GET") {
        if (id) {
          const { data, error } = await supabase.from("agents").select("*").eq("id", id).single();
          if (error) return err(error.message, 404);
          return json(data);
        }
        const { data, error } = await supabase.from("agents").select("*").order("name");
        if (error) return err(error.message);
        return json(data);
      }
      if (method === "POST") {
        const body = await req.json();
        const { data, error } = await supabase.from("agents").insert(body).select().single();
        if (error) return err(error.message);
        return json(data, 201);
      }
      if (method === "PATCH" && id) {
        const body = await req.json();
        const { data, error } = await supabase.from("agents").update(body).eq("id", id).select().single();
        if (error) return err(error.message);
        return json(data);
      }
      if (method === "DELETE" && id) {
        const { error } = await supabase.from("agents").delete().eq("id", id);
        if (error) return err(error.message);
        return json({ deleted: true });
      }
    }

    // ── TASKS ──
    if (resource === "tasks") {
      if (method === "GET") {
        if (id) {
          const { data, error } = await supabase.from("tasks").select("*").eq("id", id).single();
          if (error) return err(error.message, 404);
          return json(data);
        }
        const status = url.searchParams.get("status");
        const agent_id = url.searchParams.get("agent_id");
        let query = supabase.from("tasks").select("*");
        if (status) query = query.eq("status", status);
        if (agent_id) query = query.eq("agent_id", agent_id);
        const { data, error } = await query.order("created_at", { ascending: false });
        if (error) return err(error.message);
        return json(data);
      }
      if (method === "POST") {
        const body = await req.json();
        const { data, error } = await supabase.from("tasks").insert(body).select().single();
        if (error) return err(error.message);
        return json(data, 201);
      }
      if (method === "PATCH" && id) {
        const body = await req.json();
        const { data, error } = await supabase.from("tasks").update(body).eq("id", id).select().single();
        if (error) return err(error.message);
        return json(data);
      }
      if (method === "DELETE" && id) {
        const { error } = await supabase.from("tasks").delete().eq("id", id);
        if (error) return err(error.message);
        return json({ deleted: true });
      }
    }

    // ── CHAT MESSAGES ──
    if (resource === "chat" || resource === "chat_messages") {
      if (method === "GET") {
        const { data, error } = await supabase.from("chat_messages").select("*").order("created_at");
        if (error) return err(error.message);
        return json(data);
      }
      if (method === "POST") {
        const body = await req.json();
        const { data, error } = await supabase.from("chat_messages").insert(body).select().single();
        if (error) return err(error.message);
        return json(data, 201);
      }
      if (method === "DELETE" && id) {
        const { error } = await supabase.from("chat_messages").delete().eq("id", id);
        if (error) return err(error.message);
        return json({ deleted: true });
      }
    }

    // ── METRICS ──
    if (resource === "metrics") {
      if (method === "GET") {
        const { data, error } = await supabase.from("metrics").select("*");
        if (error) return err(error.message);
        return json(data);
      }
      if (method === "PATCH" && id) {
        const body = await req.json();
        const { data, error } = await supabase.from("metrics").update(body).eq("label", id).select().single();
        if (error) return err(error.message);
        return json(data);
      }
      if (method === "POST") {
        const body = await req.json();
        const { data, error } = await supabase.from("metrics").upsert(body, { onConflict: "label" }).select().single();
        if (error) return err(error.message);
        return json(data, 201);
      }
    }

    // ── TERMINAL LOGS ──
    if (resource === "logs" || resource === "terminal_logs") {
      if (method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") || "50");
        const { data, error } = await supabase.from("terminal_logs").select("*").order("created_at", { ascending: false }).limit(limit);
        if (error) return err(error.message);
        return json(data);
      }
      if (method === "POST") {
        const body = await req.json();
        const { data, error } = await supabase.from("terminal_logs").insert(body).select().single();
        if (error) return err(error.message);
        return json(data, 201);
      }
    }

    return err("Not found", 404);
  } catch (e) {
    return err(e.message || "Internal server error", 500);
  }
});
