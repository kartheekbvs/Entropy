"use client";

// ─────────────────────────────────────────────────────────────
// Workspace Explorer (v3.6) — the VS Code-style panel.
//
//   ┌─────────────┬──────────────────────────────┐
//   │ EXPLORER    │  tab1.tsx │ tab2.json │  +    │
//   │ ▾ dashboard │──────────────────────────────│
//   │   index.html│  path/to/file · 120 lines    │
//   │   server.js │  1  const express = …         │
//   │   data.json │  2  …syntax-highlighted code  │
//   │ ▸ AGENT.md  │                               │
//   └─────────────┴──────────────────────────────┘
//
// • Live: while an agent run is active the tree polls every 2.5 s,
//   new files pop in with a NEW badge, their folders auto-expand
//   and (with "Follow" on) the newest file auto-opens — you watch
//   the agent build in real time, Z.ai-workspace style.
// • Viewer: Prism syntax highlighting (oneDark = VS Code Dark+),
//   line numbers, image preview, binary/truncation awareness.
// • Export: "Download workspace" zips everything the agent made
//   (node_modules excluded) so the code can be handed to any
//   other AI model; every file can also be copied or downloaded.
// • The split is draggable (react-resizable-panels) and stacks
//   vertically on mobile.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FolderTree, RefreshCw, Download, Copy, X, Folder, FolderOpen,
  ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown,
  FileCode2, FileJson2, FileText, FileTerminal, Braces, Hash,
  Image as ImageIcon, File, Loader2, Eye, Package,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { useIsMobile } from "@/hooks/use-mobile";
import { timeAgo } from "./shared";

// ── Types (mirror /api/workspace/* responses) ────────────────

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

