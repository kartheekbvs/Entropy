// GET /api/preview/ports — the Replit-style PORTS panel.
//
// The webview previews static agent apps; apps that RUN a server
// (the agent loves shipping "python app.py" backends) show up here
// instead: a server-side TCP probe of the ports agents actually
// use, refreshed live, each chip opening the server in a new tab.
//
// Port list: PREVIEW_PORTS env override, defaults cover the JCC
// stack (3000 app, 8787 OpenRelay, 4597 dashboard) plus the usual
// dev-server suspects agents spawn (Flask 5000, FastAPI 8000,
// Vite 5173, Bun 4321, Ollama 11434, LM Studio 1234).

import { NextResponse } from "next/server";
import net from "node:net";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_PORTS = [3000, 8787, 4597, 5000, 8000, 5173, 4321, 8501, 11434, 1234];

const LABELS: Record<number, string> = {
  3000: "JCC web app",
  8787: "OpenRelay gateway",
  4597: "Agent dashboard",
  5000: "Flask",
  8000: "FastAPI / uvicorn",
  5173: "Vite dev server",
  4321: "Bun serve",
  8501: "Streamlit",
  11434: "Ollama",
  1234: "LM Studio",
};

const PROBE_TIMEOUT_MS = 250;

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    try {
      socket.connect(port, "127.0.0.1");
    } catch {
      done(false);
    }
  });
}

export async function GET() {
  const envList = process.env.PREVIEW_PORTS?.trim();
  let ports: number[];
  if (envList) {
    ports = envList
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  } else {
    ports = DEFAULT_PORTS;
  }
  ports = [...new Set(ports)].sort((a, b) => a - b).slice(0, 24);

  const results = await Promise.all(
    ports.map(async (port) => ({
      port,
      open: await probe(port),
      label: LABELS[port] ?? "dev server",
    }))
  );

  return NextResponse.json(
    {
      ports: results,
      openCount: results.filter((r) => r.open).length,
      probedAt: Date.now(),
    },
    { headers: { "cache-control": "no-store" } }
  );
}
