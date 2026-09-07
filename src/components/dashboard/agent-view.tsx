"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot, Play, Square, Clock, Zap, Wrench, ChevronRight, ChevronDown,
  Radio, ListChecks, Sparkles, Loader2, CheckCircle2, XCircle, History,
  Terminal, Activity, Gauge, FolderPlus, Brain, Microscope, Star, Infinity as InfinityIcon,
  Gift, Laptop, MessageSquare, Send, Coins, Network,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { timeAgo } from "./shared";
import { WorkspaceExplorer } from "./workspace-explorer";
import { StackBlitzLivePanel } from "./stackblitz-embed";
import dynamicImport from "next/dynamic";

// v4.0 — xterm.js is browser-only; load the live console client-side.
const TerminalConsole = dynamicImport(
  () => import("./terminal-console").then((m) => m.TerminalConsole),
  { ssr: false }
);

// ── Types (mirror API responses) ─────────────────────────────
interface AgentStep {
  i: number;
  ts: number;
  type: "goal" | "assistant" | "tool_call" | "tool_result" | "note" | "final" | "error";
  text?: string;
  name?: string;
  args?: unknown;
  summary?: string;
  preview?: string;
}

interface AgentRun {
  id: string;
  goal: string;
  mode: string;
  status: string;
  provider: string | null;
  steps: string;
  result: string | null;
  stepCount: number;
  tokensUsed: number;
  startedAt: string;
  finishedAt: string | null;
}

interface RunSummary {
  id: string;
  goal: string;
  mode: string;
  status: string;
  provider: string | null;
  stepCount: number;
  tokensUsed: number;
  startedAt: string;
  finishedAt: string | null;
  resultPreview: string | null;
  resumable?: boolean;
}

// v4.0 — per-round usage detail streamed live over SSE.
interface UsageStat {
  round: number;
  provider: string;
  model?: string;
  tokens: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  tokPerSec?: number;
  ttftMs?: number;
}

// v4.0 — live token meter strip (Σ in / out / cached / tok-per-sec,
// v4.1: + reasoning tokens, + USD cost on OpenRouter, + model).
function UsageStrip({ stats, totalTokens }: { stats: UsageStat[]; totalTokens: number }) {
  if (stats.length === 0) return null;
  const last = stats[stats.length - 1];
  const inTok = stats.reduce((a, b) => a + (b.promptTokens ?? 0), 0);
  const outTok = stats.reduce((a, b) => a + (b.completionTokens ?? 0), 0);
  const cached = stats.reduce((a, b) => a + (b.cachedTokens ?? 0), 0);
  const think = stats.reduce((a, b) => a + (b.reasoningTokens ?? 0), 0);
  const cost = stats.reduce((a, b) => a + (b.costUsd ?? 0), 0);
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return (
    <span
      className="ml-1 hidden items-center gap-2 font-mono text-[10px] text-muted-foreground lg:flex"
      title="v4.1 live token usage — per round, streamed while the model generates (in / out / cached / reasoning / cost)"
    >
      <Gauge className="h-3 w-3 text-primary" aria-hidden="true" />
      <span>{fmt(inTok)} in</span>
      <span>{fmt(outTok)} out</span>
      {cached > 0 && <span className="text-emerald-300/80">{fmt(cached)} cached</span>}
      {think > 0 && (
        <span className="flex items-center gap-0.5 text-fuchsia-300/80" title="reasoning tokens">
          <Brain className="h-2.5 w-2.5" aria-hidden="true" />
          {fmt(think)}
        </span>
      )}
      {cost > 0 && (
        <span className="text-amber-300/80" title="USD cost (OpenRouter reports exact)">
          ${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}
        </span>
      )}
      {last.tokPerSec !== undefined && (
        <span className="text-primary">{last.tokPerSec} tok/s</span>
      )}
      <span>Σ {fmt(totalTokens || inTok + outTok)}</span>
    </span>
  );
}

// ── v4.1 MODEL TOGGLE (Antigravity-style) ────────────────────
// The main model executes the tools; the others become ordered
// fallbacks with failover memory (Claude Code / OpenClaw pattern).
// v4.2 — FREE CHAIN (OpenRouter :free relay: poolside → nemotron-
// lightning → dots3, $0 on any key) + OLLAMA (local open-weights,
// zero-cost offline) join the toggle as first-class cards.
// v4.3 — EX LABS (Experiential Labs gateway: one xpl_ key → 313
// models, minimax-m2.7-free is $0 with native tool calling) joins
// right after GLM 5.2.
const PROVIDER_ORDER = ["groq", "openrouter", "explabs", "freechain", "nvidia", "ollama", "glm", "gemini", "openai", "zai"];
interface ModelChoice {
  id: string;
  label: string;
  sub: string;
  Icon: typeof Zap;
}
const MODEL_CHOICES: ModelChoice[] = [
  { id: "groq", label: "Groq", sub: "gpt-oss-120b · Turbo", Icon: Zap },
  { id: "openrouter", label: "GLM 5.2", sub: "OpenRouter · deep + $ meter", Icon: Brain },
  { id: "explabs", label: "Ex Labs", sub: "313 models · free slug · $0", Icon: Network },
  { id: "freechain", label: "Free Chain", sub: "OpenRouter · 3 free models · $0", Icon: Gift },
  { id: "nvidia", label: "Nemotron", sub: "NVIDIA · thinking stream", Icon: Microscope },
  { id: "ollama", label: "Ollama", sub: "local · qwen2.5-coder · offline", Icon: Laptop },
  { id: "glm", label: "Z.ai GLM", sub: "direct API", Icon: Star },
  { id: "gemini", label: "Gemini", sub: "Google", Icon: Sparkles },
  { id: "auto", label: "Auto", sub: "chain · best available", Icon: InfinityIcon },
];
const PROVIDER_LABELS: Record<string, string> = {
  groq: "Groq · gpt-oss-120b",
  openrouter: "OpenRouter · GLM 5.2",
  explabs: "Ex Labs · minimax-m2.7-free → kimi → glm ($0 start)",
  freechain: "Free chain · poolside→nemotron→dots3 ($0)",
  nvidia: "NVIDIA · nemotron-3-ultra",
  ollama: "Ollama · local qwen2.5-coder",
  glm: "Z.ai GLM direct",
  gemini: "Gemini",
  openai: "OpenAI",
  zai: "z-ai SDK (sandbox)",
};

interface AutoStatus {
  autopilotEnabled: boolean;
  intervalMinutes: number;
  goalsTemplate: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  busy: boolean;
  activeRunId: string | null;
  scheduler: { running: boolean; minIntervalMinutes: number };
  llm: { provider: string; reason: string };
}

