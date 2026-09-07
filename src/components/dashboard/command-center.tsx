"use client";

import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboard,
  Radar,
  Target,
  ClipboardList,
  Users,
  Bot,
  Terminal,
  Globe2,
  MonitorPlay,
  Briefcase,
  Code2,
  ChevronDown,
  Boxes,
  Check,
} from "lucide-react";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Application, Contact } from "./shared";
import { HomeView } from "./home-view";
import { FeedsView } from "./feeds-view";
import { RemoteJobsView } from "./remote-jobs-view";
import { TrackerView } from "./tracker-view";
import { JdMatchView } from "./jdmatch-view";
import { ContactsView } from "./contacts-view";
import { AgentView } from "./agent-view";
import { PreviewStudio } from "./preview-studio";

/* ── v5.0 ENTROPY — two agents, one command center ──────────────
   The menu is a two-way toggle: JOB AGENT ⇄ CODING AGENT.
   Inside each agent, every section lives in a dropdown:
     · Job Agent    → tracker & all hunt sections
     · Coding Agent → the live app preview & studio               */

type TabValue =
  | "home"
  | "feeds"
  | "remote"
  | "tracker"
  | "jdmatch"
  | "contacts"
  | "agent"
  | "preview";

type Mode = "job" | "coding";

type Section = {
  value: TabValue | "live";
  label: string;
  hint: string;
  icon: typeof LayoutDashboard;
};

const JOB_SECTIONS: readonly Section[] = [
  { value: "home", label: "Command Center", hint: "mission stats · streak · ops", icon: LayoutDashboard },
  { value: "tracker", label: "Tracker", hint: "application pipeline", icon: ClipboardList },
  { value: "feeds", label: "Daily Feeds", hint: "today's fresh listings", icon: Radar },
  { value: "remote", label: "Remote Python", hint: "open-anywhere roles", icon: Globe2 },
  { value: "jdmatch", label: "JD Match", hint: "resume vs JD scoring", icon: Target },
  { value: "contacts", label: "Contacts", hint: "recruiter book", icon: Users },
];

const CODING_SECTIONS: readonly Section[] = [
  { value: "agent", label: "Agent Console", hint: "chat · terminal · workspace", icon: Bot },
  { value: "live", label: "Live App Preview", hint: "StackBlitz auto-run ▾", icon: Boxes },
  { value: "preview", label: "Preview Studio", hint: "pages lens · devices", icon: MonitorPlay },
];

const JOB_TABS = new Set<string>(JOB_SECTIONS.map((s) => s.value));
const CODING_TABS = new Set<string>(["agent", "preview"]);

