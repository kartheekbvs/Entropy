"use client";

// ─────────────────────────────────────────────────────────────
// STACKBLITZ LIVE APP (v4.8 / v4.9) — "we can see what the agent
// created, right here, RUNNING."
//
// The v4.7 webview could only serve static HTML the agent wrote.
// This panel runs the agent's ACTUAL app — any JS/TS stack — on
// StackBlitz, embedded in the chat:
//
//   • the analyzer at /api/preview/stackblitz READS the project's
//     README (title, description, `npm run dev`, `uvicorn …`)
//     and picks the template — the "AI runs it by seeing the
//     README" engine
//   • `sdk.embedProject()` boots the app with EVERY dependency
//     installed (WebContainers: `npm install` + the start script
//     run automatically, with a real in-browser terminal — the
//     online console) — open source, zero build step
//   • LIVE EDITS: while the agent keeps writing files, fs diffs
//     stream into the RUNNING project (vm.applyFsDiff) so the
//     preview updates in real time
//
//   v4.9 AUTO-RUN COORDINATOR — "delete the old project, generate
//   a NEW site, and StackBlitz still runs it hands-off":
//     • a NEW project root (or a ≥50% rewrite, or a deps/script
//       swap) is a STRUCTURAL change → the container re-boots
//       with the new app: fresh install, fresh start command
//     • reboots are QUIET-GATED: while the agent is mid-write the
//       coordinator waits for a ≥3 s pause (max 25 s) so a
//       half-built app never boots — then deps install, the
//       server starts, the preview goes LIVE, all automatic
//     • Python backends (StackBlitz runs the JS ecosystem) get a
//       "runs locally" card with the README commands
//
// React-safety: the SDK replaces the element it embeds into, so
// the host div is created imperatively inside a stable container
// React never re-parents. The embed effect owns the lifecycle;
// the diff effect only patches the running VM.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow, RotateCw, ExternalLink, BookOpen, Package, Terminal as TerminalIcon,
  Loader2, Play, AlertTriangle, Copy, Check, Boxes, Sparkles, ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { usePreviewChannel, type PreviewWrite } from "@/hooks/use-preview-channel";
import type { SBAnalysis, SBProjectPayload } from "@/lib/stackblitz-project";
import type { Project, VM, ProjectOptions } from "@stackblitz/sdk";

// ── SDK loader (npm bundle → CDN UMD fallback), cached ───────

interface SdkLike {
  embedProject: (
    element: HTMLElement | string,
    project: Project,
    embedOptions?: ProjectOptions & { height?: number | string; width?: number | string; hideNavigation?: boolean }
  ) => Promise<VM>;
  openProject: (project: Project, openOptions?: ProjectOptions & { newWindow?: boolean }) => void;
}

let sdkPromise: Promise<SdkLike> | null = null;

function loadSdk(): Promise<SdkLike> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      try {
        const mod = await import("@stackblitz/sdk");
        return mod.default as unknown as SdkLike;
      } catch {
        // CDN UMD fallback — the embed iframe loads from stackblitz.com
        // anyway, so this adds no new runtime requirement.
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://unpkg.com/@stackblitz/sdk@1/bundles/sdk.umd.js";
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("StackBlitz SDK failed to load (npm + CDN)"));
          document.head.appendChild(script);
        });
        const w = window as unknown as { StackBlitzSDK?: SdkLike };
        if (!w.StackBlitzSDK) throw new Error("StackBlitz SDK global missing after CDN load");
        return w.StackBlitzSDK;
      }
    })();
  }
  return sdkPromise;
}

// ── Data hook — analysis + SSE-driven live refetch ───────────

