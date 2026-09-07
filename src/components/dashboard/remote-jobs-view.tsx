"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Briefcase,
  Clock,
  ExternalLink,
  Globe2,
  MapPin,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Toggle } from "@/components/ui/toggle";
import { Skeleton } from "@/components/ui/skeleton";

interface RemoteRole {
  id: string;
  title: string;
  company: string;
  board: string;
  boardLabel: string;
  url: string;
  location: string;
  worldwide: boolean;
  tags: string[];
  publishedAt: string;
  ageDays: number;
  ageUnknown?: boolean;
  fresherScore: number;
  fresherFlags: string[];
  salary?: string;
  aiFit?: "high" | "medium" | "low";
  aiScore?: number;
  aiReason?: string;
}

interface VerifiedBoard {
  id: string;
  name: string;
  url: string;
  note: string;
  live: boolean;
}

interface SourceStatus {
  id: string;
  label: string;
  ok: boolean;
  count: number;
  ms: number;
  error?: string;
}

interface RadarResponse {
  ok: boolean;
  roles: RemoteRole[];
  boards: VerifiedBoard[];
  ai: {
    provider: string;
    model: string;
    summary: string;
    degraded: boolean;
    notes: string[];
    verdictCount: number;
  };
  meta: {
    fetchedAt: string;
    cache: "hit" | "miss";
    limit: number;
    maxAgeDays: number;
    widened: boolean;
    worldwideCount: number;
    sources: SourceStatus[];
  } | null;
  error?: string;
}

const BOARD_ACCENT: Record<string, string> = {
  remotive: "border-sky-500/40 text-sky-300 bg-sky-500/10",
  remoteok: "border-violet-500/40 text-violet-300 bg-violet-500/10",
  wwr: "border-emerald-500/40 text-emerald-300 bg-emerald-500/10",
  himalayas: "border-amber-500/40 text-amber-300 bg-amber-500/10",
  jobicy: "border-rose-500/40 text-rose-300 bg-rose-500/10",
  pythonorg: "border-primary/50 text-primary bg-primary/10",
};

const FIT_STYLE: Record<string, string> = {
  high: "border-emerald-500/50 bg-emerald-500/15 text-emerald-300",
  medium: "border-amber-500/50 bg-amber-500/15 text-amber-300",
  low: "border-muted-foreground/40 bg-secondary/50 text-muted-foreground",
};

async function fetchRadar(limit: number, refresh: boolean, ai: boolean): Promise<RadarResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (refresh) params.set("refresh", "1");
  if (!ai) params.set("ai", "0");
  const res = await fetch(`/api/jobs/remote-python?${params}`);
  const data = (await res.json()) as RadarResponse;
  if (!res.ok || data.ok === false) {
    throw new Error(data.error ?? `Radar request failed (${res.status})`);
  }
  return data;
}

