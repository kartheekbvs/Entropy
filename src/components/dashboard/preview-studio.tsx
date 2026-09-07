"use client";

// ─────────────────────────────────────────────────────────────
// LIVE PREVIEW STUDIO (v4.7) — the Replit-style workspace view.
//
//   ┌──────────────┬──────────────────────────────────────┐
//   │ PAGES        │ ● LIVE  ~/frontend/index.html  ⟳  ⧉  │
//   │ ▾ frontend/  ├──────────────────────────────────────┤
//   │   index ●    │                                      │
//   │   dashboard  │      THE APP THE AGENT BUILT,        │
//   │   upload     │      RUNNING — sandboxed webview     │
//   │ ▸ svgs/      │      with device-width switcher      │
//   ├──────────────┴──────────────────────────────────────┤
//   │ TERMINAL ▾ console: the app's logs, live (2)  clear │
//   └─────────────────────────────────────────────────────┘
//
// Everything the user asked for by pasting the Replit screenshot:
//   • the agent's creation is VISIBLE here — the webview renders
//     the real HTML the agent writes, at /api/preview/<path>
//   • it refreshes ITSELF the millisecond the agent saves a file
//     (SSE bus event → the injected runtime reloads the frame);
//     external edits are caught by the 1.5 s signature poll
//   • "Follow agent" switches the view to each new page the
//     agent creates, mid-run (a manual pick turns it off)
//   • the app's console.log/error stream into the console drawer
//   • a ports panel for agent apps that run real servers
//   • open-in-new-tab gives the same page a standalone URL (it
//     keeps live-reloading there too — the runtime is injected)
//
// React-Compiler-clean by design: the previewed entry is DERIVED
// during render (agent write > user pick > best entry), never
// set from an effect; reload-key bumps happen inside SSE event
// listeners (event time, not effect time).
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow, Monitor, Tablet, Smartphone, RotateCw, ExternalLink,
  FileCode2, Image as ImageIcon, Loader2, ChevronDown, ChevronRight, Radio,
  Trash2, Terminal, Network, Sparkles, Boxes,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { toast } from "sonner";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePreviewChannel, type PreviewStatsInfo } from "@/hooks/use-preview-channel";
import { collectPreviewEntries, previewRelevant, type PreviewEntry } from "@/lib/preview";
import { StackBlitzLivePanel, useStackBlitzProject } from "./stackblitz-embed";
import { timeAgo } from "./shared";

// ── Types (mirror /api/workspace/tree) ───────────────────────

interface WNode {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
  children?: WNode[];
}

