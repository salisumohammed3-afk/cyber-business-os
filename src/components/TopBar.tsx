import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, ChevronDown, Plus, Settings, FolderOpen } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function CreateCompanyDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: (created?: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const { refreshCompanies, switchCompany } = useCompany();

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        await refreshCompanies();
        if (data.company?.id) switchCompany(data.company.id);
        onClose(true);
        setName("");
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Company</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Company name..."
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => onClose()}
              className="px-3 py-1.5 rounded-md border text-sm"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!name.trim() || creating}
              className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create & Switch"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const TopBar = () => {
  const { company, companies, switchCompany } = useCompany();
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();

  return (
    <>
      <div className="h-12 border-b border-border bg-background flex items-center px-4 gap-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-secondary transition-colors">
              <Building2 size={16} className="text-blue-500" />
              <span className="text-sm font-semibold tracking-tight text-foreground">
                {company?.name || "Select Company"}
              </span>
              <ChevronDown size={14} className="text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {companies.map((c) => (
              <DropdownMenuItem
                key={c.id}
                onClick={() => switchCompany(c.id)}
                className={c.id === company?.id ? "bg-accent" : ""}
              >
                <Building2 size={14} className="mr-2 text-muted-foreground" />
                {c.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setShowCreate(true)}>
              <Plus size={14} className="mr-2" />
              Add Company
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="h-4 w-px bg-border" />

        <span className="text-xs text-muted-foreground">
          {company?.brief?.stage
            ? company.brief.stage.replace("-", " ")
            : "no brief set"}
        </span>

        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => navigate("/company-settings")}
            className="flex items-center gap-1.5 px-3 py-1 rounded-sm border border-border text-xs font-medium text-foreground hover:bg-secondary transition-colors"
          >
            <Settings size={12} />
            Settings
          </button>
          <button
            onClick={() => navigate("/outputs")}
            className="flex items-center gap-1.5 px-3 py-1 rounded-sm border border-border text-xs font-medium text-foreground hover:bg-secondary transition-colors"
          >
            <FolderOpen size={12} />
            Outputs
          </button>
          <button
            onClick={() => navigate("/agents")}
            className="px-3 py-1 rounded-sm border border-border text-xs font-medium text-foreground hover:bg-secondary transition-colors"
          >
            Agents
          </button>
        </div>
      </div>
      <CreateCompanyDialog
        open={showCreate}
        onClose={(created) => {
          setShowCreate(false);
          if (created) navigate("/company-settings");
        }}
      />
    </>
  );
};

export default TopBar;
