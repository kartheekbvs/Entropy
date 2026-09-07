"use client";

import { useMemo, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import {
  ChevronDown,
  ExternalLink,
  NotebookPen,
  Plus,
  Trash2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Application,
  PIPELINE,
  PipelineStatus,
  STATUS_CONFIG,
  SOURCE_LABELS,
  daysAgoShort,
} from "./shared";

interface TrackerViewProps {
  applications: Application[];
  isLoading: boolean;
  onRefresh: () => void;
}

interface FormState {
  company: string;
  role: string;
  source: string;
  status: string;
  location: string;
  salary: string;
  jobUrl: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  company: "",
  role: "",
  source: "naukri",
  status: "applied",
  location: "",
  salary: "",
  jobUrl: "",
  notes: "",
};

export function TrackerView({ applications, isLoading, onRefresh }: TrackerViewProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const visible = useMemo(
    () =>
      statusFilter === "all"
        ? applications
        : applications.filter((a) => a.status === statusFilter),
    [applications, statusFilter]
  );

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const s of PIPELINE) map[s] = 0;
    for (const a of applications) map[a.status] = (map[a.status] ?? 0) + 1;
    return map;
  }, [applications]);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  async function createApplication() {
    if (!form.company.trim() || !form.role.trim()) {
      toast({
        title: "Missing fields",
        description: "Company and role are required.",
        variant: "destructive",
      });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      toast({ title: "Logged", description: `${form.role} @ ${form.company} added to pipeline.` });
      setForm(EMPTY_FORM);
      setOpen(false);
      onRefresh();
    } catch (err) {
      toast({
        title: "Could not save",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function updateStatus(id: string, status: string) {
    try {
      const res = await fetch(`/api/applications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to update");
      }
      toast({ title: "Status updated", description: `Moved to ${STATUS_CONFIG[status]?.label ?? status}.` });
      onRefresh();
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  async function removeApplication(id: string, label: string) {
    try {
      const res = await fetch(`/api/applications/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      toast({ title: "Removed", description: `${label} deleted from pipeline.` });
      onRefresh();
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Application pipeline</h2>
          <p className="text-sm text-muted-foreground">
            {applications.length} tracked · every logged application moves the stats on the home
            screen
          </p>
        </div>
        <Button className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Log application
        </Button>
      </section>

      {/* Pipeline summary + filter */}
      <section aria-label="Pipeline summary" className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setStatusFilter("all")}
          className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
            statusFilter === "all"
              ? "border-primary/60 bg-primary/15 text-primary"
              : "border-border bg-secondary/40 text-muted-foreground hover:text-foreground"
          }`}
        >
          All {applications.length}
        </button>
        {PIPELINE.map((s: PipelineStatus) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              statusFilter === s
                ? "border-primary/60 bg-primary/15 text-primary"
                : "border-border bg-secondary/40 text-muted-foreground hover:text-foreground"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_CONFIG[s].dot}`} aria-hidden="true" />
            {STATUS_CONFIG[s].label}
            <span className="stat-number font-mono">{counts[s] ?? 0}</span>
          </button>
        ))}
      </section>

      {/* List */}
      <section aria-label="Application list" className="space-y-2">
        {isLoading ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            Loading pipeline…
          </p>
        ) : visible.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
              <NotebookPen className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                {applications.length === 0
                  ? "No applications yet. Run the feed sweep, apply to 5–10 roles, and log them here."
                  : "No applications in this status."}
              </p>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setOpen(true)}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Log the first one
              </Button>
            </CardContent>
          </Card>
        ) : (
          visible.map((app) => (
            <Card key={app.id} className="border-border/70 bg-card/80 transition-colors hover:border-primary/25">
              <CardContent className="flex flex-wrap items-center gap-3 p-3 sm:p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium">{app.role}</p>
                    <span className="text-muted-foreground">·</span>
                    <p className="truncate text-sm text-foreground/80">{app.company}</p>
                    <Badge variant="outline" className={`text-[10px] ${STATUS_CONFIG[app.status]?.chip}`}>
                      {STATUS_CONFIG[app.status]?.label ?? app.status}
                    </Badge>
                  </div>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>{SOURCE_LABELS[app.source] ?? app.source}</span>
                    {app.location && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{app.location}</span>
                      </>
                    )}
                    {app.salary && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{app.salary}</span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>
                      {app.status === "saved"
                        ? `saved ${daysAgoShort(app.createdAt)}`
                        : app.appliedAt
                          ? `applied ${daysAgoShort(app.appliedAt)}`
                          : `logged ${daysAgoShort(app.createdAt)}`}
                    </span>
                  </p>
                  {app.notes && (
                    <p className="mt-1.5 line-clamp-2 rounded-md bg-secondary/40 px-2 py-1 text-xs text-muted-foreground">
                      {app.notes}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {app.jobUrl && (
                    <a
                      href={app.jobUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:border-primary/50 hover:text-primary"
                      aria-label={`Open posting for ${app.role} at ${app.company}`}
                    >
                      <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    </a>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="h-9 gap-1 text-xs">
                        Move status
                        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      {PIPELINE.map((s) => (
                        <DropdownMenuItem
                          key={s}
                          onClick={() => updateStatus(app.id, s)}
                          className="gap-2 text-xs"
                          disabled={s === app.status}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${STATUS_CONFIG[s].dot}`} aria-hidden="true" />
                          {STATUS_CONFIG[s].label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 w-9 p-0 text-muted-foreground hover:text-red-400"
                    aria-label={`Delete ${app.role} at ${app.company}`}
                    onClick={() => removeApplication(app.id, `${app.role} @ ${app.company}`)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </section>

      {/* Add dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Log an application</DialogTitle>
            <DialogDescription>
              30 seconds per entry — this is what turns the auto-apply dream into real data.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="company">Company *</Label>
                <Input
                  id="company"
                  value={form.company}
                  onChange={(e) => set({ company: e.target.value })}
                  placeholder="e.g. Freshworks"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="role">Role *</Label>
                <Input
                  id="role"
                  value={form.role}
                  onChange={(e) => set({ role: e.target.value })}
                  placeholder="e.g. ML Engineer Intern"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="source">Source</Label>
                <Select value={form.source} onValueChange={(v) => set({ source: v })}>
                  <SelectTrigger id="source">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(SOURCE_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="status">Status</Label>
                <Select value={form.status} onValueChange={(v) => set({ status: v })}>
                  <SelectTrigger id="status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PIPELINE.map((s) => (
                      <SelectItem key={s} value={s}>
                        {STATUS_CONFIG[s].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="location">Location</Label>
                <Input
                  id="location"
                  value={form.location}
                  onChange={(e) => set({ location: e.target.value })}
                  placeholder="e.g. Hyderabad / Remote"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="salary">Salary / stipend</Label>
                <Input
                  id="salary"
                  value={form.salary}
                  onChange={(e) => set({ salary: e.target.value })}
                  placeholder="e.g. ₹25k/month"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="jobUrl">Job posting URL</Label>
              <Input
                id="jobUrl"
                type="url"
                value={form.jobUrl}
                onChange={(e) => set({ jobUrl: e.target.value })}
                placeholder="https://…"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={form.notes}
                onChange={(e) => set({ notes: e.target.value })}
                placeholder="Referral? Recruiter name? Assessment deadline? Anything worth remembering."
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={createApplication}
              disabled={submitting}
            >
              {submitting ? "Saving…" : "Save to pipeline"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