interface WTree {
  root: string;
  tree: WNode[];
  fileCount: number;
  dirCount: number;
  totalBytes: number;
  truncated: boolean;
  generatedAt: number;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed: ${url}`);
  return data as T;
}

/** ~3s window in which the webview already handled an agent write itself. */
const WRITE_SELF_HANDLED_MS = 3000;

// ── Shared hook: entries tree ────────────────────────────────

function usePreviewEntries(statsVersion: number) {
  const queryClient = useQueryClient();
  const treeQuery = useQuery({
    queryKey: ["workspace-tree"],
    queryFn: () => fetchJson<WTree>("/api/workspace/tree"),
    refetchInterval: 15000,
  });
  const tree = treeQuery.data;
  // React Compiler auto-memoizes this walk; the tree object is
  // referentially stable between refetches
  const entries: PreviewEntry[] = tree ? collectPreviewEntries(tree.tree) : [];

  // signature changed on the SSE stream (external write safety net)
  useEffect(() => {
    if (statsVersion > 0) {
      void queryClient.invalidateQueries({ queryKey: ["workspace-tree"] });
    }
  }, [statsVersion, queryClient]);

  return { treeQuery, entries };
}

/**
 * The DERIVED entry the webview should show:
 *   1. the page the agent just wrote (when Follow agent is on)
 *   2. the user's manual pick, while that file still exists
 *   3. the best entry (index.html app roots first, freshest work)
 * Pure derivation — no effects, no cascading renders.
 */
function deriveActiveEntry(
  entries: PreviewEntry[],
  picked: string | null,
  followAgent: boolean,
  lastWritePath: string | null
): string | null {
  if (followAgent && lastWritePath && /\.html?$/i.test(lastWritePath)) {
    if (entries.some((e) => e.path === lastWritePath)) return lastWritePath;
  }
  if (picked && entries.some((e) => e.path === picked)) return picked;
  return entries.length > 0 ? entries[0].path : null;
}

// ── Shared hook: reload bookkeeping (event-time bumps) ───────

function usePreviewReload(autoRefresh: boolean) {
  const [reloadKey, setReloadKey] = useState(0);
  const [lastReloadAt, setLastReloadAt] = useState<number | null>(null);
  const autoRefreshRef = useRef(autoRefresh);
  useEffect(() => {
    autoRefreshRef.current = autoRefresh;
  }, [autoRefresh]);

  // fired INSIDE the SSE listener (event time — never an effect)
  const onStats = useCallback((info: PreviewStatsInfo) => {
    if (!autoRefreshRef.current) return;
    // the webview already reloaded itself on a fresh agent write
    if (info.lastWriteAgeMs < WRITE_SELF_HANDLED_MS) return;
    setReloadKey((k) => k + 1);
    setLastReloadAt(Date.now());
  }, []);

  const manualRefresh = useCallback(() => {
    setReloadKey((k) => k + 1);
    setLastReloadAt(Date.now());
  }, []);

  return { onStats, reloadKey, lastReloadAt, manualRefresh };
}

// ── Console messages (forwarded from the sandboxed webview) ──

interface ConsoleEntry {
  id: number;
  level: "log" | "info" | "warn" | "error";
  text: string;
  ts: number;
}

const LEVELS = new Set(["log", "info", "warn", "error"]);
const CONSOLE_CAP = 300;

function useWebviewConsole() {
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const idRef = useRef(0);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as
        | { __jccPreview?: number; type?: string; level?: string; text?: string; ts?: number }
        | null;
      if (!d || d.__jccPreview !== 1 || d.type !== "console" || typeof d.text !== "string") return;
      const level = LEVELS.has(String(d.level)) ? (String(d.level) as ConsoleEntry["level"]) : "log";
      setEntries((prev) => {
        const next = [
          ...prev,
          { id: idRef.current++, level, text: d.text?.slice(0, 4000) ?? "", ts: d.ts ?? Date.now() },
        ];
        return next.length > CONSOLE_CAP ? next.slice(next.length - CONSOLE_CAP) : next;
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const clear = useCallback(() => setEntries([]), []);
  const errorCount = entries.filter((e) => e.level === "error").length;
  return { entries, clear, errorCount };
}

// ── Ports panel (agent apps that run real servers) ───────────

interface PortInfo {
  port: number;
  open: boolean;
  label: string;
}

function usePorts() {
  return useQuery({
    queryKey: ["preview-ports"],
    queryFn: () => fetchJson<{ ports: PortInfo[]; openCount: number }>("/api/preview/ports"),
    refetchInterval: 20000,
    select: (d) => d.ports,
  });
}

function PortsStrip() {
  const ports = usePorts();
  const open = (ports.data ?? []).filter((p) => p.open);
  if (open.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Network className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
      <span className="microlabel text-muted-foreground">PORTS</span>
      {open.map((p) => (
        <a
          key={p.port}
          href={`http://localhost:${p.port}/`}
          target="_blank"
          rel="noreferrer"
          title={`${p.label} — port ${p.port} (opens in a new tab)`}
          className="flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20"
        >
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          {p.port}
        </a>
      ))}
    </span>
  );
}

// ── Device toolbar ───────────────────────────────────────────

type Device = "desktop" | "tablet" | "phone";

const DEVICE_WIDTH: Record<Device, string> = {
  desktop: "100%",
  tablet: "768px",
  phone: "390px",
};