function ageLabel(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

export function RemoteJobsView() {
  const [limit, setLimit] = useState(10);
  const [aiOn, setAiOn] = useState(true);
  const [bustCache, setBustCache] = useState(false);
  const queryClient = useQueryClient();

  const radar = useQuery({
    queryKey: ["remote-python-jobs", limit, aiOn],
    queryFn: () => fetchRadar(limit, bustCache, aiOn),
    staleTime: 5 * 60_000,
  });
  // one-shot: after a refresh fetch lands, stop forcing refresh on re-renders
  if (bustCache && radar.isSuccess) setBustCache(false);

  const refresh = () => {
    setBustCache(true);
    void queryClient.invalidateQueries({ queryKey: ["remote-python-jobs"] });
  };

  const roles = radar.data?.roles ?? [];
  const meta = radar.data?.meta;
  const ai = radar.data?.ai;

  return (
    <div className="space-y-6">
      {/* ── header ─────────────────────────────────────────── */}
      <Card className="tilt-3d glow-pink overflow-hidden">
        <CardHeader className="pb-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/40 bg-primary/15 glow-pink">
              <Globe2 className="h-5 w-5 text-primary" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <CardTitle className="gradient-text-pink text-lg leading-tight">
                Remote Python Fresher Radar
              </CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Active open-anywhere remote Python developer roles suitable for a fresher —
                aggregated live from 6 verified boards, ranked by AI.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Toggle
                size="sm"
                pressed={aiOn}
                onPressedChange={setAiOn}
                aria-label="Toggle AI ranking"
                className="h-9 gap-1.5 rounded-full border px-3.5 text-xs font-medium data-[state=on]:border-primary/60 data-[state=on]:bg-primary/15 data-[state=on]:text-primary"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                AI RANK
              </Toggle>
              {[5, 10, 15].map((n) => (
                <Toggle
                  key={n}
                  size="sm"
                  pressed={limit === n}
                  onPressedChange={() => setLimit(n)}
                  aria-label={`Show ${n} roles`}
                  className="h-9 w-10 justify-center rounded-full border px-0 text-xs font-medium data-[state=on]:border-primary/60 data-[state=on]:bg-primary/15 data-[state=on]:text-primary"
                >
                  {n}
                </Toggle>
              ))}
              <Button
                size="sm"
                variant="outline"
                onClick={refresh}
                disabled={radar.isFetching}
                className="h-9 gap-1.5 rounded-full border-primary/40 px-3.5 text-xs text-primary hover:bg-primary/15"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${radar.isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
                SWEEP
              </Button>
            </div>
          </div>
        </CardHeader>

        {/* AI banner */}
        {radar.isSuccess && ai && (
          <CardContent className="pt-0">
            <div className="rounded-xl border border-primary/25 bg-primary/5 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {ai.degraded ? (
                  <Badge variant="outline" className="border-amber-500/50 bg-amber-500/10 text-amber-300">
                    <AlertTriangle className="mr-1 h-3 w-3" aria-hidden="true" />
                    heuristic mode
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-primary/50 bg-primary/10 text-primary">
                    <Sparkles className="mr-1 h-3 w-3" aria-hidden="true" />
                    AI: {ai.provider} · {ai.model}
                  </Badge>
                )}
                {meta && (
                  <>
                    <Badge variant="outline" className="border-border bg-secondary/50 text-muted-foreground">
                      <Clock className="mr-1 h-3 w-3" aria-hidden="true" />
                      {ageLabel(Math.max(0, Math.round((Date.now() - Date.parse(meta.fetchedAt)) / 86_400_000)))} · cache {meta.cache}
                    </Badge>
                    <Badge variant="outline" className="border-border bg-secondary/50 text-muted-foreground">
                      <Globe2 className="mr-1 h-3 w-3" aria-hidden="true" />
                      {meta.worldwideCount}/{roles.length} open-anywhere
                    </Badge>
                    {meta.widened && (
                      <Badge variant="outline" className="border-border bg-secondary/50 text-muted-foreground">
                        window widened to {meta.maxAgeDays * 2}d
                      </Badge>
                    )}
                  </>
                )}
              </div>
              {ai.summary && <p className="mt-2 text-xs leading-relaxed text-foreground/80">{ai.summary}</p>}
              {ai.degraded && ai.notes.length > 0 && (
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  Provider trace: {ai.notes.slice(-3).join(" · ")}
                </p>
              )}
            </div>
          </CardContent>
        )}
      </Card>

      {/* ── loading / error ────────────────────────────────── */}
      {radar.isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="mt-2 h-3.5 w-1/3" />
                <Skeleton className="mt-3 h-3 w-1/2" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {radar.isError && (
        <Card className="border-destructive/40">
          <CardContent className="flex flex-wrap items-center gap-3 p-4 text-sm">
            <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
            <span className="text-muted-foreground">
              {(radar.error as Error).message.slice(0, 160)}
            </span>
            <Button size="sm" variant="outline" onClick={() => void radar.refetch()} className="ml-auto">
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── role cards ─────────────────────────────────────── */}
      {radar.isSuccess && roles.length === 0 && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            No active fresher-friendly Python remote roles found in the sweep window — hit SWEEP
            again later or raise the limit. The boards refresh daily.
          </CardContent>
        </Card>
      )}
      <div className="space-y-3">
        {roles.map((role, i) => (
          <Card key={role.id} className="transition-transform hover:-translate-y-0.5">
            <CardContent className="p-4">
              <div className="flex flex-wrap items-start gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-xs font-semibold text-primary">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <a
                    href={role.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group inline-flex max-w-full items-baseline gap-1.5 text-sm font-semibold leading-snug hover:text-primary"
                  >
                    <span className="truncate">{role.title}</span>
                    <ExternalLink className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
                  </a>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {role.company}
                    {role.salary ? ` · ${role.salary}` : ""}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <Badge variant="outline" className={`gap-1 ${BOARD_ACCENT[role.board] ?? "border-border bg-secondary/50 text-muted-foreground"}`}>
                      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                      {role.boardLabel}
                    </Badge>
                    {role.worldwide ? (
                      <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
                        <Globe2 className="h-3 w-3" aria-hidden="true" />
                        open anywhere
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-border bg-secondary/50 text-muted-foreground">
                        <MapPin className="h-3 w-3" aria-hidden="true" />
                        {role.location.slice(0, 32) || "region"}
                      </Badge>
                    )}
                    <Badge variant="outline" className="border-border bg-secondary/50 text-muted-foreground">
                      <Clock className="h-3 w-3" aria-hidden="true" />
                      {role.ageUnknown ? "listed" : ageLabel(role.ageDays)}
                    </Badge>
                    {role.aiFit && (
                      <Badge variant="outline" className={FIT_STYLE[role.aiFit]}>
                        <Sparkles className="h-3 w-3" aria-hidden="true" />
                        {role.aiFit} fit{role.aiScore !== undefined ? ` · ${role.aiScore}/10` : ""}
                      </Badge>
                    )}
                    {role.fresherFlags.slice(0, 2).map((f) => (
                      <Badge key={f} variant="outline" className="border-border bg-secondary/40 text-muted-foreground">
                        {f}
                      </Badge>
                    ))}
                  </div>

                  {role.aiReason && (
                    <p className="mt-2 text-[11px] leading-relaxed text-primary/80">{role.aiReason}</p>
                  )}
                  {role.tags.length > 0 && (
                    <p className="mt-1.5 truncate text-[11px] text-muted-foreground/70">
                      {role.tags.slice(0, 6).join(" · ")}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  asChild
                  className="h-8 shrink-0 rounded-full border-primary/40 bg-primary/15 text-xs text-primary hover:bg-primary/25"
                >
                  <a href={role.url} target="_blank" rel="noopener noreferrer">
                    APPLY
                    <ExternalLink className="ml-1 h-3 w-3" aria-hidden="true" />
                  </a>
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── board health ───────────────────────────────────── */}
      {radar.isSuccess && meta && meta.sources.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Live source health</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-1.5">
            {meta.sources.map((s) => (
              <Badge
                key={s.id}
                variant="outline"
                className={
                  s.ok
                    ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"
                    : "border-destructive/40 bg-destructive/5 text-destructive"
                }
                title={s.error ?? `${s.ms}ms`}
              >
                {s.label} {s.ok ? `${s.count} roles · ${s.ms}ms` : s.error}
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}

      {/* ── verified boards directory ──────────────────────── */}
      {radar.isSuccess && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
              Verified boards for remote Python roles
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {(radar.data?.boards ?? []).map((b) => (
                <a
                  key={b.id}
                  href={b.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group min-w-0 rounded-xl border border-border/70 bg-secondary/30 p-3 transition-colors hover:border-primary/40 hover:bg-primary/5"
                >
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-xs font-semibold group-hover:text-primary">{b.name}</span>
                    {b.live && (
                      <Badge variant="outline" className="shrink-0 border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-300">
                        live-fetched
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{b.note}</p>
                </a>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Briefcase className="h-3 w-3" aria-hidden="true" />
        Roles come straight from the boards&apos; own public APIs/feeds — apply links are always
        on the board&apos;s verified domain. Chain: Experiential Labs (gpt-oss + full catalog) →
        OpenRouter → NVIDIA → Groq (last).
      </p>
    </div>
  );
}