interface HealthStatus {
  ok: boolean;
  agent: {
    providersReady: boolean;
    mode: string;
    active: { provider: string; reason: string };
    providers: Array<{ name: string; configured: boolean; detail: string; hint?: string }>;
  };
  workspace: { root: string; exists: boolean; files: number };
  shell: { kind: string; label: string };
  system: { platform: string; cpuCores: number; totalMemoryMB: number; freeMemoryMB: number; nodeVersion: string };
  /** v4.1 — live request-queue / breaker state per provider. */
  llmQueue?: Record<string, {
    breaker: "closed" | "open";
    breakerRemainingMs: number;
    queued: number;
    inflight: number;
    totalRetries: number;
    lastError: string | null;
  }>;
  /** v4.2 — daily request budgets (the auto-takeover server). */
  llmBudget?: Record<string, {
    used: number;
    limit: number;
    remaining: number;
    exhausted: boolean;
    resetsInMs: number;
  }>;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed: ${url}`);
  return data as T;
}

const PRESETS = [
  {
    label: "Morning brief",
    goal: "Run my daily pipeline: search fresh ML/AI and Python intern/entry roles (India + open remote), score them, add the best new ones to my tracker as saved with match reasoning, and flag anything that needs action today.",
  },
  {
    label: "ML roles · India",
    goal: "Search live ML/AI internships and entry-level roles in India, score them against my profile, and add the top 3 to my tracker with notes on why they fit.",
  },
  {
    label: "Remote Python",
    goal: "Find open-anywhere remote Python developer roles suitable for a fresher, add the best 2 to my tracker, and include the verified board links for remote Python roles.",
  },
  {
    label: "Follow-up radar",
    goal: "Check my tracker stats and follow-ups due, review saved-but-not-applied jobs, and recommend exactly what I should do today — include links.",
  },
  {
    label: "Draft cover letters",
    goal: "List my saved applications, pick the 2 strongest matches, and draft a tailored cover letter for each using my InternPro internship and spam-classifier project.",
  },
];

const CODING_PRESETS = [
  {
    label: "Portfolio site",
    goal: "Build a complete portfolio website in the workspace folder 'portfolio': index.html with a dark modern design, style.css, app.js with smooth interactions, and a Node.js server.js that serves the site on port 4599. Start the server in the background, verify with curl that it returns the HTML, and report the file tree and verification output.",
  },
  {
    label: "Python CLI tool",
    goal: "Build a Python CLI todo app in the workspace folder 'todo-cli': todo.py with add/list/complete/delete commands persisted to a JSON file, plus tests in test_todo.py. Run the tests with python and show the output, then demo the CLI commands.",
  },
  {
    label: "REST API",
    goal: "Build a REST API in the workspace folder 'notes-api' using pure Node.js (no frameworks): server.js with GET/POST/PUT/DELETE endpoints for notes stored in memory plus a health endpoint, on port 4598. Start it in the background and verify each endpoint with curl, then report results.",
  },
  {
    label: "Data dashboard",
    goal: "Build a single-file analytics dashboard in the workspace folder 'dashboard': index.html with Chart.js (loaded from CDN) showing 4 charts fed by data.json you generate, and a Node server.js serving it on port 4597. Start it, curl-verify, and report.",
  },
];

function parseSteps(run: AgentRun | null): AgentStep[] {
  if (!run?.steps) return [];
  try {
    const parsed = JSON.parse(run.steps);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const TOOL_LABELS: Record<string, string> = {
  get_profile: "profile loaded",
  search_public_jobs: "live job search",
  analyze_jd: "JD scored",
  add_application: "tracker write",
  list_applications: "tracker read",
  update_application: "pipeline update",
  add_contact: "contact saved",
  list_contacts: "contacts read",
  ai_write: "AI writing",
  get_stats: "stats read",
  get_board_links: "board links built",
  run_agent_goal: "agent loop",
  workspace_info: "environment scan",
  fs_list: "directory listing",
  fs_read: "file read",
  fs_write: "file written",
  fs_batch: "batch op (turbo)",
  fs_mkdir: "folder created",
  fs_delete: "deleted",
  fs_search: "code search",
  fs_glob: "glob search",
  fs_grep: "regex search",
  fs_tree: "project tree",
  fs_edit: "file edited",
  fs_copy: "file copied",
  fs_move: "file moved",
  todo_write: "plan updated",
  todo_read: "plan read",
  shell_run: "shell command",
  run_coding_goal: "coding agent loop",
  agent_health: "agent health",
};

// ── Transcript rows ──────────────────────────────────────────
function StepRow({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(false);
  const isTool = step.type === "tool_call" || step.type === "tool_result";

  if (step.type === "goal") {
    return (
      <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
        <p className="microlabel mb-1 text-primary">GOAL</p>
        <p className="text-sm leading-relaxed text-foreground">{step.text}</p>
      </div>
    );
  }

  if (step.type === "note") {
    // v3.7: handoff / resume / patience events are LOUD (⚡ prefix → pink)
    const isEvent = Boolean(step.text?.startsWith("⚡"));
    return (
      <p
        className={`flex items-center gap-1.5 pl-2 text-[11px] ${
          isEvent ? "font-medium text-primary" : "text-muted-foreground"
        }`}
      >
        <Radio className={`h-3 w-3 ${isEvent ? "text-primary" : "text-amber-400"}`} aria-hidden="true" />
        {step.text}
      </p>
    );
  }

  if (step.type === "assistant" && step.text) {
    return (
      <p className="whitespace-pre-wrap pl-2 text-sm leading-relaxed text-foreground/90">
        {step.text}
      </p>
    );
  }

  if (step.type === "tool_call") {
    return (
      <div className="flex items-start gap-2.5 pl-2">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-secondary/70">
          <Wrench className="h-3 w-3 text-primary" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-xs text-primary">
            {step.name}
            <span className="ml-2 font-sans text-[11px] text-muted-foreground">
              {TOOL_LABELS[step.name ?? ""] ?? "tool call"}
            </span>
          </p>
          {Boolean(step.args) && Object.keys(step.args as object).length > 0 && (
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {JSON.stringify(step.args)}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (step.type === "tool_result" && isTool) {
    return (
      <div className="pl-9">
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="group flex items-center gap-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground">
            {open ? (
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3 w-3" aria-hidden="true" />
            )}
            <span className="font-mono">{step.name}</span>
            <span>→ {step.summary}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-border/60 bg-secondary/30 p-2.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
              {step.preview}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      </div>
    );
  }

  if (step.type === "final" && step.text) {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
        <p className="microlabel mb-1.5 flex items-center gap-1.5 text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          FINAL REPORT
        </p>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
          {step.text}
        </p>
      </div>
    );
  }

  if (step.type === "error") {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2.5">
        <p className="microlabel mb-0.5 flex items-center gap-1.5 text-red-400">
          <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
          ERROR
        </p>
        <p className="font-mono text-xs text-red-300">{step.text}</p>
      </div>
    );
  }

  return null;
}

// ── Main view ────────────────────────────────────────────────
export function AgentView({
  onRefresh,
  onNavigate,
  previewFocusSignal = 0,
}: {
  onRefresh: () => void;
  onNavigate?: (tab: string) => void;
  /** v5.0 — pulses when the Coding Agent's "Live App Preview" dropdown
   *  item is picked: expands the preview panel + scrolls it into view. */
  previewFocusSignal?: number;
}) {
  const queryClient = useQueryClient();
  const [agentKind, setAgentKind] = useState<"job" | "coding">("job");
  const [goal, setGoal] = useState(PRESETS[0].goal);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [sinceStepMs, setSinceStepMs] = useState(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  // v5.0 — the live preview dropdown (open by default; the Coding Agent
  // menu's "Live App Preview" item re-opens + scrolls to it)
  const previewWrapRef = useRef<HTMLDivElement>(null);
  const [previewOpen, setPreviewOpen] = useState(true);
  useEffect(() => {
    if (!previewFocusSignal) return;
    setPreviewOpen(true);
    const t = window.setTimeout(() => {
      previewWrapRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 180);
    return () => window.clearTimeout(t);
  }, [previewFocusSignal]);

  // ── v4.0 real-time state ── live streamed generation text + usage ──
  const [liveText, setLiveText] = useState("");
  // v4.1 — tail of the live chain-of-thought stream (thinking models).
  const [reasonTail, setReasonTail] = useState("");
  const [usageStats, setUsageStats] = useState<UsageStat[]>([]);
  const [speed, setSpeed] = useState<"low" | "medium" | "high">("low");
  // v4.1 — the MAIN-MODEL toggle (Antigravity-style).
  const [mainModel, setMainModel] = useState<string>("auto");
  const [confirmReset, setConfirmReset] = useState(false);
  // v4.2 — chat-continue (Copilot-Chat-style follow-up on the
  // completed project): input + availability from /api/agent/chat.
  const [chatInput, setChatInput] = useState("");

  const presets = agentKind === "coding" ? CODING_PRESETS : PRESETS;
  const switchKind = useCallback(
    (kind: "job" | "coding") => {
      setAgentKind(kind);
      setGoal((kind === "coding" ? CODING_PRESETS : PRESETS)[0].goal);
    },
    []
  );

  const autoQuery = useQuery({
    queryKey: ["agent-auto"],
    queryFn: () => fetchJson<AutoStatus>("/api/agent/auto"),
    refetchInterval: 15_000,
  });

  const healthQuery = useQuery({
    queryKey: ["agent-health"],
    queryFn: () => fetchJson<HealthStatus>("/api/agent/health"),
    refetchInterval: 60_000,
  });
  const health = healthQuery.data;

  const historyQuery = useQuery({
    queryKey: ["agent-runs"],
    queryFn: () => fetchJson<{ runs: RunSummary[] }>("/api/agent/runs?limit=12"),
    refetchInterval: 20_000,
  });

  // Which run to display: explicit selection > locally started > live/active > latest from history
  const latestRunId = historyQuery.data?.runs[0]?.id ?? null;
  const runId =
    selectedRunId ?? activeRun?.id ?? autoQuery.data?.activeRunId ?? latestRunId;
  const busy = autoQuery.data?.busy ?? false;
  // Poll the live run
  const liveRunQuery = useQuery({
    queryKey: ["agent-run", runId],
    queryFn: () => fetchJson<{ run: AgentRun | null }>(`/api/agent/run?id=${runId}`),
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      const run = query.state.data?.run;
      const isTerminal = run?.status === "completed" || run?.status === "failed";
      return isTerminal ? false : 1500;
    },
  });

  const displayRun: AgentRun | null = liveRunQuery.data?.run ?? activeRun;
  const steps = useMemo(() => parseSteps(displayRun), [displayRun]);
  const isRunning = displayRun?.status === "running";
  const runStartedAtMs = displayRun?.startedAt ? Date.parse(displayRun.startedAt) : null;

  // v3.7 REAL-TIME SSE — the moment the transcript grows server-side the
  // stream pushes an event and the run query refetches instantly (no 1.5s
  // poll lag). v4.0 adds the BUS layer: token DELTAS stream while the
  // model generates (liveText) and per-round usage stats arrive with
  // every round — a 30s Groq round is visibly alive the whole time.
  useEffect(() => {
    if (!isRunning || !runId || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/agent/events?id=${runId}`);
    } catch {
      return;
    }
    es.onmessage = (ev: MessageEvent<string>) => {
      try {
        const data = JSON.parse(ev.data) as {
          type: string;
          sinceStepMs?: number;
          status?: string;
          text?: string;
          round?: number;
          provider?: string;
          model?: string;
          tokens?: number;
          usage?: {
            promptTokens?: number;
            completionTokens?: number;
            cachedTokens?: number;
            reasoningTokens?: number;
            costUsd?: number;
            tokPerSec?: number;
            ttftMs?: number;
          };
        };
        if (typeof data.sinceStepMs === "number") setSinceStepMs(data.sinceStepMs);
        if (data.type === "delta" && typeof data.text === "string") {
          setLiveText((p) => (p.length > 4000 ? p.slice(-2000) : p) + data.text!);
        } else if (data.type === "reasoning" && typeof data.text === "string") {
          // v4.1 — thinking models stream their chain-of-thought live.
          setReasonTail((p) => (p + data.text!).slice(-260));
        } else if (data.type === "delta_reset") {
          setLiveText("");
        } else if (data.type === "delta_end") {
          setLiveText("");
          setReasonTail("");
        } else if (data.type === "usage" && data.usage) {
          const u = data.usage;
          setUsageStats((prev) => [
            ...prev.slice(-59),
            {
              round: data.round ?? prev.length + 1,
              provider: data.provider ?? "",
              model: data.model,
              tokens: data.tokens ?? 0,
              promptTokens: u.promptTokens,
              completionTokens: u.completionTokens,
              cachedTokens: u.cachedTokens,
              reasoningTokens: u.reasoningTokens,
              costUsd: u.costUsd,
              tokPerSec: u.tokPerSec,
              ttftMs: u.ttftMs,
            },
          ]);
        } else if (data.type === "update" || data.type === "done") {
          if (data.type === "done") {
            setLiveText("");
            setReasonTail("");
          }
          void queryClient.invalidateQueries({ queryKey: ["agent-run", runId] });
          void queryClient.invalidateQueries({ queryKey: ["agent-runs"] });
        }
      } catch {
        /* malformed event — ignore */
      }
    };
    es.onerror = () => {
      es?.close();
    };
    return () => es?.close();
  }, [isRunning, runId, queryClient]);

  // v4.0/v4.1 runtime prefs — reasoning effort + MAIN-MODEL toggle
  // apply to the NEXT round, no server restart; persisted in
  // localStorage and re-posted on load.
  useEffect(() => {
    const saved = localStorage.getItem("jcc-llm-prefs");
    if (!saved) return;
    try {
      const p = JSON.parse(saved) as {
        reasoningEffort?: "low" | "medium" | "high";
        model?: string;
        mainProvider?: string | null;
      };
      if (p.reasoningEffort) setSpeed(p.reasoningEffort);
      if (p.mainProvider) setMainModel(p.mainProvider);
      if (p.reasoningEffort || p.model || p.mainProvider) {
        void fetchJson("/api/agent/prefs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reasoningEffort: p.reasoningEffort, model: p.model, mainProvider: p.mainProvider ?? null }),
        }).catch(() => undefined);
      }
    } catch {
      /* ignore bad localStorage */
    }
  }, []);
  const applyPrefs = useCallback(
    (patch: { reasoningEffort?: "low" | "medium" | "high"; model?: string; mainProvider?: string | null }) => {
      void fetchJson("/api/agent/prefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => undefined);
      try {
        localStorage.setItem(
          "jcc-llm-prefs",
          JSON.stringify({
            reasoningEffort: patch.reasoningEffort ?? speed,
            model: patch.model ?? "",
            mainProvider: "mainProvider" in patch ? (patch.mainProvider ?? null) : mainModel,
          })
        );
      } catch {
        /* private mode — non-fatal */
      }
    },
    [speed, mainModel]
  );

  // v4.1 — pick the MAIN model; everything else becomes the ordered
  // fallback chain (tools run on the selected model; a dead main
  // hands off with the full conversation memory preserved).
  const chooseMainModel = useCallback(
    (id: string) => {
      setMainModel(id);
      applyPrefs({ mainProvider: id === "auto" ? null : id });
      const label = MODEL_CHOICES.find((m) => m.id === id);
      if (id === "auto") {
        toast.info("Auto chain restored", {
          description: "Groq → OpenRouter GLM-5.2 → Ex Labs → Free Chain → NVIDIA → GLM → … — best available wins, memory preserved on handoffs.",
        });
      } else {
        toast.success(`Main model: ${label?.label ?? id}`, {
          description: `${label?.sub ?? ""} — falls back down the chain with full memory if it ever stops. Applies from the next round, no restart.`,
        });
      }
    },
    [applyPrefs]
  );

  // v4.0 NEW PROJECT — "after one project the files have to go":
  // archive every visible entry to workspace/.archive/<stamp>/ (hidden
  // from the explorer + zip, recoverable on disk), retire stale run
  // checkpoints, write a fresh AGENT.md.
  const newProject = useCallback(async () => {
    try {
      const data = await fetchJson<{ ok: boolean; archivedTo: string | null; itemsCleared: number }>(
        "/api/workspace/reset",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ archive: true }),
        }
      );
      setConfirmReset(false);
      toast.success("Fresh workspace ready", {
        description: `${data.itemsCleared} entries cleared${
          data.archivedTo ? ` — archived to .archive/${data.archivedTo} (hidden, recoverable)` : ""
        } · fresh AGENT.md written.`,
      });
      void queryClient.invalidateQueries({ queryKey: ["workspace-tree"] });
      void queryClient.invalidateQueries({ queryKey: ["workspace-file"] });
    } catch (e) {
      toast.error("Reset failed", { description: (e as Error).message });
    }
  }, [queryClient]);

  // Elapsed timer while running — setState only inside the interval callback
  useEffect(() => {
    if (!isRunning || !displayRun?.startedAt) return;
    const start = Date.parse(displayRun.startedAt);
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [isRunning, displayRun?.startedAt]);
  const shownElapsed = isRunning ? elapsed : 0;

  // v3.7 "thinking…" — seconds since the last transcript step (SSE ping
  // when streaming, locally derived otherwise; re-renders every second).
  const lastStepTs = steps.length > 0 ? Number(steps[steps.length - 1].ts ?? 0) : 0;
  const thinkingSecs = Math.floor(
    Math.max(sinceStepMs, lastStepTs ? Date.now() - lastStepTs : 0) / 1000
  );

  // Notify + refresh tracker data when a run completes
  const prevStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!displayRun) return;
    const s = displayRun.status;
    if (prevStatus.current === "running" && s === "completed") {
      toast.success("Agent run complete", {
        description: "Check the final report — tracker updated.",
      });
      onRefresh();
      void queryClient.invalidateQueries({ queryKey: ["agent-runs"] });
      // refresh the workspace explorer with everything the run created
      void queryClient.invalidateQueries({ queryKey: ["workspace-tree"] });
      void queryClient.invalidateQueries({ queryKey: ["workspace-file"] });
      // v4.2 — the completed project is now chat-continuable
      void queryClient.invalidateQueries({ queryKey: ["agent-chat"] });
    }
    prevStatus.current = s;
  }, [displayRun, onRefresh, queryClient]);

  // Auto-scroll transcript
  useEffect(() => {
    if (isRunning && transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [steps.length, isRunning]);

  const startRun = useCallback(async () => {
    const g = goal.trim();
    if (g.length < 10) {
      toast.error("Describe the goal in at least 10 characters.");
      return;
    }
    try {
      const data = await fetchJson<{ run: AgentRun }>("/api/agent/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: g, mode: "manual", kind: agentKind }),
      });
      setSelectedRunId(null);
      setActiveRun(data.run);
      setElapsed(0);
      setLiveText("");
      setUsageStats([]);
      toast.success(
        agentKind === "coding" ? "Coding agent deployed" : "Agent deployed",
        { description: agentKind === "coding" ? "Building autonomously in the workspace sandbox — live transcript below." : "Working autonomously — live transcript below." }
      );
      void queryClient.invalidateQueries({ queryKey: ["agent-run", data.run.id] });
      void queryClient.invalidateQueries({ queryKey: ["agent-auto"] });
    } catch (e) {
      toast.error("Could not start the agent", { description: (e as Error).message });
    }
  }, [goal, agentKind, onRefresh, queryClient]);

  const stopRun = useCallback(async () => {
    try {
      await fetchJson(`/api/agent/run?id=${runId}`, { method: "DELETE" });
      toast.info("Stop requested — agent will wrap up after the current step.");
    } catch (e) {
      toast.error("Stop failed", { description: (e as Error).message });
    }
  }, [runId]);

  // v3.7 RESUME — continue an interrupted / crashed / LLM-dead run from
  // its disk checkpoint. The next healthy provider picks up the FULL
  // conversation memory and keeps coding; workspace files untouched.
  const resumeRun = useCallback(
    async (id: string) => {
      try {
        const data = await fetchJson<{ ok: boolean; runId?: string; message: string }>(
          "/api/agent/resume",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ runId: id }),
          }
        );
        if (data.ok && data.runId) {
          setActiveRun(null);
          setSelectedRunId(data.runId);
          setElapsed(0);
          setSinceStepMs(0);
          setLiveText("");
          setUsageStats([]);
          toast.success("Run resumed — memory restored", { description: data.message });
          void queryClient.invalidateQueries({ queryKey: ["agent-run", data.runId] });
          void queryClient.invalidateQueries({ queryKey: ["agent-runs"] });
          void queryClient.invalidateQueries({ queryKey: ["agent-auto"] });
        } else {
          toast.error("Resume unavailable", { description: data.message });
        }
      } catch (e) {
        toast.error("Resume failed", { description: (e as Error).message });
      }
    },
    [queryClient]
  );

  // v4.2 — chat-continue availability: is there a completed project
  // with a saved conversation on disk? Powers the follow-up input.
  const chatQuery = useQuery({
    queryKey: ["agent-chat"],
    queryFn: () =>
      fetchJson<{ available: boolean; latest: { id: string; goal: string } | null }>("/api/agent/chat"),
    refetchInterval: 15000,
  });

  // v4.2 CHAT-CONTINUE — send a follow-up change request: the run's
  // full conversation memory is restored and the agent re-enters the
  // loop on the SAME project (files + ledger + failover chain).
  const sendContinue = useCallback(async () => {
    const message = chatInput.trim();
    if (message.length < 3) {
      toast.error("Describe the change in at least 3 characters.");
      return;
    }
    try {
      const data = await fetchJson<{ ok: boolean; message: string; run: AgentRun }>("/api/agent/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      setChatInput("");
      setActiveRun(data.run);
      setSelectedRunId(null);
      setElapsed(0);
      setSinceStepMs(0);
      setLiveText("");
      setUsageStats([]);
      toast.success("Continuing the project", { description: data.message });
      void queryClient.invalidateQueries({ queryKey: ["agent-run", data.run.id] });
      void queryClient.invalidateQueries({ queryKey: ["agent-runs"] });
      void queryClient.invalidateQueries({ queryKey: ["agent-auto"] });
    } catch (e) {
      toast.error("Continue failed", { description: (e as Error).message });
    }
  }, [chatInput, queryClient]);

  const runNow = useCallback(async () => {
    try {
      await fetchJson("/api/agent/auto", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runNow: true }),
      });
      setSelectedRunId(null);
      setElapsed(0);
      toast.success("Autopilot run fired");
      void queryClient.invalidateQueries({ queryKey: ["agent-auto"] });
    } catch (e) {
      toast.error("Could not trigger run", { description: (e as Error).message });
    }
  }, [queryClient]);

  const toggleAutopilot = useCallback(
    async (enabled: boolean) => {
      try {
        await fetchJson("/api/agent/auto", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        toast.success(enabled ? "Autopilot engaged" : "Autopilot disengaged", {
          description: enabled
            ? "Agent will run automatically on the chosen cadence."
            : "Scheduled runs stopped.",
        });
        void queryClient.invalidateQueries({ queryKey: ["agent-auto"] });
      } catch (e) {
        toast.error("Could not update autopilot", { description: (e as Error).message });
      }
    },
    [queryClient]
  );

  const setInterval_ = useCallback(
    async (minutes: number) => {
      try {
        await fetchJson("/api/agent/auto", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ intervalMinutes: minutes }),
        });
        void queryClient.invalidateQueries({ queryKey: ["agent-auto"] });
        toast.success(`Cadence set to every ${minutes} minutes`);
      } catch (e) {
        toast.error("Could not set cadence", { description: (e as Error).message });
      }
    },
    [queryClient]
  );

  const llm = autoQuery.data?.llm;
  // v4.1 — the live chain mirrors the server registry order with the
  // selected MAIN model in front (only configured providers count).
  const configuredProviders = useMemo(
    () => new Set((health?.agent.providers ?? []).filter((p) => p.configured).map((p) => p.name)),
    [health?.agent.providers]
  );
  const chainOrder =
    mainModel === "auto" || mainModel === "zai"
      ? PROVIDER_ORDER
      : [mainModel, ...PROVIDER_ORDER.filter((p) => p !== mainModel)];
  const chainText = chainOrder.filter((p) => configuredProviders.has(p)).join(" → ") || "none configured yet";
  const providerBadge =
    llm?.provider === "groq"
      ? "Groq · gpt-oss-120b · ⚡ turbo · tools execute on it"
      : llm?.provider === "openrouter"
        ? "OpenRouter · GLM 5.2 · 🧠 deep reasoning · live $ cost"
        : llm?.provider === "nvidia"
          ? "NVIDIA NIM · nemotron-3-ultra · 🔬 thinking stream"
          : llm?.provider === "glm"
            ? "Z.ai GLM · glm-4.6 · native function calling"
            : llm?.provider === "freechain"
              ? "Free chain · poolside→nemotron-lightning→dots3 · 🆓 $0 · auto-rotation"
              : llm?.provider === "ollama"
                ? "Ollama · local open-weights · 💻 offline · unlimited"
                : llm?.provider === "gemini"
                  ? "Gemini · native function calling"
                  : llm?.provider
                    ? `Fallback LLM active (${PROVIDER_LABELS[llm.provider] ?? llm.provider})`
                    : `LLM chain: ${chainText}`;

  // v4.2 — daily-budget chip data per provider (the auto-takeover
  // server). freechain aggregates its per-model counters.
  const budgetFor = (name: string): { used: number; limit: number; exhausted: boolean } | null => {
    const b = health?.llmBudget;
    if (!b) return null;
    if (name === "freechain") {
      const entries = Object.entries(b).filter(([k]) => k.startsWith("freechain:"));
      if (entries.length === 0) return null;
      return {
        used: entries.reduce((a, [, v]) => a + v.used, 0),
        limit: entries.reduce((a, [, v]) => a + (v.limit === 0 ? 150 : v.limit), 0),
        exhausted: entries.every(([, v]) => v.exhausted),
      };
    }
    const one = b[name];
    return one ? { used: one.used, limit: one.limit, exhausted: one.exhausted } : null;
  };

  return (
    <div className="space-y-6">
      {/* ── Mission control header ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="tilt-3d glass-panel border-primary/20 lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="h-4.5 w-4.5 text-primary" aria-hidden="true" />
              Agent Mission Control
              <span
                className={`ml-auto flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-normal text-primary ${
                  isRunning ? "running-ring shimmer" : ""
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${isRunning ? "animate-pulse bg-primary" : "bg-emerald-400"}`} aria-hidden="true" />
                {isRunning ? "RUNNING" : "IDLE"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-1 rounded-lg border border-border/70 bg-secondary/30 p-1" role="tablist" aria-label="Agent mode">
              <button
                type="button"
                role="tab"
                aria-selected={agentKind === "job"}
                onClick={() => switchKind("job")}
                className={`flex-1 rounded-md px-3 py-1.5 text-xs transition-colors ${
                  agentKind === "job"
                    ? "bg-primary/15 text-primary shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Bot className="mr-1.5 inline h-3.5 w-3.5" aria-hidden="true" />
                Job-hunt agent
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={agentKind === "coding"}
                onClick={() => switchKind("coding")}
                className={`flex-1 rounded-md px-3 py-1.5 text-xs transition-colors ${
                  agentKind === "coding"
                    ? "bg-primary/15 text-primary shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Terminal className="mr-1.5 inline h-3.5 w-3.5" aria-hidden="true" />
                Coding agent
              </button>
            </div>
            {/* v4.1 MAIN-MODEL TOGGLE (Antigravity-style) — pick the
                primary brain; the tools run on it and everything else
                becomes an ordered fallback with failover memory. */}
            <div className="space-y-1.5">
              <Label className="microlabel text-muted-foreground">
                MAIN MODEL
                <span className="ml-1.5 normal-case tracking-normal text-primary/70">
                  · tools execute on it · others = ordered fallbacks
                </span>
              </Label>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Main model">
                {MODEL_CHOICES.map((m) => {
                  const active = mainModel === m.id;
                  const configured = m.id === "auto" || configuredProviders.has(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => chooseMainModel(m.id)}
                      title={
                        m.id === "auto"
                          ? "Automatic chain — best available provider wins"
                          : `${m.label} — ${m.sub}${configured ? "" : " (key not configured — it will be skipped until you add it to .env)"}`
                      }
                      className={`group relative flex items-center gap-2 rounded-xl border px-3 py-1.5 text-left transition-all duration-200 hover:-translate-y-0.5 ${
                        active
                          ? "border-primary/60 bg-primary/15 text-primary shadow-[0_0_18px_-4px] shadow-primary/40"
                          : "border-border/70 bg-secondary/40 text-muted-foreground hover:border-primary/30 hover:text-foreground"
                      } ${configured ? "" : "opacity-60"}`}
                    >
                      <m.Icon
                        className={`h-3.5 w-3.5 shrink-0 ${active ? "text-primary" : "text-muted-foreground group-hover:text-primary/70"}`}
                        aria-hidden="true"
                      />
                      <span className="flex flex-col leading-tight">
                        <span className="text-[11.5px] font-medium">{m.label}</span>
                        <span className="text-[9.5px] opacity-70">{m.sub}</span>
                      </span>
                      {active && (
                        <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-primary" aria-hidden="true" />
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="truncate font-mono text-[10px] text-muted-foreground" title={`failover chain: ${chainText}`}>
                fallback chain: <span className="text-fuchsia-300/80">{chainText}</span>
                <span className="text-muted-foreground/60"> · auto-failover keeps memory</span>
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="agent-goal" className="microlabel text-muted-foreground">
                {agentKind === "coding" ? "BUILD GOAL FOR THE CODING AGENT (SANDBOXED WORKSPACE)" : "GOAL FOR THE AGENT"}
              </Label>
              <Textarea
                id="agent-goal"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder={
                  agentKind === "coding"
                    ? "e.g. Build a portfolio website with a Node server on port 4599, verify it responds, and report how to run it…"
                    : "e.g. Find fresh ML internships in India, add the top 3 to my tracker with match notes…"
                }
                className="min-h-[88px] resize-y font-mono text-[13px] leading-relaxed"
                aria-describedby="agent-presets"
              />
            </div>
            <div id="agent-presets" className="flex flex-wrap gap-2">
              {presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setGoal(p.goal)}
                  className={`rounded-full border px-3 py-1 text-[11px] transition-colors ${
                    goal === p.goal
                      ? "border-primary/50 bg-primary/15 text-primary"
                      : "border-border/70 bg-secondary/40 text-muted-foreground hover:border-primary/30 hover:text-foreground"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={startRun} disabled={busy} className="gap-2">
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Play className="h-4 w-4" aria-hidden="true" />
                )}
                {busy ? "Agent is working…" : agentKind === "coding" ? "Deploy builder" : "Deploy agent"}
              </Button>
              {isRunning && (
                <Button variant="outline" onClick={stopRun} className="gap-2">
                  <Square className="h-3.5 w-3.5" aria-hidden="true" />
                  Stop
                </Button>
              )}
              {isRunning && (
                <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                  {shownElapsed}s · {steps.filter((s) => s.type === "tool_call").length} tool calls
                </span>
              )}

              {/* v4.0 TURBO — speed selector: reasoning effort applies to the
                  next round instantly (no server restart). v4.1: it also
                  toggles Nemotron's enable_thinking and GLM-5.2 effort. */}
              <Select
                value={speed}
                onValueChange={(v) => {
                  const next = v as "low" | "medium" | "high";
                  setSpeed(next);
                  applyPrefs({ reasoningEffort: next });
                }}
              >
                <SelectTrigger className="h-8 w-[150px] text-[11px]" aria-label="Reasoning effort (round speed)">
                  <Gauge className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Turbo · low effort</SelectItem>
                  <SelectItem value="medium">Balanced · medium</SelectItem>
                  <SelectItem value="high">Deep · high</SelectItem>
                </SelectContent>
              </Select>

              {/* v4.0 NEW PROJECT — archive the current project, start clean. */}
              {confirmReset ? (
                <span className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void newProject()}
                    className="rounded-full border border-primary/50 bg-primary/15 px-3 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/25"
                  >
                    archive &amp; start clean
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmReset(false)}
                    className="rounded-full border border-border/70 px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmReset(true)}
                  disabled={isRunning}
                  title="Archive the current project to workspace/.archive (hidden + recoverable) and start a clean workspace with a fresh AGENT.md"
                  className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-secondary/40 px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-40"
                >
                  <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
                  New project
                </button>
              )}
              <span className="ml-auto hidden text-[11px] text-muted-foreground sm:block">
                {providerBadge}
              </span>
            </div>

            {/* ── Preflight: provider / workspace / shell health ── */}
            {health && (
              <div className="space-y-2 rounded-lg border border-border/70 bg-secondary/20 p-3">
                <p className="microlabel flex items-center gap-1.5 text-muted-foreground">
                  <Activity className="h-3 w-3 text-primary" aria-hidden="true" />
                  AGENT PREFLIGHT
                  <button
                    type="button"
                    onClick={() => void healthQuery.refetch()}
                    className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
                  >
                    recheck
                  </button>
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {health.agent.providers.map((p) => {
                    const q = health.llmQueue?.[p.name];
                    const breakerOpen = q?.breaker === "open";
                    const budget = budgetFor(p.name);
                    const budgetHot = budget && budget.limit > 0 && !budget.exhausted && budget.used / budget.limit >= 0.75;
                    const budgetOut = budget?.exhausted === true;
                    return (
                      <span
                        key={p.name}
                        title={`${p.detail}${p.hint ? ` — ${p.hint}` : ""}${
                          breakerOpen
                            ? ` · ⚠ circuit OPEN ${Math.ceil((q.breakerRemainingMs ?? 0) / 1000)}s (${q.lastError ?? "repeated failures"})`
                            : q && (q.queued > 0 || q.inflight > 0)
                              ? ` · queue: ${q.inflight} in flight, ${q.queued} waiting (${q.totalRetries} retries total)`
                              : ""
                        }${
                          budget && budget.limit > 0
                            ? ` · daily budget: ${budget.used}/${budget.limit} requests${budgetOut ? " — EXHAUSTED, auto-takeover active" : ""} (resets at UTC midnight)`
                            : ""
                        }`}
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] ${
                          breakerOpen || budgetOut
                            ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                            : budgetHot
                              ? "border-amber-500/30 bg-amber-500/5 text-amber-200/90"
                              : p.configured
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                : "border-border/70 bg-secondary/40 text-muted-foreground"
                        }`}
                      >
                        {p.configured && !breakerOpen && !budgetOut ? (
                          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                        ) : (
                          <XCircle className="h-3 w-3" aria-hidden="true" />
                        )}
                        {p.name}
                        {budget && budget.limit > 0 && budget.used > 0 && (
                          <span
                            className={`font-mono text-[9px] ${budgetOut ? "text-amber-300" : budgetHot ? "text-amber-200/80" : "opacity-70"}`}
                            title="daily request budget (auto-takeover when exhausted)"
                          >
                            {budget.used}/{budget.limit}
                          </span>
                        )}
                        {p.name === mainModel && (
                          <span className="font-semibold text-primary" title="your MAIN model (toggle)">
                            ★
                          </span>
                        )}
                      </span>
                    );
                  })}
                  <span
                    className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-secondary/40 px-2 py-0.5 text-[10.5px] text-muted-foreground"
                    title={health.shell.label}
                  >
                    shell: {health.shell.kind}
                  </span>
                  <span
                    className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-secondary/40 px-2 py-0.5 text-[10.5px] text-muted-foreground"
                    title={health.workspace.root}
                  >
                    workspace: {health.workspace.files} files
                  </span>
                  <span
                    className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-secondary/40 px-2 py-0.5 text-[10.5px] text-muted-foreground"
                    title={health.system.platform}
                  >
                    {health.system.cpuCores} cores ·{" "}
                    {(health.system.freeMemoryMB / 1024).toFixed(1)}GB free RAM
                  </span>
                </div>
                {!health.ok && (
                  <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-200">
                    No LLM key configured — the autonomous agent cannot think. Add{" "}
                    <code className="font-mono text-amber-100">GEMINI_API_KEY</code> (free at
                    aistudio.google.com/apikey) to{" "}
                    <code className="font-mono text-amber-100">.env</code> in the project folder and
                    restart. The dashboard itself (tracker, feeds, JD match) works without keys.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Autopilot card ── */}
        <Card className="glass-panel border-primary/20">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4.5 w-4.5 text-amber-400" aria-hidden="true" />
              Autopilot
              <span
                className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] ${
                  autoQuery.data?.autopilotEnabled
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-border/70 bg-secondary/40 text-muted-foreground"
                }`}
              >
                {autoQuery.data?.autopilotEnabled ? "ENGAGED" : "OFF"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="autopilot-switch" className="text-sm">
                  Run automatically
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  Scheduler {autoQuery.data?.scheduler.running ? "online" : "offline"} · min{" "}
                  {autoQuery.data?.scheduler.minIntervalMinutes ?? 30} min
                </p>
              </div>
              <Switch
                id="autopilot-switch"
                checked={autoQuery.data?.autopilotEnabled ?? false}
                onCheckedChange={toggleAutopilot}
                disabled={autoQuery.isLoading}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="microlabel text-muted-foreground">CADENCE</Label>
              <Select
                value={String(autoQuery.data?.intervalMinutes ?? 120)}
                onValueChange={(v) => void setInterval_(parseInt(v, 10))}
              >
                <SelectTrigger className="h-9" aria-label="Autopilot cadence">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[30, 60, 120, 240, 480].map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      Every {m < 60 ? `${m} min` : m < 480 ? `${m / 60} h` : `${m / 60} h`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <dl className="space-y-1.5 text-[11px]">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Last run</dt>
                <dd>{autoQuery.data?.lastRunAt ? timeAgo(autoQuery.data.lastRunAt) : "never"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Next run</dt>
                <dd>
                  {autoQuery.data?.autopilotEnabled && autoQuery.data?.nextRunAt
                    ? new Date(autoQuery.data.nextRunAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">LLM</dt>
                <dd className="truncate text-right" title={llm?.reason}>
                  {llm?.provider ?? "…"}
                </dd>
              </div>
            </dl>

            <Button variant="outline" size="sm" onClick={runNow} disabled={busy} className="w-full gap-2">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              Run autopilot goal now
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* ── VS Code-style workspace explorer (live file tree + viewer + zip export) ── */}
      <WorkspaceExplorer isRunning={isRunning} runStartedAtMs={runStartedAtMs} />

      {/* ── v4.8/v4.9 STACKBLITZ LIVE APP — the agent's actual app RUNNING
          in the chat (the ONE live preview): README-read auto-run, deps
          auto-installed, start script auto-run, live terminal, edits stream
          in while the agent keeps coding, and a brand-new project (even
          after deleting the old one) AUTO-BOOTS the moment the agent
          pauses. The old v4.7 static mini webview was removed. ── */}
      <div ref={previewWrapRef} className="scroll-mt-28">
        <StackBlitzLivePanel
          onOpenStudio={onNavigate ? () => onNavigate("preview") : undefined}
          collapsible
          collapsed={!previewOpen}
          onToggleCollapsed={() => setPreviewOpen((o) => !o)}
        />
      </div>

      {/* ── v4.0 LIVE TERMINAL (xterm.js) — the agent's whole life streams
          here in real time, and you can run commands in the workspace
          sandbox right from the browser. No reload, ever. ── */}
      <TerminalConsole />

      {/* ── Live transcript ── */}
      <Card className="glass-panel border-primary/20">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Terminal className="h-4.5 w-4.5 text-primary" aria-hidden="true" />
            Agent Transcript
            {displayRun && (
              <span className="ml-auto flex items-center gap-2 text-[11px] font-normal text-muted-foreground">
                <span className="font-mono">
                  {displayRun.mode === "autopilot" ? "AUTOPILOT" : "MANUAL"}
                </span>
                <span
                  className={`rounded-full border px-2 py-0.5 ${
                    displayRun.status === "completed"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                      : displayRun.status === "failed"
                        ? "border-red-500/30 bg-red-500/10 text-red-300"
                        : displayRun.status === "interrupted"
                          ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                          : displayRun.status === "resumed"
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-primary/30 bg-primary/10 text-primary"
                  }`}
                >
                  {displayRun.status.toUpperCase()}
                </span>
              </span>
            )}
            <UsageStrip stats={usageStats} totalTokens={displayRun?.tokensUsed ?? 0} />
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!displayRun ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Bot className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                No run yet. Deploy the agent or engage autopilot — the full reasoning + tool-call
                transcript appears here live, Claude-Code style.
              </p>
              <p className="max-w-md text-[11px] leading-relaxed text-muted-foreground/70">
                21 live public job sources (Greenhouse/Lever ATS boards + Remotive/Jobicy), Gemini
                function calling with fallback, direct tracker writes, MCP server for Claude Code
                at <code className="font-mono text-primary">.mcp.json</code>.
              </p>
            </div>
          ) : (
            <div
              ref={transcriptRef}
              className="max-h-[480px] space-y-3 overflow-y-auto pr-2"
              role="log"
              aria-label="Agent run transcript"
            >
              {steps.map((step) => (
                <StepRow key={`${step.i}-${step.ts}`} step={step} />
              ))}
              {/* v4.1 LIVE THINKING — thinking models (GLM 5.2, Nemotron)
                  stream their chain-of-thought; show the tail live. */}
              {isRunning && reasonTail.length > 0 && (
                <p className="flex items-start gap-2 rounded-lg border border-fuchsia-500/25 bg-fuchsia-500/5 px-3 py-2 font-mono text-[11px] italic leading-relaxed text-fuchsia-300/80">
                  <Brain className="mt-0.5 h-3 w-3 shrink-0 animate-pulse" aria-hidden="true" />
                  <span className="line-clamp-3 break-words">{reasonTail}</span>
                </p>
              )}
              {/* v4.0 LIVE GENERATION — token fragments stream while the model
                  thinks; this is the raw output of the round in progress. */}
              {isRunning && liveText.length > 0 && (
                <pre className="whitespace-pre-wrap break-words rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-primary/90">
                  {liveText}
                </pre>
              )}
              {isRunning && (
                <p className="flex items-center gap-2 pl-2 font-mono text-xs text-primary">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  {liveText.length > 0
                    ? "streaming…"
                    : thinkingSecs > 8
                      ? `thinking… ${thinkingSecs}s (round ${Math.max(1, steps.filter((s) => s.type === "tool_result").length + 1)} underway — files land in the explorer the moment they are written)`
                      : "agent working…"}
                </p>
              )}
            </div>
          )}

          {/* ── v4.2 CHAT-CONTINUE (Copilot-Chat style) — after some
              execution, chat the project into its next iteration:
              full conversation memory + file ledger restored, the
              follow-up lands as a user turn with a live tree refresh. ── */}
          {agentKind === "coding" && displayRun && !isRunning && displayRun.status === "completed" && (
            <div className="mt-3 rounded-lg border border-primary/25 bg-primary/5 p-3">
              {chatQuery.data?.available ? (
                <>
                  <p className="microlabel flex flex-wrap items-center gap-1.5 text-primary/80">
                    <MessageSquare className="h-3 w-3" aria-hidden="true" />
                    CONTINUE THIS PROJECT — chat a change request, full memory restored
                    <span className="ml-auto hidden normal-case tracking-normal text-muted-foreground/70 sm:inline">
                      files · plan · failover chain all carry over
                    </span>
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Textarea
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void sendContinue();
                        }
                      }}
                      placeholder="e.g. add a dark-mode toggle and verify the server still responds · fix the upload validation · add tests for the API…"
                      className="min-h-[44px] flex-1 resize-y font-mono text-[12.5px] leading-relaxed"
                      rows={2}
                      aria-label="Follow-up message for the coding agent (Ctrl+Enter to send)"
                    />
                    <Button onClick={sendContinue} className="gap-1.5 self-end" title="Ctrl+Enter">
                      <Send className="h-4 w-4" aria-hidden="true" />
                      Continue
                    </Button>
                  </div>
                </>
              ) : (
                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <MessageSquare className="h-3 w-3 shrink-0" aria-hidden="true" />
                  Complete a coding run to unlock follow-up chat on this project (v4.2 keeps every
                  finished run&apos;s conversation on disk).
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Run history ── */}
      <Card className="glass-panel border-primary/20">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4.5 w-4.5 text-primary" aria-hidden="true" />
            Run History
            <span className="microlabel ml-auto text-muted-foreground">
              {historyQuery.data?.runs.length ?? 0} RUNS
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="max-h-72">
            {historyQuery.isLoading ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Loading history…</p>
            ) : (historyQuery.data?.runs.length ?? 0) === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Past runs will appear here.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {historyQuery.data?.runs.map((r) => (
                  <li key={r.id}>
                    <div
                      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        runId === r.id
                          ? "border-primary/40 bg-primary/10"
                          : "border-border/60 bg-secondary/20 hover:border-primary/25"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setActiveRun(null);
                          setSelectedRunId(r.id);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <span
                          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded ${
                            r.status === "completed"
                              ? "bg-emerald-500/15 text-emerald-400"
                              : r.status === "failed"
                                ? "bg-red-500/15 text-red-400"
                                : r.status === "interrupted"
                                  ? "bg-amber-500/15 text-amber-400"
                                  : "bg-primary/15 text-primary"
                          }`}
                        >
                          {r.status === "completed" ? (
                            <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : r.status === "failed" ? (
                            <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : r.status === "interrupted" ? (
                            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] text-foreground">
                            {r.goal}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            {timeAgo(r.startedAt)} · {r.stepCount} steps ·{" "}
                            {r.tokensUsed > 0 ? `${r.tokensUsed} tokens · ` : ""}
                            {r.mode}
                            {r.provider ? ` · ${r.provider}` : ""}
                          </span>
                        </span>
                      </button>
                      {r.resumable && r.status !== "running" && (
                        <button
                          type="button"
                          onClick={() => void resumeRun(r.id)}
                          disabled={busy}
                          title={
                            r.status === "interrupted"
                              ? "Continue this crashed run from its disk checkpoint — full memory restored"
                              : "Continue this run from its saved checkpoint — full memory restored"
                          }
                          className="flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-[10.5px] font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-40"
                        >
                          <ChevronRight className="h-3 w-3" aria-hidden="true" />
                          RESUME
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
