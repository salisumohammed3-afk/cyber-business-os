import { useState, useCallback, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, Upload, Github, Loader2, BookOpen, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAgentDefinitions, useSkillMutations } from "@/hooks/useSupabaseData";

export interface SkillPrefill {
  name?: string;
  description?: string;
  content?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  preselectedAgentId?: string;
  prefill?: SkillPrefill;
}

function resolveRawUrl(url: string): string {
  const gh = url.match(/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)/);
  if (gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}/${gh[4]}`;
  if (url.includes("raw.githubusercontent.com")) return url;
  return url;
}

const AddSkillModal = ({ open, onClose, onSuccess, preselectedAgentId, prefill }: Props) => {
  const { data: agentDefs = [] } = useAgentDefinitions();
  const { createSkill } = useSkillMutations();

  const [tab, setTab] = useState<string>("paste");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(
    preselectedAgentId ? new Set([preselectedAgentId]) : new Set()
  );
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open && prefill) {
      if (prefill.name) setName(prefill.name);
      if (prefill.description) setDescription(prefill.description);
      if (prefill.content) setContent(prefill.content);
      setTab("paste");
    }
    if (open && preselectedAgentId) {
      setSelectedAgents(new Set([preselectedAgentId]));
    }
  }, [open, prefill, preselectedAgentId]);

  const agents = (agentDefs as Array<{ id: string; name: string | null; slug: string }>).filter(
    (a) => a.slug !== "orchestrator"
  );

  const toggleAgent = (id: string) => {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedAgents.size === agents.length) {
      setSelectedAgents(new Set());
    } else {
      setSelectedAgents(new Set(agents.map((a) => a.id)));
    }
  };

  const fetchFromGithub = useCallback(async () => {
    if (!githubUrl.trim()) return;
    setFetching(true);
    setFetchError(null);
    try {
      const rawUrl = resolveRawUrl(githubUrl.trim());
      const res = await fetch(rawUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      setContent(text);

      if (!name) {
        const match = githubUrl.match(/\/([^/]+)\.(md|txt)$/i);
        if (match) setName(match[1].replace(/[-_]/g, " "));
      }
      setTab("paste");
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setFetching(false);
    }
  }, [githubUrl, name]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setContent(reader.result as string);
      if (!name) setName(file.name.replace(/\.(md|txt)$/i, "").replace(/[-_]/g, " "));
    };
    reader.readAsText(file);
  };

  const handleSubmit = async () => {
    if (!name.trim() || !content.trim() || selectedAgents.size === 0) return;
    setSubmitting(true);
    try {
      await createSkill.mutateAsync({
        name: name.trim(),
        description: description.trim(),
        content: content.trim(),
        source_url: githubUrl.trim() || undefined,
        agentIds: Array.from(selectedAgents),
      });
      setName("");
      setDescription("");
      setContent("");
      setGithubUrl("");
      setSelectedAgents(preselectedAgentId ? new Set([preselectedAgentId]) : new Set());
      onSuccess?.();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = name.trim() && content.trim() && selectedAgents.size > 0 && !submitting;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.15 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl mx-4 bg-background border border-border rounded-md overflow-hidden shadow-lg flex flex-col max-h-[85vh]"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div className="flex items-center gap-2">
                <BookOpen size={16} className="text-violet-400" />
                <h2 className="text-sm font-medium">Add Skill</h2>
              </div>
              <button
                onClick={onClose}
                className="p-1 rounded-sm hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
              {/* Name + Description */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-mono text-[10px] text-muted-foreground tracking-wider uppercase block mb-1.5">
                    Skill Name *
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Supabase Expert"
                    className="w-full px-3 py-2 text-xs bg-secondary border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                  />
                </div>
                <div>
                  <label className="font-mono text-[10px] text-muted-foreground tracking-wider uppercase block mb-1.5">
                    Description
                  </label>
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Short description of what this teaches"
                    className="w-full px-3 py-2 text-xs bg-secondary border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                  />
                </div>
              </div>

              {/* Content tabs */}
              <Tabs value={tab} onValueChange={setTab}>
                <TabsList className="bg-secondary/50 h-8">
                  <TabsTrigger value="paste" className="text-[11px] h-6 gap-1">
                    <Upload size={10} />
                    Paste / Upload
                  </TabsTrigger>
                  <TabsTrigger value="github" className="text-[11px] h-6 gap-1">
                    <Github size={10} />
                    GitHub URL
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="paste" className="mt-3">
                  <textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="Paste your skill markdown content here..."
                    rows={10}
                    className="w-full px-3 py-2 text-xs font-mono bg-secondary border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-violet-500/50 resize-y min-h-[120px]"
                  />
                  <div className="mt-2">
                    <label className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground bg-secondary border border-dashed border-border rounded-md cursor-pointer hover:border-foreground/30 transition-colors">
                      <Upload size={12} />
                      <span>Upload .md or .txt file</span>
                      <input
                        type="file"
                        accept=".md,.txt,.markdown"
                        onChange={handleFileUpload}
                        className="hidden"
                      />
                    </label>
                  </div>
                </TabsContent>

                <TabsContent value="github" className="mt-3 space-y-3">
                  <div>
                    <label className="font-mono text-[10px] text-muted-foreground tracking-wider uppercase block mb-1.5">
                      GitHub File URL
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={githubUrl}
                        onChange={(e) => setGithubUrl(e.target.value)}
                        placeholder="https://github.com/user/repo/blob/main/SKILL.md"
                        className="flex-1 px-3 py-2 text-xs bg-secondary border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                      />
                      <button
                        onClick={fetchFromGithub}
                        disabled={!githubUrl.trim() || fetching}
                        className="px-3 py-2 text-xs font-medium rounded-md bg-foreground text-background hover:bg-foreground/90 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {fetching ? <Loader2 size={12} className="animate-spin" /> : <Github size={12} />}
                        Fetch
                      </button>
                    </div>
                    {fetchError && (
                      <p className="text-[10px] text-red-400 mt-1">{fetchError}</p>
                    )}
                  </div>
                  {content && (
                    <div className="p-3 bg-secondary border border-border rounded-md">
                      <div className="flex items-center gap-1.5 mb-2">
                        <Check size={10} className="text-emerald-500" />
                        <span className="text-[10px] text-emerald-500 font-medium">Content loaded</span>
                        <span className="text-[10px] text-muted-foreground ml-auto">{content.length} chars</span>
                      </div>
                      <pre className="text-[10px] font-mono text-muted-foreground whitespace-pre-wrap max-h-24 overflow-y-auto leading-snug">
                        {content.slice(0, 500)}{content.length > 500 ? "..." : ""}
                      </pre>
                    </div>
                  )}
                </TabsContent>
              </Tabs>

              {/* Agent assignment */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="font-mono text-[10px] text-muted-foreground tracking-wider uppercase">
                    Assign to Agents *
                  </label>
                  <button
                    onClick={selectAll}
                    className="text-[10px] text-violet-400 hover:text-violet-300 transition-colors"
                  >
                    {selectedAgents.size === agents.length ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {agents.map((agent) => {
                    const selected = selectedAgents.has(agent.id);
                    return (
                      <button
                        key={agent.id}
                        onClick={() => toggleAgent(agent.id)}
                        className={`flex items-center gap-2 p-2.5 rounded-md border text-left transition-all ${
                          selected
                            ? "border-violet-500/50 bg-violet-500/10 text-foreground"
                            : "border-border bg-secondary/50 text-muted-foreground hover:border-foreground/20"
                        }`}
                      >
                        <div
                          className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                            selected ? "bg-violet-500 border-violet-500" : "border-foreground/20"
                          }`}
                        >
                          {selected && <Check size={10} className="text-white" />}
                        </div>
                        <span className="text-xs truncate">{agent.name}</span>
                      </button>
                    );
                  })}
                </div>
                {selectedAgents.size > 0 && (
                  <p className="text-[10px] text-muted-foreground mt-2">
                    {selectedAgents.size} agent{selectedAgents.size !== 1 ? "s" : ""} will receive this skill
                  </p>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="p-3 border-t border-border flex items-center justify-between">
              <div className="text-[10px] text-muted-foreground">
                {content ? `${content.length} chars` : "No content yet"}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 text-[11px] font-medium rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-[11px] font-medium rounded-md bg-violet-600 text-white hover:bg-violet-500 transition-colors disabled:opacity-50"
                >
                  {submitting ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <BookOpen size={12} />
                  )}
                  Add Skill
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default AddSkillModal;
