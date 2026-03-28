import type { SupabaseClient } from "@supabase/supabase-js";

type JobStatus = "running" | "success" | "partial" | "failed";

export async function startJobRun(
  supabase: SupabaseClient,
  jobName: string,
  metadata: Record<string, unknown> = {}
): Promise<string | null> {
  const { data, error } = await supabase
    .from("job_runs")
    .insert({ job_name: jobName, status: "running" as JobStatus, metadata })
    .select("id")
    .single();

  if (error) {
    console.error("[job_runs] start failed:", error.message);
    return null;
  }
  return data.id as string;
}

export async function finishJobRun(
  supabase: SupabaseClient,
  runId: string | null,
  patch: {
    status: Exclude<JobStatus, "running">;
    error_summary?: string | null;
    companies_processed?: number;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  if (!runId) return;

  const updates: Record<string, unknown> = {
    finished_at: new Date().toISOString(),
    status: patch.status,
    error_summary: patch.error_summary ?? null,
    companies_processed: patch.companies_processed ?? 0,
  };
  if (patch.metadata !== undefined) updates.metadata = patch.metadata;

  const { error } = await supabase.from("job_runs").update(updates).eq("id", runId);
  if (error) console.error("[job_runs] finish failed:", error.message);
}
