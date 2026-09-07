"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  Briefcase,
  CalendarCheck,
  ExternalLink,
  Flame,
  Inbox,
  Radar,
  Sparkles,
  Target,
  TrendingUp,
  Trophy,
  Zap,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PROFILE } from "@/lib/profile";
import {
  Application,
  STATUS_CONFIG,
  SOURCE_LABELS,
  computeStats,
  daysAgoShort,
  timeAgo,
} from "./shared";

interface HomeViewProps {
  applications: Application[];
  isLoading: boolean;
  onNavigate: (tab: string) => void;
}

interface AgentSummary {
  busy: boolean;
  autopilotEnabled: boolean;
  intervalMinutes: number;
  lastRunAt: string | null;
  llm: { provider: string };
}

interface AgentRunSummary {
  id: string;
  goal: string;
  status: string;
  startedAt: string;
  resultPreview: string | null;
}

function AgentOpsStrip({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const autoQuery = useQuery({
    queryKey: ["agent-auto"],
    queryFn: async () => {
      const res = await fetch("/api/agent/auto");
      const data = await res.json();
      if (!res.ok) throw new Error("agent status unavailable");
      return data as AgentSummary;
    },
    refetchInterval: 20_000,
    retry: false,
  });
  const lastRunQuery = useQuery({
    queryKey: ["agent-runs"],
    queryFn: async () => {
      const res = await fetch("/api/agent/runs?limit=1");
      const data = await res.json();
      if (!res.ok) throw new Error("run history unavailable");
      return data as { runs: AgentRunSummary[] };
    },
    refetchInterval: 30_000,
    retry: false,
  });
  const auto = autoQuery.data;
  const lastRun = lastRunQuery.data?.runs[0];
  const engaged = auto?.autopilotEnabled;

  return (
    <Card className="border-primary/25 bg-gradient-to-r from-primary/10 via-card to-card">
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
            auto?.busy
              ? "border-primary/50 bg-primary/20 animate-pulse"
              : "border-primary/30 bg-primary/10"
          }`}
          aria-hidden="true"
        >
          <Bot className="h-4 w-4 text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">
            Agent {auto?.busy ? "running now" : "standing by"}
            <span className="ml-2 rounded-full border border-border/70 bg-secondary/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {auto?.llm.provider ?? "…"} LLM
            </span>
            {engaged && (
              <span className="ml-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
                AUTOPILOT · every {auto?.intervalMinutes}m
              </span>
            )}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {lastRun
                           ? `Last run ${timeAgo(lastRun.startedAt)} · ${lastRun.status}`
              : "No runs yet — 21 live job sources ready"}
            {lastRun?.resultPreview ? ` · ${lastRun.resultPreview.slice(0, 90)}…` : ""}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => onNavigate("agent")} className="gap-1.5">
          <Zap className="h-3.5 w-3.5" aria-hidden="true" />
          Agent console
        </Button>
      </CardContent>
    </Card>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  suffix,
  tone = "default",
  delay,
}: {
  icon: React.ElementType;
  label: string;
  value: number | string;
  suffix?: string;
  tone?: "default" | "green" | "amber" | "sky";
  delay: number;
}) {
  const toneClass =
    tone === "green"
      ? "text-emerald-300"
      : tone === "amber"
        ? "text-amber-300"
        : tone === "sky"
          ? "text-sky-300"
          : "text-foreground";
  return (
    <Card className="glass-panel relative overflow-hidden border-primary/20">
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <p className="microlabel text-muted-foreground">{label}</p>
          <Icon className="h-4 w-4 text-primary/70" aria-hidden="true" />
        </div>
        <p className={`stat-number mt-2 font-mono text-2xl font-semibold sm:text-3xl ${toneClass}`}>
          {value}
          {suffix ? <span className="ml-1 text-sm font-normal text-muted-foreground">{suffix}</span> : null}
        </p>
      </CardContent>
      <div
        className="absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r from-primary/60 via-primary/20 to-transparent"
        style={{ animationDelay: `${delay}ms` }}
      />
    </Card>
  );
}

export function HomeView({ applications, isLoading, onNavigate }: HomeViewProps) {
  const stats = computeStats(applications);

  return (
    <div className="space-y-6">
      {/* Mission banner */}
      <section
        className="terminal-grid relative overflow-hidden rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card to-card p-5 sm:p-6"
        aria-labelledby="mission-heading"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="live-dot h-2 w-2 rounded-full bg-emerald-400" aria-hidden="true" />
              <p className="microlabel text-emerald-300/90">System online · Hunt active</p>
            </div>
            <h1 id="mission-heading" className="mt-2 text-xl font-semibold tracking-tight sm:text-2xl">
              <span className="gradient-text-pink">Entropy</span> · Job Agent Command Center
            </h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Target: <span className="text-foreground">ML/AI + Data + Python Developer</span> ·
              Internship &amp; entry level · Hyderabad · Bengaluru · Chandigarh/Mohali · AP · Remote
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5">
              <Flame className="h-4 w-4 text-amber-300" aria-hidden="true" />
              <span className="stat-number font-mono text-sm font-semibold text-amber-200">
                {stats.streak}d streak
              </span>
            </div>
            {stats.huntingDays > 0 && (
              <p className="microlabel text-muted-foreground">Day {stats.huntingDays} of the hunt</p>
            )}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            size="sm"
            className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() => onNavigate("feeds")}
          >
            <Radar className="h-4 w-4" aria-hidden="true" />
            Run today&apos;s feed sweep
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 border-primary/30 text-primary hover:bg-primary/10"
            onClick={() => onNavigate("jdmatch")}
          >
            <Target className="h-4 w-4" aria-hidden="true" />
            Match a JD
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => onNavigate("tracker")}
          >
            <Inbox className="h-4 w-4" aria-hidden="true" />
            Log an application
          </Button>
        </div>
      </section>

      {/* Agent ops status */}
      <AgentOpsStrip onNavigate={onNavigate} />

      {/* Stats grid */}
      <section aria-label="Pipeline statistics" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard icon={Briefcase} label="Total tracked" value={stats.total} delay={0} />
        <StatCard icon={Zap} label="Applied this week" value={stats.thisWeek} tone="sky" delay={60} />
        <StatCard icon={Activity} label="Active in pipeline" value={stats.active.length} tone="sky" delay={120} />
        <StatCard icon={CalendarCheck} label="Interviews" value={stats.interviews} tone="amber" delay={180} />
        <StatCard icon={Trophy} label="Offers" value={stats.offers} tone="green" delay={240} />
        <StatCard icon={TrendingUp} label="Response rate" value={stats.responseRate} suffix="%" delay={300} />
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Follow-up alerts */}
        <section aria-labelledby="followup-heading" className="lg:col-span-2">
          <Card className="h-full border-border/70 bg-card/80">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <CalendarCheck className="h-4 w-4 text-amber-300" aria-hidden="true" />
                Follow-up radar
                <span className="microlabel ml-auto font-normal text-muted-foreground">
                  Applied 7+ days ago, no response
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <p className="text-sm text-muted-foreground">Scanning pipeline…</p>
              ) : stats.followUps.length === 0 ? (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-4 text-sm text-emerald-300/90">
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                  All clear — nothing is rotting in the pipeline. Keep the daily sweep going.
                </div>
              ) : (
                <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {stats.followUps.map((app) => (
                    <li
                      key={app.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-secondary/40 px-3 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {app.role} <span className="text-muted-foreground">· {app.company}</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {SOURCE_LABELS[app.source] ?? app.source}
                          {app.location ? ` · ${app.location}` : ""} · applied{" "}
                          {daysAgoShort(app.appliedAt ?? app.createdAt)}
                        </p>
                      </div>
                      <Badge variant="outline" className={STATUS_CONFIG[app.status]?.chip}>
                        {STATUS_CONFIG[app.status]?.label ?? app.status}
                      </Badge>
                      {app.jobUrl && (
                        <a
                          href={app.jobUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border hover:border-primary/50 hover:text-primary"
                          aria-label={`Open job posting for ${app.role} at ${app.company}`}
                        >
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Profile snapshot */}
        <section aria-labelledby="profile-heading">
          <Card className="h-full border-border/70 bg-card/80">
            <CardHeader className="pb-3">
              <CardTitle id="profile-heading" className="text-base">
                Candidate profile
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <p className="font-medium">{PROFILE.name}</p>
                <p className="text-xs text-muted-foreground">{PROFILE.title}</p>
              </div>
              <div className="space-y-1.5 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                <p>
                  <span className="text-foreground/80">Edu:</span>{" "}
                  {PROFILE.education.degree}, {PROFILE.education.school} · CGPA{" "}
                  <span className="stat-number font-mono text-foreground">{PROFILE.education.cgpa}</span> ·{" "}
                  {PROFILE.education.period}
                </p>
                <p>
                  <span className="text-foreground/80">Exp:</span> {PROFILE.experience[0].role} ·{" "}
                  {PROFILE.experience[0].company} · {PROFILE.experience[0].period}
                </p>
                <p>
                  <span className="text-foreground/80">Contact:</span> {PROFILE.email} ·{" "}
                  {PROFILE.phone}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5 border-t border-border/60 pt-3">
                {["Python", "SQL", "Scikit-learn", "ML", "AWS", "Git", "Linux", "MySQL"].map((s) => (
                  <Badge
                    key={s}
                    variant="outline"
                    className="border-primary/25 bg-primary/10 text-[11px] text-primary/90"
                  >
                    {s}
                  </Badge>
                ))}
              </div>
              <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
                Last data refresh {isLoading ? "…" : timeAgo(new Date().toISOString())} · updates as
                you log applications
              </p>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}
