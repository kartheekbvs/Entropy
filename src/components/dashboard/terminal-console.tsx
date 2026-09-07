"use client";

// ─────────────────────────────────────────────────────────────
// v4.0 LIVE TERMINAL (xterm.js) — a REAL terminal in the browser.
//
// • The agent's whole life streams here in real time over SSE:
//   rounds, tool calls, results, handoffs, usage, final reports —
//   with ANSI colors per event kind. No page reload, ever.
// • It is also INTERACTIVE: type a command + Enter and it executes
//   in the workspace sandbox (the same guarded shell tool the agent
//   uses — blocklist, relative paths, timeouts, output caps).
// • Reconnects are lossless: every event carries a sequence number;
//   on drop the client reconnects with ?since=<cursor> and the
//   server replays what it missed from the ring buffer.
// ─────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Trash2, Wifi, WifiOff } from "lucide-react";

type LineKind =
  | "sys" | "goal" | "round" | "assistant" | "tool" | "result" | "note"
  | "handoff" | "usage" | "final" | "error" | "user" | "out";

const ANSI: Record<LineKind, string> = {
  sys: "\x1b[38;5;245m",
  goal: "\x1b[1;35m",
  round: "\x1b[38;5;250m",
  assistant: "\x1b[38;5;255m",
  tool: "\x1b[36m",
  result: "\x1b[32m",
  note: "\x1b[38;5;214m",
  handoff: "\x1b[1;35m",
  usage: "\x1b[38;5;213m",
  final: "\x1b[1;32m",
  error: "\x1b[31m",
  user: "\x1b[1;37m",
  out: "",
};

function writeLine(term: Terminal, kind: LineKind, text?: string | null) {
  if (!text) return;
  const safe = String(text).replace(/\r?\n/g, "\r\n");
  term.write(`${ANSI[kind] ?? ""}${safe}\x1b[0m\r\n`);
}

function writePrompt(term: Terminal) {
  term.write("\x1b[1;35mjcc\x1b[0m \x1b[38;5;245mworkspace\x1b[0m \x1b[38;5;213m❯\x1b[0m ");
}

async function execCommand(
  command: string,
  term: Terminal,
  pendingLocal: { current: boolean }
): Promise<void> {
  pendingLocal.current = true; // skip the SSE echo of our own command+output
  try {
    const res = await fetch("/api/agent/terminal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command }),
    });
    const data = (await res.json()) as { ok?: boolean; output?: string; error?: string };
    if (!res.ok || data.error) {
      writeLine(term, "error", `error: ${data.error ?? `HTTP ${res.status}`}`);
    } else {
      writeLine(term, "out", data.output ?? "(no output)");
    }
  } catch (e) {
    writeLine(term, "error", `error: ${(e as Error).message}`);
  } finally {
    pendingLocal.current = false;
    writePrompt(term);
  }
}

export function TerminalConsole() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const term = new Terminal({
      allowTransparency: true,
      convertEol: true,
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Cascadia Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: {
        background: "rgba(7, 19, 13, 0.55)",
        foreground: "#eef7df",
        cursor: "#71c84b",
        cursorAccent: "#07130d",
        selectionBackground: "#71c84b55",
        black: "#10291a",
        red: "#ff5c7a",
        green: "#4ade80",
        yellow: "#f0c66a",
        blue: "#9ee7a0",
        magenta: "#b7df62",
        cyan: "#67e8f9",
        white: "#eef7df",
        brightBlack: "#6f9270",
        brightRed: "#ff8fa3",
        brightGreen: "#a9e46d",
        brightYellow: "#fde68a",
        brightBlue: "#b7df62",
        brightMagenta: "#d4ef9a",
        brightCyan: "#a5f3fc",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (hostRef.current) {
      term.open(hostRef.current);
      try {
        fit.fit();
      } catch {
        /* container not measurable yet — ResizeObserver picks it up */
      }
    }
    termRef.current = term;

    writeLine(term, "sys", "Entropy live terminal v5.0 — agent events stream here in real time.");
    writeLine(
      term,
      "sys",
      "Type a command and press Enter — it runs inside the workspace sandbox (guarded: no absolute paths, no destructive commands). Built-ins: help · status (live online-stack health).",
    );
    writePrompt(term);

    // ── interactive input line ──
    const line = { current: "" };
    const pendingLocal = { current: false };
    term.onData((data) => {
      const t = termRef.current;
      if (!t) return;
      if (data === "\r") {
        const cmd = line.current.trim();
        line.current = "";
        t.write("\r\n");
        if (cmd) void execCommand(cmd, t, pendingLocal);
        else writePrompt(t);
      } else if (data === "\u007f") {
        if (line.current.length > 0) {
          line.current = line.current.slice(0, -1);
          t.write("\b \b");
        }
      } else if (data === "\u0003") {
        line.current = "";
        t.write("^C\r\n");
        writePrompt(t);
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        if (line.current.length < 400) {
          line.current += data;
          t.write(data);
        }
      }
    });

    // ── lossless SSE feed (reconnect replays via ?since=cursor) ──
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const cursor = { seq: 0 };
    const connect = () => {
      try {
        es = new EventSource(`/api/agent/terminal?since=${cursor.seq}`);
      } catch {
        scheduleReconnect();
        return;
      }
      es.onmessage = (ev: MessageEvent<string>) => {
        try {
          const data = JSON.parse(ev.data) as {
            type?: string;
            seq?: number;
            kind?: LineKind;
            text?: string;
          };
          if (typeof data.seq === "number" && data.seq > cursor.seq) cursor.seq = data.seq;
          if (data.type === "hello") {
            setConnected(true);
            return;
          }
          if (data.type !== "line") return;
          // our OWN commands echo locally — skip their bus echo
          if ((data.kind === "user" || data.kind === "out") && pendingLocal.current) return;
          writeLine(term, data.kind ?? "sys", data.text);
        } catch {
          /* malformed event — ignore */
        }
      };
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        es?.close();
        es = null;
        scheduleReconnect();
      };
    };
    const scheduleReconnect = () => {
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 2000);
    };
    connect();

    // ── fit on resize ──
    const onResize = () => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", onResize);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    if (ro && hostRef.current) ro.observe(hostRef.current);

    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  const clear = () => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
    writePrompt(term);
  };

  return (
    <div className="terminal-frame glass-panel overflow-hidden rounded-xl border border-primary/25">
      <div className="flex items-center gap-2 border-b border-primary/20 bg-secondary/30 px-3 py-2">
        <span className="microlabel text-primary">LIVE TERMINAL</span>
        <span className="text-[10px] text-muted-foreground">
          xterm.js · SSE · real-time agent feed + interactive commands
        </span>
        <span
          className={`ml-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] ${
            connected
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : "border-amber-500/40 bg-amber-500/10 text-amber-300"
          }`}
        >
          {connected ? (
            <Wifi className="h-3 w-3" aria-hidden="true" />
          ) : (
            <WifiOff className="h-3 w-3" aria-hidden="true" />
          )}
          {connected ? "streaming" : "reconnecting…"}
        </span>
        <button
          type="button"
          onClick={clear}
          className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-secondary/40 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
          aria-label="Clear terminal"
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" />
          clear
        </button>
      </div>
      <div ref={hostRef} className="h-[340px] w-full px-2 py-1.5" aria-label="Live agent terminal" />
    </div>
  );
}

export default TerminalConsole;
