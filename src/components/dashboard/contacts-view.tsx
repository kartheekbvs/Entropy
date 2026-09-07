"use client";

import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import {
  AtSign,
  Linkedin,
  Mail,
  Phone,
  Plus,
  Trash2,
  UserRoundSearch,
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
import { Contact, timeAgo } from "./shared";

interface ContactsViewProps {
  contacts: Contact[];
  isLoading: boolean;
  onRefresh: () => void;
}

const CONTACT_ROLES = [
  { value: "HR", label: "HR / Talent Acquisition" },
  { value: "Recruiter", label: "Recruiter (agency)" },
  { value: "Engineer", label: "Engineer (referral / team)" },
  { value: "Manager", label: "Hiring Manager" },
  { value: "Other", label: "Other" },
];

const ROLE_TONE: Record<string, string> = {
  HR: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  Recruiter: "border-violet-500/30 bg-violet-500/10 text-violet-300",
  Engineer: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  Manager: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  Other: "border-border bg-secondary/60 text-muted-foreground",
};

interface FormState {
  name: string;
  company: string;
  role: string;
  email: string;
  phone: string;
  linkedin: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  company: "",
  role: "HR",
  email: "",
  phone: "",
  linkedin: "",
  notes: "",
};

export function ContactsView({ contacts, isLoading, onRefresh }: ContactsViewProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  async function createContact() {
    if (!form.name.trim()) {
      toast({ title: "Name required", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      toast({ title: "Contact saved", description: `${form.name} added to your network book.` });
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

  async function removeContact(id: string, name: string) {
    try {
      const res = await fetch(`/api/contacts/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      toast({ title: "Removed", description: `${name} deleted.` });
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
          <h2 className="text-lg font-semibold">Recruiter & network book</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Log HR contacts and engineers as <span className="text-foreground">they reach out to you</span>{" "}
            (recruiter emails, LinkedIn messages, referral intros). Tracking them legitimately is
            how follow-ups convert — scraping LinkedIn for contacts risks your account, so build
            the list the safe way.
          </p>
        </div>
        <Button className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add contact
        </Button>
      </section>

      {isLoading ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Loading contacts…
        </p>
      ) : contacts.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <UserRoundSearch className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="max-w-md text-sm text-muted-foreground">
              No contacts yet. The moment a recruiter emails or DMs you about a role, save them
              here with notes — &quot;contacted about ML intern @ X, follow up Friday&quot;.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {contacts.map((c) => (
            <Card key={c.id} className="border-border/70 bg-card/80 transition-colors hover:border-primary/25">
              <CardContent className="space-y-2.5 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{c.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {c.company ?? "—"}
                    </p>
                  </div>
                  <Badge variant="outline" className={`shrink-0 text-[10px] ${ROLE_TONE[c.role ?? "Other"]}`}>
                    {c.role ?? "Other"}
                  </Badge>
                </div>
                <div className="space-y-1 text-xs">
                  {c.email && (
                    <a
                      href={`mailto:${c.email}`}
                      className="flex items-center gap-1.5 text-muted-foreground hover:text-primary"
                    >
                      <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{c.email}</span>
                    </a>
                  )}
                  {c.phone && (
                    <a
                      href={`tel:${c.phone}`}
                      className="flex items-center gap-1.5 text-muted-foreground hover:text-primary"
                    >
                      <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{c.phone}</span>
                    </a>
                  )}
                  {c.linkedin && (
                    <a
                      href={c.linkedin.startsWith("http") ? c.linkedin : `https://${c.linkedin}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-muted-foreground hover:text-primary"
                    >
                      <Linkedin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{c.linkedin}</span>
                    </a>
                  )}
                </div>
                {c.notes && (
                  <p className="line-clamp-3 rounded-md bg-secondary/40 px-2 py-1.5 text-xs text-muted-foreground">
                    {c.notes}
                  </p>
                )}
                <div className="flex items-center justify-between border-t border-border/60 pt-2">
                  <p className="text-[11px] text-muted-foreground">
                    {c.lastContactAt ? `last contact ${timeAgo(c.lastContactAt)}` : "not contacted yet"}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400"
                    aria-label={`Delete ${c.name}`}
                    onClick={() => removeContact(c.id, c.name)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add contact</DialogTitle>
            <DialogDescription>
              Someone from a company reached out, or you got a referral intro? Save them here.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="cname">Name *</Label>
                <Input
                  id="cname"
                  value={form.name}
                  onChange={(e) => set({ name: e.target.value })}
                  placeholder="e.g. Priya Sharma"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ccompany">Company</Label>
                <Input
                  id="ccompany"
                  value={form.company}
                  onChange={(e) => set({ company: e.target.value })}
                  placeholder="e.g. TCS Digital"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crole">Role</Label>
              <Select value={form.role} onValueChange={(v) => set({ role: v })}>
                <SelectTrigger id="crole">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONTACT_ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="cemail">Email</Label>
                <Input
                  id="cemail"
                  type="email"
                  value={form.email}
                  onChange={(e) => set({ email: e.target.value })}
                  placeholder="priya@company.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cphone">Phone</Label>
                <Input
                  id="cphone"
                  value={form.phone}
                  onChange={(e) => set({ phone: e.target.value })}
                  placeholder="+91 …"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="clinkedin">
                <AtSign className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                LinkedIn profile
              </Label>
              <Input
                id="clinkedin"
                value={form.linkedin}
                onChange={(e) => set({ linkedin: e.target.value })}
                placeholder="linkedin.com/in/…"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cnotes">Notes</Label>
              <Textarea
                id="cnotes"
                value={form.notes}
                onChange={(e) => set({ notes: e.target.value })}
                placeholder="Contacted me about ML intern role · asked for updated resume · follow up on Monday"
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
              onClick={createContact}
              disabled={submitting}
            >
              {submitting ? "Saving…" : "Save contact"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