interface WFile {
  path: string;
  name: string;
  size: number;
  mtime: number;
  binary: boolean;
  truncated: boolean;
  content: string;
  lines: number;
  language: string;
  prism: string;
  kind: "text" | "image" | "binary";
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed: ${url}`);
  return data as T;
}

// ── Small local helpers ──────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fileVisual(name: string): { Icon: LucideIcon; cls: string } {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (["ts", "tsx"].includes(ext)) return { Icon: FileCode2, cls: "text-sky-400" };
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return { Icon: FileCode2, cls: "text-amber-400" };
  if (["json", "lock"].includes(ext)) return { Icon: FileJson2, cls: "text-yellow-300" };
  if (["html", "htm", "xml"].includes(ext)) return { Icon: FileCode2, cls: "text-orange-400" };
  if (["css", "scss", "sass", "less"].includes(ext)) return { Icon: Hash, cls: "text-emerald-400" };
  if (["py"].includes(ext)) return { Icon: FileCode2, cls: "text-emerald-400" };
  if (["sh", "bash", "zsh"].includes(ext)) return { Icon: FileTerminal, cls: "text-emerald-400" };
  if (["md", "markdown", "txt", "log"].includes(ext)) return { Icon: FileText, cls: "text-slate-300" };
  if (["yml", "yaml", "toml", "ini", "env", "cfg"].includes(ext)) return { Icon: Braces, cls: "text-violet-300" };
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"].includes(ext)) {
    return { Icon: ImageIcon, cls: "text-fuchsia-300" };
  }
  return { Icon: File, cls: "text-muted-foreground" };
}

function collectFiles(nodes: WNode[], out: WNode[]): void {
  for (const n of nodes) {
    if (n.type === "file") out.push(n);
    else if (n.children) collectFiles(n.children, out);
  }
}

function collectDirs(nodes: WNode[], out: string[]): void {
  for (const n of nodes) {
    if (n.type === "dir") {
      out.push(n.path);
      if (n.children) collectDirs(n.children, out);
    }
  }
}

function ancestorsOf(p: string): string[] {
  const parts = p.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

function basename(p: string): string {
  return p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p;
}

// ── Tree row ─────────────────────────────────────────────────

interface RowProps {
  node: WNode;
  depth: number;
  expanded: Set<string>;
  activePath: string | null;
  newSet: Set<string>;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}

function TreeRow({ node, depth, expanded, activePath, newSet, onToggleDir, onOpenFile }: RowProps) {
  if (node.type === "dir") {
    const isOpen = expanded.has(node.path);
    const { Icon } = fileVisual(node.name);
    return (
      <>
        <button
          type="button"
          role="treeitem"
          aria-expanded={isOpen}
          aria-selected={false}
          onClick={() => onToggleDir(node.path)}
          title={`${node.path}/ — ${node.children?.length ?? 0} entries`}
          className="flex h-6.5 w-full items-center gap-1 rounded pr-2 text-left text-[12px] text-foreground/80 transition-colors hover:bg-secondary/60 hover:text-foreground"
          style={{ paddingLeft: `${4 + depth * 14}px` }}
        >
          <span className="flex w-3.5 shrink-0 items-center justify-center">
            {isOpen ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
            )}
          </span>
          {isOpen ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-400/90" aria-hidden="true" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-amber-400/90" aria-hidden="true" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {isOpen &&
          (node.children?.length ? (
            node.children.map((c) => (
              <TreeRow
                key={c.path}
                node={c}
                depth={depth + 1}
                expanded={expanded}
                activePath={activePath}
                newSet={newSet}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
              />
            ))
          ) : (
            <p
              className="h-6 flex items-center text-[11px] italic text-muted-foreground/60"
              style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}
            >
              (empty)
            </p>
          ))}
      </>
    );
  }

  const { Icon, cls } = fileVisual(node.name);
  const active = activePath === node.path;
  const isNew = newSet.has(node.path);
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={active}
      onClick={() => onOpenFile(node.path)}
      title={`${node.path} — ${formatBytes(node.size)} · modified ${new Date(node.mtime).toLocaleString()}`}
      className={`flex h-6.5 w-full items-center gap-1 rounded pr-2 text-left text-[12px] transition-colors ${
        active
          ? "bg-primary/15 text-primary hover:bg-primary/20"
          : "text-foreground/75 hover:bg-secondary/60 hover:text-foreground"
      }`}
      style={{ paddingLeft: `${4 + depth * 14}px` }}
    >
      <span className="w-3.5 shrink-0" aria-hidden="true" />
      <Icon className={`h-3.5 w-3.5 shrink-0 ${cls}`} aria-hidden="true" />
      <span className="truncate">{node.name}</span>
      {isNew && (
        <span className="ml-auto shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-px text-[9px] font-semibold tracking-wide text-emerald-300">
          NEW
        </span>
      )}
    </button>
  );
}

// ── Main explorer ────────────────────────────────────────────

interface ExplorerProps {
  isRunning: boolean;
  /** Epoch ms of the current run's start — files newer than this get the NEW badge. */
  runStartedAtMs: number | null;
}

export function WorkspaceExplorer({ isRunning, runStartedAtMs }: ExplorerProps) {
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [zipping, setZipping] = useState(false);
  const initializedRef = useRef(false);
  const followedMtimeRef = useRef(0);

  // ── Tree (live while an agent run is active) ──
  const treeQuery = useQuery({
    queryKey: ["workspace-tree"],
    queryFn: () => fetchJson<WTree>("/api/workspace/tree"),
    refetchInterval: isRunning ? 2500 : 15000,
  });
  const tree = treeQuery.data;

  // Stable signature so downstream effects don't re-fire on every poll
  const treeSig = tree
    ? `${tree.fileCount}:${tree.dirCount}:${tree.totalBytes}:${tree.generatedAt === 0 ? 0 : maxMtime(tree.tree)}`
    : "";

  const newSince = runStartedAtMs !== null ? runStartedAtMs - 2000 : null; // 2 s grace
  const newSig = useMemo(() => {
    if (!tree || newSince === null) return "";
    const files: WNode[] = [];
    collectFiles(tree.tree, files);
    return files
      .filter((f) => f.mtime >= newSince)
      .map((f) => f.path)
      .join("|");
  }, [treeSig, newSince]);
  const newPaths = useMemo(() => (newSig ? newSig.split("|") : []), [newSig]);
  const newSet = useMemo(() => new Set(newPaths), [newSig]);

  const newestPath = useMemo(() => {
    if (!tree) return null;
    const files: WNode[] = [];
    collectFiles(tree.tree, files);
    if (files.length === 0) return null;
    return files.reduce((best, f) => (f.mtime > best.mtime ? f : best)).path;
  }, [treeSig]);
  const newestMtime = useMemo(() => {
    if (!tree) return 0;
    const files: WNode[] = [];
    collectFiles(tree.tree, files);
    return files.length === 0 ? 0 : files.reduce((best, f) => (f.mtime > best.mtime ? f : best)).mtime;
  }, [treeSig]);

  // ── Open/select helpers ──
  const openFile = useCallback((p: string) => {
    setTabs((prev) => (prev.includes(p) ? prev : [...prev, p]));
    setActivePath(p);
  }, []);

  const closeTab = useCallback(
    (p: string) => {
      setTabs((prev) => {
        const idx = prev.indexOf(p);
        const next = prev.filter((t) => t !== p);
        setActivePath((cur) => {
          if (cur !== p) return cur;
          if (next.length === 0) return null;
          return next[Math.min(idx, next.length - 1)];
        });
        return next;
      });
    },
    []
  );

  const toggleDir = useCallback((p: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  // ── First non-empty load: expand top-level folders ──
  useEffect(() => {
    if (!tree || initializedRef.current || tree.tree.length === 0) return;
    initializedRef.current = true;
    const topDirs = tree.tree.filter((n) => n.type === "dir").map((n) => n.path);
    setExpanded(new Set(topDirs));
  }, [tree]);

  // ── New files appeared: auto-expand their folders ──
  useEffect(() => {
    if (newPaths.length === 0) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const p of newPaths) {
        for (const a of ancestorsOf(p)) {
          if (!next.has(a)) {
            next.add(a);
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [newPaths]);

  // ── Auto-follow: while running, open the newest file as it lands ──
  useEffect(() => {
    if (!isRunning || !follow || !newestPath) return;
    if (newestMtime <= followedMtimeRef.current) return;
    followedMtimeRef.current = newestMtime;
    openFile(newestPath);
  }, [isRunning, follow, newestPath, newestMtime, openFile]);

  // ── File content (polled while the agent may still be writing) ──
  const fileQuery = useQuery({
    queryKey: ["workspace-file", activePath],
    queryFn: () => fetchJson<WFile>(`/api/workspace/file?path=${encodeURIComponent(activePath as string)}`),
    enabled: Boolean(activePath),
    refetchInterval: (query) => {
      if (!isRunning || !activePath) return false;
      const f = query.state.data as WFile | undefined;
      return f && !f.binary ? 3000 : false;
    },
  });
  const file = activePath ? (fileQuery.data ?? null) : null;

  const copyContent = useCallback(async () => {
    if (!file?.content) return;
    try {
      await navigator.clipboard.writeText(file.content);
      toast.success("File copied", { description: `${file.name} is on your clipboard.` });
    } catch {
      toast.error("Copy failed", { description: "Your browser blocked clipboard access." });
    }
  }, [file]);

  const downloadZip = useCallback(async () => {
    setZipping(true);
    try {
      const res = await fetch("/api/workspace/download");
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `export failed (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `workspace-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success("Workspace exported", {
        description: `${res.headers.get("x-file-count") ?? "?"} files zipped — hand it to any AI model.`,
      });
    } catch (e) {
      toast.error("Workspace export failed", { description: (e as Error).message });
    } finally {
      setZipping(false);
    }
  }, []);

  const rawUrl = (p: string, inline = false) =>
    `/api/workspace/file?path=${encodeURIComponent(p)}&raw=1${inline ? "&inline=1" : ""}`;

  const handleCls = isMobile
    ? "h-1.5 w-full bg-transparent transition-colors hover:bg-primary/40"
    : "h-full w-1.5 bg-transparent transition-colors hover:bg-primary/40";

  return (
    <Card className="tilt-3d glass-panel border-primary/20">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <FolderTree className="h-4.5 w-4.5 text-primary" aria-hidden="true" />
          Workspace Explorer
          {tree && (
            <span className="text-[11px] font-normal text-muted-foreground">
              {tree.fileCount} files · {formatBytes(tree.totalBytes)}
              {tree.truncated ? " · (capped)" : ""}
            </span>
          )}
          {newPaths.length > 0 && (
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
              {newPaths.length} NEW THIS RUN
            </span>
          )}
          <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            {isRunning && (
              <Button
                type="button"
                variant={follow ? "default" : "outline"}
                size="sm"
                className="h-7 gap-1.5 px-2.5 text-[11px]"
                onClick={() => setFollow((f) => !f)}
                title="Automatically open each file the agent writes, as it writes it"
              >
                <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">Follow live</span>
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-[11px]"
              onClick={() => void treeQuery.refetch()}
              title="Refresh the file tree"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${treeQuery.isFetching ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-[11px]"
              onClick={() => void downloadZip()}
              disabled={zipping}
              title="Zip the whole workspace (node_modules excluded) — feed it to any other AI model"
            >
              {zipping ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Package className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">Download workspace</span>
              <span className="sm:hidden">ZIP</span>
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <PanelGroup direction={isMobile ? "vertical" : "horizontal"} className="h-[440px] sm:h-[500px]">
          {/* ── Tree panel ── */}
          <Panel defaultSize={isMobile ? 38 : 26} minSize={16} maxSize={55}>
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b border-border/70 px-3 py-1.5">
                <p className="microlabel text-muted-foreground">EXPLORER</p>
                <span className="flex gap-0.5">
                  <button
                    type="button"
                    onClick={() => setExpanded(new Set())}
                    title="Collapse all folders"
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
                  >
                    <ChevronsDownUp className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="sr-only">Collapse all folders</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => tree && setExpanded(new Set(collectAllDirPaths(tree.tree)))}
                    title="Expand all folders"
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
                  >
                    <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="sr-only">Expand all folders</span>
                  </button>
                </span>
              </div>
              <div
                className="min-h-0 flex-1 overflow-y-auto py-1.5 pr-1"
                role="tree"
                aria-label="Workspace files"
              >
                {treeQuery.isLoading ? (
                  <p className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    scanning workspace…
                  </p>
                ) : !tree || tree.tree.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                    <FolderTree className="h-7 w-7 text-muted-foreground/50" aria-hidden="true" />
                    <p className="text-xs text-muted-foreground">The workspace is empty.</p>
                    <p className="max-w-[220px] text-[11px] leading-relaxed text-muted-foreground/70">
                      Deploy the coding agent — every file it creates appears here in real time,
                      VS Code style.
                    </p>
                  </div>
                ) : (
                  tree.tree.map((n) => (
                    <TreeRow
                      key={n.path}
                      node={n}
                      depth={0}
                      expanded={expanded}
                      activePath={activePath}
                      newSet={newSet}
                      onToggleDir={toggleDir}
                      onOpenFile={openFile}
                    />
                  ))
                )}
              </div>
              <div className="truncate border-t border-border/70 px-3 py-1.5 text-[10px] text-muted-foreground/70" title={tree?.root}>
                {tree ? tree.root : "…"}
              </div>
            </div>
          </Panel>

          <PanelResizeHandle className={handleCls} />

          {/* ── Viewer panel ── */}
          <Panel minSize={38}>
            <div className="flex h-full flex-col">
              {/* Tab bar */}
              <div
                className="flex items-center gap-0.5 overflow-x-auto border-b border-border/70 px-1.5 py-1"
                role="tablist"
                aria-label="Open files"
              >
                {tabs.length === 0 ? (
                  <p className="px-2 py-1 text-[11px] italic text-muted-foreground/60">
                    no file open — click a file in the tree
                  </p>
                ) : (
                  tabs.map((t) => {
                    const { Icon, cls } = fileVisual(basename(t));
                    const active = t === activePath;
                    return (
                      <div
                        key={t}
                        role="tab"
                        aria-selected={active}
                        className={`group flex shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-[12px] transition-colors ${
                          active
                            ? "border-primary bg-secondary/50 text-foreground"
                            : "border-transparent text-muted-foreground hover:text-foreground"
                        }`}
                        onClick={() => setActivePath(t)}
                      >
                        <Icon className={`h-3.5 w-3.5 ${cls}`} aria-hidden="true" />
                        <span className="max-w-[150px] truncate">{basename(t)}</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeTab(t);
                          }}
                          className="rounded p-0.5 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-secondary/60 hover:text-foreground group-hover:opacity-100 focus:opacity-100"
                          aria-label={`Close ${basename(t)}`}
                        >
                          <X className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>

              {/* File header */}
              {file && (
                <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
                  <span className="truncate font-mono text-foreground/80" title={file.path}>
                    {file.path}
                  </span>
                  <span className="shrink-0">
                    · {file.binary ? formatBytes(file.size) : `${file.lines} lines · ${formatBytes(file.size)}`}
                    {file.binary ? "" : ` · ${file.language}`}
                    {file.binary ? "" : ` · modified ${timeAgo(new Date(file.mtime).toISOString())}`}
                  </span>
                  <span className="ml-auto flex shrink-0 gap-1.5">
                    {!file.binary && file.content && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-6 gap-1 px-2 text-[10.5px]"
                        onClick={() => void copyContent()}
                      >
                        <Copy className="h-3 w-3" aria-hidden="true" />
                        Copy
                      </Button>
                    )}
                    <Button asChild variant="outline" size="sm" className="h-6 gap-1 px-2 text-[10.5px]">
                      <a href={rawUrl(file.path)} download>
                        <Download className="h-3 w-3" aria-hidden="true" />
                        Download
                      </a>
                    </Button>
                  </span>
                </div>
              )}

              {/* Content */}
              <div className="min-h-0 flex-1 overflow-auto">
                {!activePath ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                    <File className="h-7 w-7 text-muted-foreground/40" aria-hidden="true" />
                    <p className="text-xs text-muted-foreground">
                      Select a file from the tree to preview it here.
                    </p>
                    <p className="max-w-xs text-[11px] leading-relaxed text-muted-foreground/60">
                      Code renders with syntax highlighting; images render inline; everything can
                      be copied or downloaded — and the whole workspace exports as a zip.
                    </p>
                  </div>
                ) : fileQuery.isLoading || !file ? (
                  <p className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    loading {basename(activePath)}…
                  </p>
                ) : file.kind === "image" ? (
                  <div className="flex h-full items-center justify-center bg-secondary/20 p-4">
                    <img
                      src={rawUrl(file.path, true)}
                      alt={file.name}
                      className="max-h-full max-w-full object-contain"
                    />
                  </div>
                ) : file.binary ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                    <File className="h-7 w-7 text-muted-foreground/40" aria-hidden="true" />
                    <p className="text-xs text-muted-foreground">
                      Binary file · {formatBytes(file.size)}
                    </p>
                    <Button asChild variant="outline" size="sm" className="gap-1.5">
                      <a href={rawUrl(file.path)} download>
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        Download to view
                      </a>
                    </Button>
                  </div>
                ) : (
                  <div className="flex min-h-full flex-col">
                    {file.truncated && (
                      <p className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200">
                        Large file — showing the first 256 KB. Download for the full content.
                      </p>
                    )}
                    <SyntaxHighlighter
                      language={file.prism || "textfile"}
                      style={oneDark}
                      showLineNumbers
                      wrapLongLines={false}
                      customStyle={{
                        margin: 0,
                        minHeight: "100%",
                        fontSize: "12px",
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                      }}
                      lineNumberStyle={{
                        color: "#6b7280",
                        minWidth: "3.2em",
                        paddingRight: "0.75em",
                        textAlign: "right",
                        userSelect: "none",
                      }}
                      codeTagProps={{
                        style: { fontFamily: "inherit", fontSize: "inherit" },
                      }}
                    >
                      {file.content}
                    </SyntaxHighlighter>
                  </div>
                )}
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </CardContent>
    </Card>
  );
}

// ── helpers on tree data ─────────────────────────────────────

function maxMtime(nodes: WNode[]): number {
  let best = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const n = stack.pop() as WNode;
    if (n.type === "file" && n.mtime > best) best = n.mtime;
    if (n.children) stack.push(...n.children);
  }
  return best;
}

function collectAllDirPaths(nodes: WNode[]): string[] {
  const out: string[] = [];
  collectDirs(nodes, out);
  return out;
}