const MODE_META: Record<Mode, { label: string; icon: typeof Briefcase; tagline: string }> = {
  job: {
    label: "Job Agent",
    icon: Briefcase,
    tagline: "hunt mode · 21 live boards · autopilot",
  },
  coding: {
    label: "Coding Agent",
    icon: Code2,
    tagline: "build mode · writes code · StackBlitz runs it",
  },
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed: ${url}`);
  return data as T;
}

export function JobCommandCenter() {
  const [tab, setTab] = useState<TabValue>("home");
  const [mode, setMode] = useState<Mode>("job");
  // remembers the last section of each agent so toggling back feels instant
  const lastTabRef = useRef<Record<Mode, TabValue>>({ job: "home", coding: "agent" });
  // pulses the Coding Agent's live-preview dropdown open (agent tab + scroll)
  const [previewSignal, setPreviewSignal] = useState(0);

  const queryClient = useQueryClient();

  const applicationsQuery = useQuery({
    queryKey: ["applications"],
    queryFn: () => fetchJson<{ applications: Application[] }>("/api/applications"),
    select: (d) => d.applications,
  });

  const contactsQuery = useQuery({
    queryKey: ["contacts"],
    queryFn: () => fetchJson<{ contacts: Contact[] }>("/api/contacts"),
    select: (d) => d.contacts,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["applications"] });
    void queryClient.invalidateQueries({ queryKey: ["contacts"] });
  };

  /** Cross-agent navigation: any target tab auto-routes to its agent. */
  const navigate = useCallback((t: string) => {
    if (t === "live") {
      setMode("coding");
      setTab("agent");
      setPreviewSignal((s) => s + 1);
      return;
    }
    if (JOB_TABS.has(t)) {
      setMode("job");
      setTab(t as TabValue);
      lastTabRef.current.job = t as TabValue;
    } else if (CODING_TABS.has(t)) {
      setMode("coding");
      setTab(t as TabValue);
      lastTabRef.current.coding = t as TabValue;
    }
  }, []);

  const switchMode = useCallback(
    (next: Mode) => {
      setMode(next);
      setTab(lastTabRef.current[next]);
    },
    [],
  );

  const selectSection = useCallback(
    (s: Section) => {
      if (s.value === "live") {
        navigate("live");
        return;
      }
      navigate(s.value);
    },
    [navigate],
  );

  const sections = mode === "job" ? JOB_SECTIONS : CODING_SECTIONS;
  // the dropdown trigger always shows what's on screen right now ("live"
  // maps onto the agent console with the preview dropped open)
  const activeSection =
    sections.find((s) => s.value === tab) ??
    (tab === "agent" ? CODING_SECTIONS[1] : sections[0]);
  const ModeIcon = MODE_META[mode].icon;
  const ActiveIcon = activeSection.icon;

  return (
    <div className="min-h-screen bg-background">
      <div className="aurora-bg" aria-hidden="true" />
      <div className="terminal-grid min-h-screen">
        <header className="sticky top-0 z-40 border-b border-primary/20 bg-background/70 backdrop-blur-xl supports-[backdrop-filter]:bg-background/50">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-primary/40 bg-primary/15 glow-pink">
                <Terminal className="h-4.5 w-4.5 text-primary" aria-hidden="true" />
              </div>
              <div className="leading-tight">
                <p className="gradient-text-pink text-sm font-semibold tracking-tight">Entropy</p>
                <p className="microlabel text-muted-foreground">AI agent · created by Kartheek</p>
              </div>
            </div>

            {/* ── the two-agent toggle menu ── */}
            <div
              className="ml-auto flex items-center rounded-full border border-primary/30 bg-secondary/40 p-1"
              role="tablist"
              aria-label="Agent mode"
            >
              {(Object.keys(MODE_META) as Mode[]).map((m) => {
                const MIcon = MODE_META[m].icon;
                const active = mode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => switchMode(m)}
                    className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all sm:text-xs ${
                      active
                        ? "bg-primary text-primary-foreground shadow-[0_6px_22px_rgba(113,200,75,0.35)]"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    title={MODE_META[m].tagline}
                  >
                    <MIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    {MODE_META[m].label.toUpperCase()}
                  </button>
                );
              })}
            </div>

            <span className="ml-auto flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-300 sm:ml-0">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
              SYSTEM ONLINE
            </span>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
          {/* ── agent mode strip: identity + the section dropdown ── */}
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2 text-xs font-medium text-primary">
              <ModeIcon className="h-4 w-4" aria-hidden="true" />
              {MODE_META[mode].label}
              <span className="hidden text-[10px] font-normal text-muted-foreground md:inline">
                · {MODE_META[mode].tagline}
              </span>
            </span>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 min-w-[220px] justify-between gap-2 border-primary/30 bg-secondary/30 px-3 font-medium"
                >
                  <span className="flex items-center gap-2 truncate">
                    <ActiveIcon className="h-4 w-4 text-primary" aria-hidden="true" />
                    {activeSection.label}
                  </span>
                  <ChevronDown
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                sideOffset={6}
                className="w-64 border-primary/25 bg-popover/95 backdrop-blur-xl"
              >
                <DropdownMenuLabel className="text-[10px] tracking-wider text-primary">
                  {MODE_META[mode].label.toUpperCase()} · SECTIONS
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-primary/15" />
                {sections.map((s) => (
                  <DropdownMenuItem
                    key={s.value}
                    onSelect={() => selectSection(s)}
                    className="gap-2.5 py-2"
                  >
                    <s.icon className="h-4 w-4 text-primary/80" aria-hidden="true" />
                    <span className="flex flex-col">
                      <span className="text-sm font-medium">{s.label}</span>
                      <span className="text-[10px] text-muted-foreground">{s.hint}</span>
                    </span>
                    {(s.value === tab || (s.value === "live" && tab === "agent" && previewSignal > 0)) && (
                      <Check className="ml-auto h-4 w-4 text-primary" aria-hidden="true" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <span className="ml-auto hidden items-center gap-1.5 text-[11px] text-muted-foreground lg:flex">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
              tracker data stays on this machine
            </span>
          </div>

          <Tabs value={tab} onValueChange={navigate} className="gap-6">
            <TabsContent value="home" className="mt-0 focus-visible:outline-none">
              <HomeView
                applications={applicationsQuery.data ?? []}
                isLoading={applicationsQuery.isLoading}
                onNavigate={navigate}
              />
            </TabsContent>

            <TabsContent value="agent" className="mt-0 focus-visible:outline-none">
              <AgentView onRefresh={refresh} onNavigate={navigate} previewFocusSignal={previewSignal} />
            </TabsContent>

            <TabsContent value="preview" className="mt-0 focus-visible:outline-none">
              <PreviewStudio />
            </TabsContent>

            <TabsContent value="feeds" className="mt-0 focus-visible:outline-none">
              <FeedsView onLog={() => navigate("tracker")} />
            </TabsContent>

            <TabsContent value="remote" className="mt-0 focus-visible:outline-none">
              <RemoteJobsView />
            </TabsContent>

            <TabsContent value="tracker" className="mt-0 focus-visible:outline-none">
              <TrackerView
                applications={applicationsQuery.data ?? []}
                isLoading={applicationsQuery.isLoading}
                onRefresh={refresh}
              />
            </TabsContent>

            <TabsContent value="jdmatch" className="mt-0 focus-visible:outline-none">
              <JdMatchView />
            </TabsContent>

            <TabsContent value="contacts" className="mt-0 focus-visible:outline-none">
              <ContactsView
                contacts={contactsQuery.data ?? []}
                isLoading={contactsQuery.isLoading}
                onRefresh={refresh}
              />
            </TabsContent>
          </Tabs>
        </main>

        <footer className="mt-auto border-t border-border/70 bg-background/60">
          <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6">
            <p className="text-xs text-muted-foreground">
              Entropy · AI agent stack created by B.V.S. Kartheek · Job Agent on 21 live public boards
              + Coding Agent that ships running apps (StackBlitz auto-run) · MCP server for Claude
              Code (bun run mcp) · tracker data stays on this machine
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}