function DeviceToggle({ device, onSet }: { device: Device; onSet: (d: Device) => void }) {
  const items: Array<{ key: Device; Icon: typeof Monitor; label: string }> = [
    { key: "desktop", Icon: Monitor, label: "Desktop" },
    { key: "tablet", Icon: Tablet, label: "Tablet width (768px)" },
    { key: "phone", Icon: Smartphone, label: "Phone width (390px)" },
  ];
  return (
    <span className="flex items-center rounded-md border border-border/70 bg-secondary/40 p-0.5">
      {items.map(({ key, Icon, label }) => (
        <button
          key={key}
          type="button"
          onClick={() => onSet(key)}
          title={label}
          aria-pressed={device === key}
          className={`rounded p-1 transition-colors ${
            device === key
              ? "bg-primary/20 text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </span>
  );
}

// ── Webview frame ────────────────────────────────────────────

function WebviewFrame({
  entry,
  reloadKey,
  device,
  title,
}: {
  entry: string;
  reloadKey: number;
  device: Device;
  title: string;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-secondary/25 sm:p-3"
      style={{
        backgroundImage: "radial-gradient(circle, rgba(148,163,184,.12) 1px, transparent 1px)",
        backgroundSize: "18px 18px",
      }}
    >
      <div
        className="relative w-full overflow-hidden bg-white shadow-2xl sm:rounded-xl sm:border sm:border-border/60"
        style={{ width: DEVICE_WIDTH[device], maxWidth: "100%", height: "100%", minHeight: "240px" }}
      >
        <iframe
          key={`${entry}:${reloadKey}`}
          src={`/api/preview/${entry}?t=${reloadKey}`}
          title={title}
          className="h-full w-full border-0 bg-white"
          // scripts run (it IS the app), same-origin withheld so the
          // sandboxed frame can't touch the studio page; the runtime's
          // storage polyfill + the CORS'd events stream keep it fully alive
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  );
}

// ── Console drawer ───────────────────────────────────────────

const LEVEL_STYLE: Record<ConsoleEntry["level"], string> = {
  log: "text-slate-300",
  info: "text-sky-300",
  warn: "text-amber-300",
  error: "text-red-300",
};

function ConsolePanel({
  entries,
  errorCount,
  onClear,
  collapsed,
  onToggle,
}: {
  entries: ConsoleEntry[];
  errorCount: number;
  onClear: () => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!collapsed && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length, collapsed]);

  return (
    <div className="flex min-h-0 flex-col border-t border-border/70">
      <div className="flex h-8 shrink-0 items-center gap-2 px-3">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <Terminal className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          Console
        </button>
        {entries.length > 0 && (
          <span className="text-[10px] text-muted-foreground">{entries.length} lines</span>
        )}
        {errorCount > 0 && (
          <span className="rounded-full border border-red-500/30 bg-red-500/10 px-1.5 py-px text-[9px] font-semibold text-red-300">
            {errorCount} ERROR{errorCount === 1 ? "" : "S"}
          </span>
        )}
        <button
          type="button"
          onClick={onClear}
          className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
          title="Clear console"
          disabled={entries.length === 0}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only">Clear console</span>
        </button>
      </div>
      {!collapsed && (
        <div
          ref={scrollRef}
          role="log"
          aria-label="Previewed app console output"
          className="h-[150px] overflow-y-auto bg-[#0d0a14]/60 px-3 pb-2 font-mono text-[11px] leading-relaxed"
        >
          {entries.length === 0 ? (
            <p className="py-3 text-[11px] italic text-muted-foreground/60">
              console.log / errors from the previewed app appear here, live — forwarded out of the
              sandboxed webview.
            </p>
          ) : (
            entries.map((e) => (
              <p key={e.id} className={`whitespace-pre-wrap break-words ${LEVEL_STYLE[e.level]}`}>
                <span className="mr-2 select-none text-[9px] text-muted-foreground/60">
                  {new Date(e.ts).toLocaleTimeString([], { hour12: false })}
                </span>
                {e.text}
              </p>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Pages tree (preview lens: only renderable files) ─────────

function PageRow({
  entry,
  active,
  onPick,
}: {
  entry: PreviewEntry;
  active: boolean;
  onPick: (path: string) => void;
}) {
  const fresh = Date.now() - entry.mtime < 15 * 60 * 1000;
  const isSvg = /\.svg$/i.test(entry.name);
  const Icon = isSvg ? ImageIcon : FileCode2;
  return (
    <button
      type="button"
      onClick={() => onPick(entry.path)}
      title={`${entry.path} — modified ${new Date(entry.mtime).toLocaleString()}`}
      className={`flex h-7 w-full items-center gap-1.5 rounded px-2 text-left text-[12px] transition-colors ${
        active
          ? "bg-primary/15 text-primary hover:bg-primary/20"
          : "text-foreground/75 hover:bg-secondary/60 hover:text-foreground"
      }`}
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 ${isSvg ? "text-fuchsia-300" : "text-orange-400"}`} aria-hidden="true" />
      <span className="truncate">{entry.name}</span>
      {fresh && (
        <span className="ml-auto shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-px text-[9px] font-semibold text-emerald-300">
          FRESH
        </span>
      )}
    </button>
  );
}

function PagesTree({
  entries,
  activeEntry,
  onPick,
}: {
  entries: PreviewEntry[];
  activeEntry: string | null;
  onPick: (path: string) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, PreviewEntry[]>();
    for (const e of entries) {
      const list = map.get(e.dir) ?? [];
      list.push(e);
      map.set(e.dir, list);
    }
    return [...map.entries()].sort((a, b) =>
      a[0] === b[0] ? 0 : a[0] === "" ? -1 : b[0] === "" ? 1 : a[0].localeCompare(b[0])
    );
  }, [entries]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (dir: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  if (entries.length === 0) return null;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-1.5 pr-1">
      {groups.map(([dir, list]) => {
        const open = !closed.has(dir);
        return (
          <div key={dir || "(root)"} className="mb-0.5">
            <button
              type="button"
              onClick={() => toggle(dir)}
              aria-expanded={open}
              className="flex h-7 w-full items-center gap-1 rounded px-2 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
              title={dir === "" ? "workspace root" : dir}
            >
              {open ? (
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-3 w-3" aria-hidden="true" />
              )}
              <span className="truncate font-mono">{dir === "" ? "workspace/" : `~/${dir}`}</span>
              <span className="ml-auto text-[9px] text-muted-foreground/60">{list.length}</span>
            </button>
            {open && (
              <div className="pl-2">
                {list.map((e) => (
                  <PageRow key={e.path} entry={e} active={activeEntry === e.path} onPick={onPick} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────

function StudioEmptyState({ isLoading }: { isLoading: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      {isLoading ? (
        <>
          <Loader2 className="h-7 w-7 animate-spin text-muted-foreground/60" aria-hidden="true" />
          <p className="text-xs text-muted-foreground">scanning the workspace…</p>
        </>
      ) : (
        <>
          <AppWindow className="h-7 w-7 text-muted-foreground/50" aria-hidden="true" />
          <p className="text-xs text-muted-foreground">No previewable pages yet.</p>
          <p className="max-w-xs text-[11px] leading-relaxed text-muted-foreground/70">
            Give the coding agent a goal — every page it writes appears here running, live, the
            moment it lands. Apps that run servers show up in the PORTS strip below the toolbar.
          </p>
        </>
      )}
    </div>
  );
}

// ── THE STUDIO (full tab) ────────────────────────────────────

export function PreviewStudio() {
  const isMobile = useIsMobile();
  const [picked, setPicked] = useState<string | null>(null);
  const [followAgent, setFollowAgent] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [device, setDevice] = useState<Device>("desktop");
  const [consoleCollapsed, setConsoleCollapsed] = useState(true);

  // v4.8 — the studio has two modes: the classic Pages webview and the
  // StackBlitz Live App (the agent's whole project, running, deps installed).
  // Auto: Live App whenever the analyzer can run the project; a manual pick
  // sticks until the user switches back.
  const [modePick, setModePick] = useState<"pages" | "app" | null>(null);
  const { analysis: sbAnalysis } = useStackBlitzProject();
  const sbAvailable = sbAnalysis?.mode === "stackblitz";
  const mode = modePick ?? (sbAvailable ? "app" : "pages");

  const { onStats, reloadKey, lastReloadAt, manualRefresh } = usePreviewReload(autoRefresh);
  const { connected, lastWrite, statsVersion } = usePreviewChannel({ onStats });
  const { treeQuery, entries } = usePreviewEntries(statsVersion);

  // DERIVED — the entry the webview shows (agent > user > best)
  const activeEntry = deriveActiveEntry(entries, picked, followAgent, lastWrite?.path ?? null);

  // a manual pick takes control back from the agent
  const pick = useCallback((p: string) => {
    setPicked(p);
    setFollowAgent(false);
  }, []);

  const consoleState = useWebviewConsole();
  const ports = usePorts();

  const handleOpenExternal = () => {
    if (!activeEntry) return;
    window.open(`/api/preview/${activeEntry}`, "_blank", "noopener,noreferrer");
    toast.success("Preview opened in a new tab", {
      description: "It live-reloads there too — the runtime ships with the page.",
    });
  };

  const liveChip = connected ? (
    <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
      <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
      LIVE
    </span>
  ) : (
    <span className="flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
      <Radio className="h-3 w-3 animate-pulse" aria-hidden="true" />
      RECONNECTING
    </span>
  );

  const lastActivity =
    lastWrite && previewRelevant(activeEntry ?? "", lastWrite.path)
      ? `agent saved ${timeAgo(new Date(lastWrite.ts).toISOString())}`
      : lastReloadAt
        ? `reloaded ${timeAgo(new Date(lastReloadAt).toISOString())}`
        : "waiting for the agent to write";

  // ── shared right side (webview + console) ──
  const webviewPane = activeEntry ? (
    <WebviewFrame
      entry={activeEntry}
      reloadKey={reloadKey}
      device={device}
      title={`Live preview — ${activeEntry}`}
    />
  ) : (
    <StudioEmptyState isLoading={treeQuery.isLoading} />
  );

  const consolePane = (
    <ConsolePanel
      entries={consoleState.entries}
      errorCount={consoleState.errorCount}
      onClear={consoleState.clear}
      collapsed={consoleCollapsed}
      onToggle={() => setConsoleCollapsed((c) => !c)}
    />
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2">
      {liveChip}
      {activeEntry ? (
        <span className="max-w-[280px] truncate font-mono text-[11px] text-foreground/80" title={activeEntry}>
          ~/{activeEntry}
        </span>
      ) : (
        <span className="text-[11px] italic text-muted-foreground/60">no page selected</span>
      )}
      <span className="hidden text-[10px] text-muted-foreground/70 sm:inline">· {lastActivity}</span>
      <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
        <Button
          type="button"
          variant={followAgent ? "default" : "outline"}
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-[11px]"
          onClick={() => setFollowAgent((f) => !f)}
          title="Jump to each new page the agent creates, mid-run"
        >
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">Follow agent</span>
        </Button>
        <DeviceToggle device={device} onSet={setDevice} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-[11px]"
          onClick={manualRefresh}
          disabled={!activeEntry}
          title="Reload the webview now"
        >
          <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only">Reload preview</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-[11px]"
          onClick={handleOpenExternal}
          disabled={!activeEntry}
          title="Open this page in a new tab (it live-reloads there too)"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only">Open preview in a new tab</span>
        </Button>
      </span>
    </div>
  );

  const entrySelect = (
    <Select value={activeEntry ?? ""} onValueChange={pick} disabled={entries.length === 0}>
      <SelectTrigger className="h-7 w-full max-w-[240px] gap-1 text-[11px]" aria-label="Previewed page">
        <SelectValue placeholder="pick a page…" />
      </SelectTrigger>
      <SelectContent className="max-h-[320px]">
        {entries.map((e) => (
          <SelectItem key={e.path} value={e.path} className="text-[12px]">
            <span className="font-mono">{e.path}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const treeSection = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-1.5">
        <p className="microlabel text-muted-foreground">PAGES</p>
        <span className="text-[10px] text-muted-foreground/70">{entries.length} previewable</span>
      </div>
      {entries.length > 0 ? (
        <PagesTree entries={entries} activeEntry={activeEntry} onPick={pick} />
      ) : (
        <div className="flex flex-1 items-center justify-center px-4 text-center">
          <p className="text-[11px] leading-relaxed text-muted-foreground/60">
            No HTML/SVG pages in the workspace yet.
          </p>
        </div>
      )}
      <div className="truncate border-t border-border/70 px-3 py-1.5 text-[10px] text-muted-foreground/70" title={treeQuery.data?.root}>
        {treeQuery.data?.root ?? "…"}
      </div>
    </div>
  );

  const handleCls = isMobile
    ? "h-1.5 w-full bg-transparent transition-colors hover:bg-primary/40"
    : "h-full w-1.5 bg-transparent transition-colors hover:bg-primary/40";

  return (
    <Card className="tilt-3d glass-panel border-primary/20">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <AppWindow className="h-4.5 w-4.5 text-primary" aria-hidden="true" />
          Live Preview Studio
          <span className="hidden text-[11px] font-normal text-muted-foreground sm:inline">
            what the agent builds — running, here, as it builds it
          </span>
          <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {/* v4.8 mode switch: StackBlitz Live App ⇄ static Pages webview */}
            <div
              className="flex items-center gap-0.5 rounded-lg border border-border/70 bg-secondary/40 p-0.5"
              role="tablist"
              aria-label="Preview mode"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === "app"}
                onClick={() => setModePick("app")}
                disabled={!sbAvailable}
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  mode === "app" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
                title="The agent's whole project running on StackBlitz — deps installed, live terminal"
              >
                <Boxes className="h-3 w-3" aria-hidden="true" />
                Live App
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "pages"}
                onClick={() => setModePick("pages")}
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold transition-colors ${
                  mode === "pages" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
                title="Static HTML pages webview (instant, works offline)"
              >
                <FileCode2 className="h-3 w-3" aria-hidden="true" />
                Pages
              </button>
            </div>
            {ports.data && ports.data.filter((p) => p.open).length > 0 && <PortsStrip />}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {mode === "app" ? (
          /* v4.8 — the agent's project, RUNNING (StackBlitz WebContainers) */
          <StackBlitzLivePanel variant="full" />
        ) : isMobile ? (
          <div className="flex flex-col">
            {toolbar}
            <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
              {entrySelect}
              <label className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  className="accent-primary"
                />
                auto-refresh
              </label>
            </div>
            <div className="h-[360px]">{webviewPane}</div>
            {consolePane}
            <details className="border-t border-border/70">
              <summary className="cursor-pointer px-3 py-2 text-[11px] text-muted-foreground">
                Pages ({entries.length})
              </summary>
              <div className="max-h-[240px]">{treeSection}</div>
            </details>
          </div>
        ) : (
          <PanelGroup direction="horizontal" className="h-[560px]">
            <Panel defaultSize={24} minSize={16} maxSize={45}>
              {treeSection}
            </Panel>
            <PanelResizeHandle className={handleCls} />
            <Panel minSize={40}>
              <div className="flex h-full min-h-0 flex-col">
                {toolbar}
                <div className="flex items-center gap-2 border-b border-border/70 px-3 py-1.5">
                  {entrySelect}
                  <label className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={autoRefresh}
                      onChange={(e) => setAutoRefresh(e.target.checked)}
                      className="accent-primary"
                    />
                    auto-refresh on external edits
                  </label>
                </div>
                {webviewPane}
                {consolePane}
              </div>
            </Panel>
          </PanelGroup>
        )}
      </CardContent>
    </Card>
  );
}

// ── MINI PANEL — removed in v4.9 ────────────────────────────
// The v4.7 static "Live App Preview" mini webview that used to sit
// under the StackBlitz panel in the chat was removed per user
// request: StackBlitz Live App is THE one live preview now (any
// stack, deps installed, auto-run). The chat embed lives in
// stackblitz-embed.tsx; the full studio (with the Pages webview
// lens for static HTML inspection) stays here.