async function fetchAnalysis(): Promise<SBAnalysis> {
  const res = await fetch("/api/preview/stackblitz");
  const data = (await res.json()) as SBAnalysis & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed: ${res.status}`);
  return data;
}

/**
 * The workspace analysis, refetched live: every agent write (SSE)
 * and every external signature change invalidate the query after
 * a short debounce, so the embed always mirrors the newest code.
 */
export function useStackBlitzProject() {
  const queryClient = useQueryClient();
  const { connected, lastWrite, statsVersion } = usePreviewChannel();

  useEffect(() => {
    if (statsVersion === 0) return;
    const t = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ["sb-project"] });
    }, 1500);
    return () => clearTimeout(t);
  }, [statsVersion, lastWrite?.ts, queryClient]);

  const query = useQuery({
    queryKey: ["sb-project"],
    queryFn: fetchAnalysis,
    refetchInterval: 30000,
    staleTime: 5000,
    retry: 1,
  });

  return { analysis: query.data ?? null, isLoading: query.isLoading, connected, lastWrite };
}

// ── Small UI atoms ───────────────────────────────────────────

function StatusChip({ phase }: { phase: "booting" | "live" | "failed" }) {
  if (phase === "live") {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
        <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
        LIVE
      </span>
    );
  }
  if (phase === "booting") {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        BOOTING
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-300">
      <AlertTriangle className="h-3 w-3" aria-hidden="true" />
      FAILED
    </span>
  );
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Clipboard unavailable");
    }
  }, [text]);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-6 gap-1 px-2 text-[10px]"
      onClick={onCopy}
      title={`Copy: ${text}`}
    >
      {copied ? <Check className="h-3 w-3 text-emerald-400" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
      {label}
    </Button>
  );
}

// ── Python "runs locally" card ───────────────────────────────

function LocalRunCard({ analysis, compact }: { analysis: SBAnalysis; compact: boolean }) {
  const meta = analysis.meta;
  if (!meta) return null;
  const commands = meta.readmeCommands.length > 0 ? meta.readmeCommands : meta.startCommand ? [meta.startCommand] : [];
  return (
    <Card className="glass-panel border-amber-500/25">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <TerminalIcon className="h-4.5 w-4.5 text-amber-400" aria-hidden="true" />
          {meta.title}
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
            RUNS LOCALLY
          </span>
          <span className="text-[11px] font-normal text-muted-foreground">
            the AI read the README — Python stack
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          StackBlitz runs the JavaScript ecosystem inside the browser (WebContainers), so this
          {meta.companionBackend ? "" : " Python"} project&rsquo;s engine stays on your machine. The commands
          below were read from the project&rsquo;s README — run them in your terminal to start it.
        </p>
        <div className="space-y-1.5">
          {commands.map((cmd) => (
            <div
              key={cmd}
              className="flex items-center gap-2 rounded-md border border-border/70 bg-secondary/30 px-2.5 py-1.5 font-mono text-[11px] text-foreground/90"
            >
              <span className="min-w-0 flex-1 truncate" title={cmd}>
                {cmd}
              </span>
              <CopyButton text={cmd} />
            </div>
          ))}
        </div>
        {meta.fallbackHtmlEntry && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() =>
              window.open(`/api/preview/${meta.fallbackHtmlEntry}`, "_blank", "noopener,noreferrer")
            }
          >
            <AppWindow className="h-3.5 w-3.5" aria-hidden="true" />
            Preview the frontend pages live
          </Button>
        )}
        {!compact && meta.warnings.length > 0 && (
          <ul className="space-y-1 text-[11px] text-muted-foreground/80">
            {meta.warnings.slice(0, 4).map((w) => (
              <li key={w} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-400/80" aria-hidden="true" />
                {w}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ── THE PANEL ────────────────────────────────────────────────

type Variant = "mini" | "full";

// ── Auto-run coordinator tuning ─────────────────────────
// A reboot is only "safe" once the agent has paused this long:
const REBOOT_QUIET_MS = 3000;
// …but never wait longer than this — a new site ALWAYS comes up:
const REBOOT_MAX_WAIT_MS = 25000;
const REBOOT_TICK_MS = 750;

export function StackBlitzLivePanel({
  variant = "mini",
  onOpenStudio,
  collapsible = false,
  collapsed,
  onToggleCollapsed,
}: {
  variant?: Variant;
  onOpenStudio?: () => void;
  /** v5.0 — render the panel as a DROPDOWN (slim bar, click to expand). */
  collapsible?: boolean;
  /** controlled collapsed state (defaults to expanded). */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const { analysis, isLoading, connected, lastWrite } = useStackBlitzProject();

  const containerRef = useRef<HTMLDivElement>(null);
  const vmRef = useRef<VM | null>(null);
  const lastFilesRef = useRef<Record<string, string> | null>(null);
  const lastSigRef = useRef<string | null>(null);
  const lastWriteRef = useRef<PreviewWrite | null>(null);
  const firstBootRef = useRef(true);
  const analysisRef = useRef<SBAnalysis | null>(null);

  const [bootKey, setBootKey] = useState(0);
  const [phase, setPhase] = useState<"idle" | "booting" | "live" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  /** v4.9 — a structural change is queued; the reboot fires on agent quiet. */
  const [pendingReboot, setPendingReboot] = useState(false);
  /** v5.0 — dropdown state (uncontrolled fallback). */
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const isCollapsed = collapsed ?? internalCollapsed;
  const toggleCollapsed = () =>
    onToggleCollapsed ? onToggleCollapsed() : setInternalCollapsed((c) => !c);
  /** template + startScript + ROOT as they were at BOOT time (reboot triggers). */
  const bootInfoRef = useRef<{
    template: string | null;
    startScript: string | null;
    root: string | null;
  } | null>(null);
  const rebootTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    lastWriteRef.current = lastWrite;
  }, [lastWrite]);

  // ref-sync FIRST so the boot effect below can read the freshest payload
  useEffect(() => {
    analysisRef.current = analysis;
  }, [analysis]);

  const project: SBProjectPayload | null = analysis?.project ?? null;
  const meta = analysis?.meta ?? null;
  const isSb = analysis?.mode === "stackblitz" && project !== null;

  const embedOptions = useMemo<
    ProjectOptions & {
      height?: number | string;
      width?: number | string;
      hideNavigation?: boolean;
      crossOriginIsolated?: boolean;
    }
  >(
    () => ({
      terminalHeight: variant === "full" ? 45 : 40,
      view: "preview",
      openFile: meta?.openFile ?? undefined,
      startScript: meta?.startScript ?? undefined,
      clickToLoad: false,
      hideExplorer: variant === "mini",
      hideNavigation: variant === "mini",
      // The app itself is cross-origin isolated (COOP/COEP, see next.config.ts),
      // so EVERY StackBlitz iframe must load with `corp=1` (StackBlitz then
      // serves CORP + COOP/COEP on the embed frame). Without it the isolated
      // parent blocks the frame outright; with it WebContainers boot AND
      // EngineBlock (static) embeds keep working — their CDN-based previews
      // (GSAP, fonts) all send `Access-Control-Allow-Origin: *`.
      crossOriginIsolated: true,
      height: "100%",
      width: "100%",
    }),
    [variant, meta?.openFile, meta?.startScript]
  );

  const reboot = useCallback(() => {
    if (rebootTimerRef.current) {
      clearInterval(rebootTimerRef.current);
      rebootTimerRef.current = null;
    }
    setPendingReboot(false);
    setBootKey((k) => k + 1);
  }, []);

  /**
   * v4.9 AUTO-RUN COORDINATOR — a structural change (new project
   * root / deps or start-script swap / heavy rewrite) re-boots the
   * container AUTOMATICALLY, but only once the agent pauses
   * (≥ REBOOT_QUIET_MS without a write) so a half-built app never
   * boots mid-write. The hard deadline REBOOT_MAX_WAIT_MS guarantees
   * a brand-new site ALWAYS comes up: deps install → start script
   * runs → preview LIVE, hands-off. Manual Restart stays immediate.
   */
  const scheduleReboot = useCallback(() => {
    if (rebootTimerRef.current) return; // already armed — one reboot, not a storm
    setPendingReboot(true);
    const deadline = Date.now() + REBOOT_MAX_WAIT_MS;
    rebootTimerRef.current = setInterval(() => {
      const lastAgentWrite = lastWriteRef.current?.ts ?? 0;
      const quietFor = Date.now() - lastAgentWrite;
      if (quietFor >= REBOOT_QUIET_MS || Date.now() >= deadline) reboot();
    }, REBOOT_TICK_MS);
  }, [reboot]);

  // ── boot / reboot (owns the DOM inside the container) ──
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isSb) return;
    let cancelled = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      if (cancelled) return;
      // FIRST boot waits for agent quiet — never boot a half-written project
      const quietMs = Date.now() - (lastWriteRef.current?.ts ?? 0);
      if (firstBootRef.current && quietMs < 3000 && attempts < 40) {
        attempts++;
        retryTimer = setTimeout(() => void run(), 1500);
        return;
      }
      firstBootRef.current = false;
      const current = analysisRef.current;
      const payload = current?.project;
      if (!payload) return;
      try {
        setError(null);
        setPhase("booting");
        const sdk = await loadSdk();
        if (cancelled) return;
        container.replaceChildren();
        const host = document.createElement("div");
        host.style.width = "100%";
        host.style.height = "100%";
        container.appendChild(host);
        const vm = await sdk.embedProject(host, payload as unknown as Project, embedOptions);
        if (cancelled) return;
        vmRef.current = vm;
        lastFilesRef.current = { ...payload.files };
        lastSigRef.current = current?.meta?.signature ?? null;
        bootInfoRef.current = {
          template: current?.meta?.template ?? null,
          startScript: current?.meta?.startScript ?? null,
          root: current?.meta?.root ?? null,
        };
        setPhase("live");
      } catch (err) {
        if (cancelled) return;
        setPhase("failed");
        setError(err instanceof Error ? err.message : "the embed failed to boot");
      }
    };

    void run();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      // unmount / re-mount also disarms the auto-run coordinator
      if (rebootTimerRef.current) {
        clearInterval(rebootTimerRef.current);
        rebootTimerRef.current = null;
      }
      vmRef.current = null;
      try {
        container.replaceChildren();
      } catch {
        /* container already gone */
      }
    };
  }, [bootKey, isSb, embedOptions]);

  // reset boot bookkeeping when the project identity changes wholesale
  useEffect(() => {
    if (!isSb) {
      setPhase("idle");
      setError(null);
      setPendingReboot(false);
      firstBootRef.current = true;
      lastSigRef.current = null;
      lastFilesRef.current = null;
      bootInfoRef.current = null;
      if (rebootTimerRef.current) {
        clearInterval(rebootTimerRef.current);
        rebootTimerRef.current = null;
      }
    }
  }, [isSb]);

  // ── live fs diffs — agent writes stream into the RUNNING app ──
  // v4.9: this is also the AUTO-RUN watchtower. A structural change
  // (new project root, package.json swap, ≥50% rewrite, template or
  // start-script change) schedules a QUIET-GATED reboot, so deleting
  // the old app and generating a brand-new site re-boots the preview
  // automatically the moment the agent pauses — install + start + LIVE.
  useEffect(() => {
    if (!isSb || !analysis) return;
    const signature = analysis.meta?.signature;
    if (!signature || signature === lastSigRef.current) return;

    // while a boot (or a queued auto-reboot) is in flight, that boot
    // mounts the freshest payload anyway — just mark it seen
    if (phase === "booting" || rebootTimerRef.current) {
      lastSigRef.current = signature;
      return;
    }

    const nextFiles = analysis.project?.files ?? {};
    const prevFiles = lastFilesRef.current ?? {};
    const nextKeys = Object.keys(nextFiles);

    // ── structural = fresh-container territory ──
    const pkgChanged =
      nextFiles["package.json"] !== undefined && nextFiles["package.json"] !== prevFiles["package.json"];
    // NEW project directory (delete ModelForge, generate a new site
    // elsewhere) → always a clean reboot: fresh title, fresh install,
    // fresh start command, no stale server process
    const rootChanged = (analysis.meta?.root ?? null) !== (bootInfoRef.current?.root ?? null);
    // same root but ≥ half the tree rewritten → effectively a new app
    const changedCount =
      nextKeys.filter((p) => prevFiles[p] !== nextFiles[p]).length +
      Object.keys(prevFiles).filter((p) => nextFiles[p] === undefined).length;
    const churnRatio = nextKeys.length > 0 ? changedCount / nextKeys.length : 1;
    const structural =
      pkgChanged ||
      rootChanged ||
      churnRatio >= 0.5 ||
      analysis.meta?.template !== bootInfoRef.current?.template ||
      analysis.meta?.startScript !== bootInfoRef.current?.startScript;

    if (structural) {
      // covers a failed boot too: the new project auto-retries itself
      scheduleReboot();
      return;
    }

    // nothing structural and the app is not running yet → mark seen
    if (phase !== "live") {
      lastSigRef.current = signature;
      return;
    }

    const create: Record<string, string> = {};
    for (const [p, c] of Object.entries(nextFiles)) {
      if (prevFiles[p] !== c) create[p] = c;
    }
    const destroy = Object.keys(prevFiles).filter((p) => nextFiles[p] === undefined);
    if (Object.keys(create).length === 0 && destroy.length === 0) {
      lastSigRef.current = signature;
      return;
    }
    const vm = vmRef.current;
    if (!vm) return;
    vm
      .applyFsDiff({ create, destroy })
      .then(() => {
        lastFilesRef.current = { ...nextFiles };
        lastSigRef.current = signature;
      })
      .catch(() => reboot()); // engine can't patch → clean reboot
  }, [analysis, phase, isSb, reboot, scheduleReboot]);

  // ── renders ──
  if (isLoading) {
    return (
      <Card className="glass-panel border-primary/20">
        <CardContent className="flex items-center gap-2.5 px-4 py-3 text-[12px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
          Reading the workspace — detecting the app, reading its README…
        </CardContent>
      </Card>
    );
  }
  if (!analysis || analysis.mode === "none") return null;
  if (analysis.mode === "local") return <LocalRunCard analysis={analysis} compact={variant === "mini"} />;
  if (!isSb || !project || !meta) return null;

  const openOnStackBlitz = async () => {
    try {
      const sdk = await loadSdk();
      sdk.openProject(project as unknown as Project, {
        newWindow: true,
        openFile: meta.openFile ?? undefined,
        startScript: meta.startScript ?? undefined,
        terminalHeight: 45,
        view: "preview",
      });
    } catch {
      toast.error("Could not open StackBlitz", { description: "The SDK failed to load — check your connection." });
    }
  };

  const readmeChip = meta.readmeCommands.length > 0 && (
    <span
      className="hidden items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary md:flex"
      title={`The AI read the README and found:${"\n"}${meta.readmeCommands.slice(0, 6).join("\n")}`}
    >
      <BookOpen className="h-3 w-3" aria-hidden="true" />
      README read
    </span>
  );

  const statusLine = pendingReboot
    ? "new app detected — auto-booting when the agent pauses (deps install → start → live)"
    : phase === "booting"
      ? meta.engine === "webcontainers"
        ? "Booting WebContainer · npm install + npm " + (meta.startScript ? `run ${meta.startScript}` : "start") + " run automatically"
        : "Compiling the project in-browser…"
      : phase === "live"
        ? meta.startCommand
          ? `Running · ${meta.startCommand} · deps installed · live terminal below`
          : "Running live · edits stream in as the agent saves"
        : phase === "failed"
          ? error ?? "the embed failed"
          : "waiting for a quiet moment to boot…";

  // shared JSX — the header rows, embed area and footer are identical
  // for both variants; only the wrapper changes (mini = its own card in
  // the chat, full = bare panel inside the Preview Studio card)
  const headerRows = (
    <>
      <div className="flex flex-wrap items-center gap-2 text-base">
        <Boxes className="h-4.5 w-4.5 text-primary" aria-hidden="true" />
        Live App — Running Here
        <StatusChip phase={phase === "idle" ? "booting" : phase} />
        {pendingReboot && (
          <span
            className="flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300"
            title="The agent generated a different app — the container re-boots automatically on the next pause (max 25 s): fresh install, fresh start command"
          >
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            NEW APP · AUTO-BOOT QUEUED
          </span>
        )}
        {connected && phase === "live" && (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Sparkles className="h-3 w-3 text-emerald-300" aria-hidden="true" />
            agent edits stream in live
          </span>
        )}
        {meta.companionBackend && (
          <span
            className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300"
            title={`Backend runs locally: ${meta.companionBackend.runCommand}`}
          >
            backend: local
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-[11px]"
            onClick={reboot}
            title="Restart the container (fresh npm install + run)"
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Restart</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-[11px]"
            onClick={openOnStackBlitz}
            title="Open the full StackBlitz IDE in a new tab (forkable)"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Open IDE</span>
          </Button>
          {onOpenStudio && variant === "mini" && (
            <Button type="button" size="sm" className="h-7 gap-1.5 px-2.5 text-[11px]" onClick={onOpenStudio}>
              <AppWindow className="h-3.5 w-3.5" aria-hidden="true" />
              Full studio
            </Button>
          )}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="max-w-[260px] truncate font-medium text-foreground/90" title={meta.title}>
          {meta.title}
        </span>
        <span className="rounded-full border border-border/70 bg-secondary/40 px-2 py-0.5 font-mono text-[10px]">
          {meta.template}
        </span>
        <span className="flex items-center gap-1">
          <Package className="h-3 w-3" aria-hidden="true" />
          {meta.fileCount} files
        </span>
        {meta.engine === "webcontainers" && (
          <span className="flex items-center gap-1 text-emerald-300/80">
            <TerminalIcon className="h-3 w-3" aria-hidden="true" />
            deps auto-installed
          </span>
        )}
        {readmeChip}
        <span className="hidden truncate font-mono text-[10px] text-muted-foreground/70 lg:inline" title={`~/${meta.root}`}>
          ~/{meta.root}
        </span>
      </div>
    </>
  );

  const embedArea = (
    <div
      className="relative w-full"
      // v4.9 — doubled: the live app owns the column now that the old
      // v4.7 mini webview is gone. Viewport-aware so mobile stays usable.
      style={{ height: variant === "full" ? "min(78vh, 760px)" : "min(72vh, 640px)" }}
    >
      <div ref={containerRef} className="absolute inset-0 overflow-hidden" />
      {phase !== "live" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/50 backdrop-blur-[2px]">
          <div className="flex max-w-sm flex-col items-center gap-2 px-4 text-center">
            {phase === "failed" ? (
              <AlertTriangle className="h-7 w-7 text-red-400" aria-hidden="true" />
            ) : (
              <Loader2 className="h-7 w-7 animate-spin text-primary" aria-hidden="true" />
            )}
            <p className="text-[12px] text-muted-foreground">{statusLine}</p>
            {phase === "failed" && (
              <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={reboot}>
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                Try again
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );

  const footer = (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/70 px-3 py-1.5 text-[10px] text-muted-foreground">
      <span className="flex items-center gap-1">
        <BookOpen className="h-3 w-3 text-primary/80" aria-hidden="true" />
        {statusLine}
      </span>
      {meta.startCommand && <CopyButton text={meta.startCommand} label={meta.startCommand} />}
    </p>
  );

  const warningsList = meta.warnings.length > 0 && (
    <ul className="space-y-1 border-t border-border/70 px-3 py-2 text-[11px] text-muted-foreground/80">
      {meta.warnings.slice(0, 4).map((w) => (
        <li key={w} className="flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-400/80" aria-hidden="true" />
          {w}
        </li>
      ))}
    </ul>
  );

  if (variant === "full") {
    return (
      <div className="flex flex-col">
        <div className="space-y-1.5 border-b border-border/70 px-3 py-2.5">{headerRows}</div>
        {embedArea}
        {footer}
        {warningsList}
      </div>
    );
  }

  return (
    <Card className="glass-panel border-primary/20">
      <CardHeader className="space-y-1.5 pb-3">
        {collapsible && (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!isCollapsed}
            className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-[11px] font-semibold uppercase tracking-wider text-primary/90 transition-colors hover:text-primary"
            title={isCollapsed ? "Drop the live preview open" : "Collapse the live preview"}
          >
            <ChevronDown
              className={`h-4 w-4 shrink-0 transition-transform duration-300 ${isCollapsed ? "-rotate-90" : ""}`}
              aria-hidden="true"
            />
            Live App Preview
            <span className="ml-auto text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
              {isCollapsed ? "click to drop down" : "auto-runs the agent's app"}
            </span>
          </button>
        )}
        {headerRows}
      </CardHeader>
      <CardContent className="p-0">
        {/* hidden (NOT unmounted) while collapsed — the WebContainer keeps
            running in the background, so re-opening the dropdown is instant
            and never re-installs dependencies */}
        <div hidden={isCollapsed}>
          {embedArea}
          {footer}
          {warningsList}
        </div>
      </CardContent>
    </Card>
  );
}
