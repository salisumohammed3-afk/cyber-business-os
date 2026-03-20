import { useState, useEffect, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  ArrowLeft,
  Search,
  FolderOpen,
  Globe,
  FileText,
  ExternalLink,
  GitBranch,
  Clock,
  Database,
  ChevronRight,
  Pencil,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useCompany } from "@/contexts/CompanyContext";

interface Project {
  id: string;
  name: string;
  description: string | null;
  repo_url: string | null;
  deploy_url: string | null;
  branch: string;
  tables_created: string[];
  status: "draft" | "building" | "live" | "archived";
  created_at: string;
  updated_at: string;
}

interface Document {
  id: string;
  task_id: string;
  task_title: string;
  agent_name: string;
  result_type: string;
  summary: string;
  created_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  building: "bg-amber-100 text-amber-700",
  live: "bg-emerald-100 text-emerald-700",
  archived: "bg-slate-100 text-slate-500",
};

function ProjectCard({ project }: { project: Project }) {
  return (
    <Card className="hover:border-blue-300 transition-colors">
      <CardContent className="pt-4 pb-3 space-y-2">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Globe size={14} className="text-blue-500 mt-0.5" />
            <h3 className="font-medium text-sm">{project.name}</h3>
          </div>
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${STATUS_COLORS[project.status] || STATUS_COLORS.draft}`}>
            {project.status}
          </span>
        </div>
        {project.description && (
          <p className="text-xs text-muted-foreground line-clamp-2 pl-5">{project.description}</p>
        )}
        <div className="flex flex-wrap gap-2 pl-5">
          {project.deploy_url && (
            <a
              href={project.deploy_url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
            >
              <ExternalLink size={10} /> Live
            </a>
          )}
          <Link
            to={`/projects/${project.id}/edit`}
            className="flex items-center gap-1 text-xs text-violet-600 hover:underline"
          >
            <Pencil size={10} /> Edit
          </Link>
          {project.repo_url && (
            <a
              href={project.repo_url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:underline"
            >
              <GitBranch size={10} /> {project.branch || "main"}
            </a>
          )}
          {project.tables_created?.length > 0 && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Database size={10} /> {project.tables_created.length} table{project.tables_created.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="pl-5 text-[10px] text-muted-foreground flex items-center gap-1">
          <Clock size={9} />
          {new Date(project.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
        </div>
      </CardContent>
    </Card>
  );
}

function DocumentCard({ doc }: { doc: Document }) {
  return (
    <Card className="hover:border-blue-300 transition-colors">
      <CardContent className="pt-4 pb-3 space-y-1.5">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <FileText size={14} className="text-orange-500 mt-0.5" />
            <h3 className="font-medium text-sm line-clamp-1">{doc.task_title}</h3>
          </div>
          <Badge variant="outline" className="text-[10px] shrink-0">{doc.agent_name}</Badge>
        </div>
        <p className="text-xs text-muted-foreground line-clamp-3 pl-5">{doc.summary}</p>
        <div className="pl-5 text-[10px] text-muted-foreground flex items-center gap-1">
          <Clock size={9} />
          {new Date(doc.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
        </div>
      </CardContent>
    </Card>
  );
}

export default function Outputs() {
  const navigate = useNavigate();
  const { company } = useCompany();
  const [search, setSearch] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loadingP, setLoadingP] = useState(true);
  const [loadingD, setLoadingD] = useState(true);

  const fetchProjects = useCallback(async () => {
    if (!company) return;
    setLoadingP(true);
    const { data } = await supabase
      .from("projects")
      .select("*")
      .eq("company_id", company.id)
      .order("created_at", { ascending: false });
    setProjects((data as Project[]) || []);
    setLoadingP(false);
  }, [company]);

  const fetchDocuments = useCallback(async () => {
    if (!company) return;
    setLoadingD(true);

    const { data: tasks } = await supabase
      .from("tasks")
      .select("id, title, agent_definition_id, completed_at")
      .eq("company_id", company.id)
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(50);

    if (!tasks?.length) {
      setDocuments([]);
      setLoadingD(false);
      return;
    }

    const agentIds = [...new Set(tasks.map((t: { agent_definition_id: string }) => t.agent_definition_id).filter(Boolean))];
    const { data: agents } = await supabase
      .from("agent_definitions")
      .select("id, name")
      .in("id", agentIds);
    const agentMap: Record<string, string> = {};
    (agents || []).forEach((a: { id: string; name: string }) => { agentMap[a.id] = a.name; });

    const taskIds = tasks.map((t: { id: string }) => t.id);
    const { data: results } = await supabase
      .from("task_results")
      .select("task_id, result_type, data, created_at")
      .in("task_id", taskIds)
      .order("created_at", { ascending: false });

    const docs: Document[] = (results || []).map((r: { task_id: string; result_type: string; data: Record<string, string> | null; created_at: string }) => {
      const task = tasks.find((t: { id: string }) => t.id === r.task_id) as { id: string; title: string; agent_definition_id: string } | undefined;
      const response = (r.data as Record<string, string>)?.response || "";
      return {
        id: `${r.task_id}-${r.created_at}`,
        task_id: r.task_id,
        task_title: task?.title || "Untitled",
        agent_name: task?.agent_definition_id ? (agentMap[task.agent_definition_id] || "Agent") : "Agent",
        result_type: r.result_type,
        summary: response.slice(0, 300),
        created_at: r.created_at,
      };
    });

    setDocuments(docs);
    setLoadingD(false);
  }, [company]);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);
  useEffect(() => { fetchDocuments(); }, [fetchDocuments]);

  const q = search.toLowerCase();
  const filteredProjects = q
    ? projects.filter(p => p.name.toLowerCase().includes(q) || (p.description || "").toLowerCase().includes(q))
    : projects;
  const filteredDocs = q
    ? documents.filter(d => d.task_title.toLowerCase().includes(q) || d.summary.toLowerCase().includes(q) || d.agent_name.toLowerCase().includes(q))
    : documents;

  if (!company) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-muted-foreground">No company selected</p>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      <div className="h-12 border-b flex items-center px-4 gap-3">
        <button onClick={() => navigate("/")} className="p-1 rounded hover:bg-secondary">
          <ArrowLeft size={18} />
        </button>
        <h1 className="font-semibold text-sm">{company.name} — Outputs</h1>
        <div className="ml-auto relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search outputs..."
            className="pl-8 pr-3 py-1.5 w-64 rounded-lg border text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div className="flex-1 overflow-hidden grid grid-cols-2 divide-x">
        {/* Documents — left */}
        <div className="flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b flex items-center gap-2">
            <FileText size={14} className="text-orange-500" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Documents
            </span>
            <Badge variant="secondary" className="text-[10px] ml-auto">{filteredDocs.length}</Badge>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {loadingD ? (
              <p className="text-xs text-muted-foreground text-center pt-8">Loading documents...</p>
            ) : filteredDocs.length === 0 ? (
              <div className="text-center pt-12 space-y-2">
                <FileText size={28} className="mx-auto text-muted-foreground/40" />
                <p className="text-xs text-muted-foreground">
                  {search ? "No documents match your search" : "No documents yet. Completed tasks will appear here."}
                </p>
              </div>
            ) : (
              filteredDocs.map((doc) => <DocumentCard key={doc.id} doc={doc} />)
            )}
          </div>
        </div>

        {/* Projects — right */}
        <div className="flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b flex items-center gap-2">
            <FolderOpen size={14} className="text-blue-500" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Projects
            </span>
            <Badge variant="secondary" className="text-[10px] ml-auto">{filteredProjects.length}</Badge>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {loadingP ? (
              <p className="text-xs text-muted-foreground text-center pt-8">Loading projects...</p>
            ) : filteredProjects.length === 0 ? (
              <div className="text-center pt-12 space-y-2">
                <FolderOpen size={28} className="mx-auto text-muted-foreground/40" />
                <p className="text-xs text-muted-foreground">
                  {search ? "No projects match your search" : "No projects yet. When agents build apps, they'll appear here."}
                </p>
              </div>
            ) : (
              filteredProjects.map((p) => <ProjectCard key={p.id} project={p} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
