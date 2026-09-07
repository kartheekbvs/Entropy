// ─────────────────────────────────────────────────────────────
// EXTERNAL MCP CLIENT (v3.5) — lets the autonomous agent use ANY
// Model Context Protocol server as a tool source. Configuration
// follows the conventions of github/github-mcp-server (cloned and
// studied): stdio servers spawned like
//
//   docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN \
//     ghcr.io/github/github-mcp-server
//
// and remote streamable-HTTP servers like
//
//   https://api.githubcopilot.com/mcp/
//
// mcp.config.json (project root):
// {
//   "mcpServers": {
//     "github": {
//       "enabled": true,
//       "transport": "stdio",
//       "command": "docker",
//       "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
//                "ghcr.io/github/github-mcp-server"],
//       "env": {
//         "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_PERSONAL_ACCESS_TOKEN",
//         "GITHUB_TOOLSETS": "repos,issues,pull_requests",
//         "GITHUB_READ_ONLY": "1"
//       }
//     },
//     "github-remote": {
//       "transport": "http",
//       "url": "https://api.githubcopilot.com/mcp/",
//       "headers": { "Authorization": "Bearer $GITHUB_PERSONAL_ACCESS_TOKEN" }
//     }
//   }
// }
//
//   • "$VAR" / "${VAR}" values expand from process.env. A server
//     whose referenced key is EMPTY is SKIPPED (never spawns docker
//     with a blank PAT) and the transcript explains exactly why.
//   • Discovered tools become agent tools named mcp_<server>_<tool>
//     and flow through the SAME ToolDef registry the coding agent
//     already uses — rate limits, transcript, and result
//     compaction all apply automatically.
//   • AGENT_MCP=0 disables everything. AGENT_MCP_CONFIG=path.json
//     points at another config file.
//   • Handshake: initialize → notifications/initialized →
//     tools/list → tools/call (JSON-RPC 2.0, newline-delimited on
//     stdio; SSE-framed responses supported over HTTP).
// ─────────────────────────────────────────────────────────────

import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonSchemaItems, JsonSchemaParam, ToolDef, ToolParameters } from "./tools";

export interface McpExternalToolsResult {
  tools: ToolDef[];
  cleanup: () => void;
  notes: string[];
}

interface McpServerEntry {
  enabled?: boolean;
  transport?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  maxTools?: number;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerEntry>;
}

interface McpToolRaw {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

interface McpCallResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "job-command-center", version: "3.5.0" };
const INIT_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = () => {
  const v = Number(process.env["AGENT_MCP_CALL_TIMEOUT_MS"]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 120_000;
};
const MAX_SERVERS = 4;
const DEFAULT_MAX_TOOLS = 40;

// ── env expansion ($VAR / ${VAR}) with missing-var detection ──
function expandEnvValue(value: string): { value: string; missing?: string } {
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  let out = value;
  let missing: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const name = m[1] ?? m[2];
    const v = process.env[name] ?? "";
    if (!v && !missing) missing = name;
    out = out.replace(m[0], v);
  }
  return { value: out, missing };
}

function sanitizeToolName(server: string, tool: string): string {
  const raw = `mcp_${server}_${tool}`;
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 64);
}

// ── JSON Schema (MCP) → our Gemini-safe ToolParameters ───────
const TYPE_MAP: Record<string, JsonSchemaParam["type"]> = {
  string: "string",
  number: "number",
  integer: "number",
  boolean: "boolean",
  array: "array",
  object: "object",
};

function normalizeParam(raw: unknown, depth: number): JsonSchemaParam {
  const s = (raw ?? {}) as Record<string, unknown>;
  const rawType = typeof s["type"] === "string" ? (s["type"] as string) : "string";
  const type = TYPE_MAP[rawType] ?? "string";
  const description =
    typeof s["description"] === "string" ? (s["description"] as string).slice(0, 900) : "(no description)";
  const param: JsonSchemaParam = { type, description };
  if (Array.isArray(s["enum"])) {
    const values = (s["enum"] as unknown[]).filter((v): v is string => typeof v === "string");
    if (values.length > 0) param.enum = values.slice(0, 30);
  }
  if (type === "array" && s["items"] != null && depth < 3) {
    const item = normalizeParam(s["items"], depth + 1);
    const items: JsonSchemaItems = {
      // JsonSchemaItems has no "array" item type — arrays of arrays
      // are coerced to object (vanishingly rare in MCP schemas).
      type: item.type === "array" ? "object" : item.type,
      description: item.description,
    };
    if (item.enum) items.enum = item.enum;
    if (item.properties) {
      items.properties = item.properties;
      if (item.required) items.required = item.required;
    }
    param.items = items;
  }
  if (type === "object" && s["properties"] != null && depth < 3) {
    const sub: Record<string, JsonSchemaParam> = {};
    for (const [k, v] of Object.entries(s["properties"] as Record<string, unknown>)) {
      sub[k] = normalizeParam(v, depth + 1);
    }
    if (Object.keys(sub).length > 0) {
      param.properties = sub;
      if (Array.isArray(s["required"])) {
        const req = (s["required"] as unknown[]).filter((r): r is string => typeof r === "string");
        if (req.length > 0) param.required = req;
      }
    }
  }
  return param;
}

function normalizeSchema(input: unknown): ToolParameters {
  const schema = (input ?? {}) as Record<string, unknown>;
  const props = (schema["properties"] ?? {}) as Record<string, unknown>;
  const properties: Record<string, JsonSchemaParam> = {};
  for (const [name, raw] of Object.entries(props)) {
    properties[name] = normalizeParam(raw, 0);
  }
  const required = Array.isArray(schema["required"])
    ? (schema["required"] as unknown[]).filter((r): r is string => typeof r === "string")
    : undefined;
  return { type: "object", properties, ...(required?.length ? { required } : {}) };
}

function renderCallResult(res: unknown): unknown {
  const r = (res ?? {}) as McpCallResult;
  const text = (r.content ?? [])
    .filter((c) => typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
  if (r.isError) return { error: `MCP tool error: ${text || "(no detail)"}` };
  if (r.structuredContent !== undefined) return r.structuredContent;
  return text || "(empty result)";
}

// ── stdio JSON-RPC peer (newline-delimited) ──────────────────
interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class StdioRpcPeer {
  private child: ChildProcess;
  private pending = new Map<number, PendingEntry>();
  private nextId = 1;
  private buffer = "";
  private closed = false;

  constructor(
    private label: string,
    command: string,
    args: string[],
    env: Record<string, string>,
    cwd?: string
  ) {
    this.child = spawn(command, args, {
      env: { ...process.env, ...env },
      ...(cwd ? { cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
      // v4.0: Windows cannot spawn npx/npx.cmd directly without a
      // shell — MCP stdio servers configured via npx (github) need
      // this to start on the user's laptop.
      ...(process.platform === "win32" ? { shell: true } : {}),
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      const line = chunk.trim().slice(0, 200);
      if (line) console.warn(`[mcp-client:${this.label}] ${line}`);
    });
    this.child.on("exit", () => this.failAll(new Error("MCP server exited")));
    this.child.on("error", (e: Error) => this.failAll(e));
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // not JSON-RPC — ignore
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: Record<string, unknown>) {
    const id = msg["id"];
    // server → client REQUEST (e.g. ping) → answer so it never blocks
    if (typeof msg["method"] === "string" && id !== undefined) {
      this.write({
        jsonrpc: "2.0",
        id,
        ...(msg["method"] === "ping" ? { result: {} } : { error: { code: -32601, message: `client does not support ${msg["method"]}` } }),
      });
      return;
    }
    if (typeof msg["method"] === "string") return; // notification — ignore
    if (id !== undefined && this.pending.has(id as number)) {
      const entry = this.pending.get(id as number)!;
      clearTimeout(entry.timer);
      this.pending.delete(id as number);
      const err = msg["error"] as { message?: string } | undefined;
      if (err) entry.reject(new Error(String(err.message ?? "rpc error")));
      else entry.resolve(msg["result"]);
    }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(obj: unknown) {
    if (this.closed) return;
    try {
      this.child.stdin?.write(`${JSON.stringify(obj)}\n`);
    } catch {
      /* server dying — pending calls fail via exit handler */
    }
  }

  private failAll(e: Error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(e);
    }
    this.pending.clear();
  }

  kill() {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("client shutdown"));
    try {
      this.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const t = setTimeout(() => {
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 3_000);
    t.unref?.();
  }
}

// ── streamable-HTTP JSON-RPC (SSE-framed responses supported) ─
async function httpRpc(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown> & { id?: number },
  timeoutMs: number,
  sessionId?: string
): Promise<{ result?: unknown; sessionId?: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`network: ${(e as Error).message}`);
  }
  if (res.status === 202) return {}; // notification accepted, no body
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const sid = res.headers.get("mcp-session-id") ?? undefined;
  const contentType = res.headers.get("content-type") ?? "";
  let payload: Record<string, unknown> | null = null;
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    for (const block of text.split(/\n\s*\n/)) {
      const dataLines = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (dataLines.length === 0) continue;
      try {
        const parsed = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
        if (parsed["id"] === body.id) {
          payload = parsed;
          break;
        }
      } catch {
        /* skip non-JSON block */
      }
    }
    if (!payload) throw new Error("no JSON-RPC response found in SSE stream");
  } else {
    payload = (await res.json()) as Record<string, unknown>;
  }
  const err = payload["error"] as { message?: string } | undefined;
  if (err) throw new Error(String(err.message ?? "rpc error"));
  return { result: payload["result"], sessionId: sid };
}

// ── wrap raw MCP tools as ToolDefs ───────────────────────────
function wrapTools(
  server: string,
  rawTools: McpToolRaw[],
  makeExecute: (originalName: string) => (args: Record<string, unknown>) => Promise<unknown>
): ToolDef[] {
  const seen = new Set<string>();
  const out: ToolDef[] = [];
  for (const t of rawTools) {
    const originalName = typeof t.name === "string" ? t.name : "";
    if (!originalName) continue;
    const name = sanitizeToolName(server, originalName);
    if (seen.has(name)) continue;
    seen.add(name);
    const description =
      (typeof t.description === "string" ? t.description : "(no description)").slice(0, 900);
    out.push({
      name,
      description: `[mcp:${server}] ${description}`,
      parameters: normalizeSchema(t.inputSchema),
      execute: makeExecute(originalName),
    });
  }
  return out;
}

// ── main loader ──────────────────────────────────────────────
export async function loadExternalMcpTools(): Promise<McpExternalToolsResult> {
  const tools: ToolDef[] = [];
  const notes: string[] = [];
  const cleanups: Array<() => void> = [];
  const cleanup = () => cleanups.forEach((c) => c());

  if (process.env["AGENT_MCP"] === "0") {
    return { tools, cleanup, notes: ["External MCP tools disabled via AGENT_MCP=0."] };
  }

  const configPath =
    process.env["AGENT_MCP_CONFIG"] || path.join(process.cwd(), "mcp.config.json");
  let config: McpConfigFile;
  try {
    const raw = await fs.readFile(configPath, "utf8");
    config = JSON.parse(raw) as McpConfigFile;
  } catch {
    // No config file → zero external tools. Normal, silent.
    return { tools, cleanup, notes };
  }

  for (const [name, entry] of Object.entries(config.mcpServers ?? {}).slice(0, MAX_SERVERS)) {
    if (entry.enabled === false) {
      notes.push(`MCP server "${name}" disabled in mcp.config.json — set "enabled": true to activate it.`);
      continue;
    }

    // ── HTTP transport ────────────────────────────────────────
    if (entry.transport === "http" || (!entry.transport && entry.url)) {
      if (!entry.url) {
        notes.push(`MCP server "${name}" (http) has no url — skipped.`);
        continue;
      }
      const headers: Record<string, string> = {};
      let missing: string | undefined;
      for (const [k, v] of Object.entries(entry.headers ?? {})) {
        const expanded = expandEnvValue(v);
        headers[k] = expanded.value;
        if (expanded.missing && !missing) missing = expanded.missing;
      }
      if (missing) {
        notes.push(`MCP server "${name}" (http) skipped: set ${missing} in .env — it is referenced by mcp.config.json but empty.`);
        continue;
      }
      let nextId = 1;
      let sessionId: string | undefined;
      try {
        const init = await httpRpc(
          entry.url,
          headers,
          {
            jsonrpc: "2.0",
            id: nextId++,
            method: "initialize",
            params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
          },
          INIT_TIMEOUT_MS
        );
        sessionId = init.sessionId;
        await httpRpc(
          entry.url,
          headers,
          { jsonrpc: "2.0", method: "notifications/initialized" },
          10_000,
          sessionId
        ).catch(() => undefined);
        const list = await httpRpc(
          entry.url,
          headers,
          { jsonrpc: "2.0", id: nextId++, method: "tools/list" },
          LIST_TIMEOUT_MS,
          sessionId
        );
        const serverTools = ((list.result as { tools?: McpToolRaw[] } | undefined)?.tools ?? []);
        const wrapped = wrapTools(name, serverTools, (originalName) => async (args) => {
          const res = await httpRpc(
            entry.url!,
            headers,
            { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: originalName, arguments: args } },
            CALL_TIMEOUT_MS(),
            sessionId
          );
          return renderCallResult(res.result);
        });
        tools.push(...wrapped.slice(0, entry.maxTools ?? DEFAULT_MAX_TOOLS));
        notes.push(`MCP "${name}" connected over HTTP (${entry.url}): ${wrapped.length} tools available.`);
      } catch (e) {
        notes.push(`MCP server "${name}" (http) failed: ${(e as Error).message} — its tools were skipped.`);
      }
      continue;
    }

    // ── stdio transport ───────────────────────────────────────
    if (!entry.command) {
      notes.push(`MCP server "${name}" has no command and no url — skipped.`);
      continue;
    }
    const env: Record<string, string> = {};
    let missing: string | undefined;
    for (const [k, v] of Object.entries(entry.env ?? {})) {
      const expanded = expandEnvValue(v);
      env[k] = expanded.value;
      if (expanded.missing && !missing) missing = expanded.missing;
    }
    if (missing) {
      notes.push(
        `MCP server "${name}" skipped: set ${missing} in .env — it is referenced by mcp.config.json but empty (never spawn a server with a blank token).`
      );
      continue;
    }
    let peer: StdioRpcPeer;
    try {
      peer = new StdioRpcPeer(name, entry.command, entry.args ?? [], env, entry.cwd);
    } catch (e) {
      notes.push(`MCP server "${name}" failed to spawn "${entry.command}": ${(e as Error).message} — is it installed and on PATH?`);
      continue;
    }
    try {
      const initResult = (await peer.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
        INIT_TIMEOUT_MS
      )) as { serverInfo?: { name?: string; version?: string } } | null;
      peer.notify("notifications/initialized", {});
      const listResult = (await peer.request("tools/list", {}, LIST_TIMEOUT_MS)) as { tools?: McpToolRaw[] } | null;
      const serverTools = listResult?.tools ?? [];
      const wrapped = wrapTools(name, serverTools, (originalName) => async (args) => {
        const res = await peer.request(
          "tools/call",
          { name: originalName, arguments: args },
          CALL_TIMEOUT_MS()
        );
        return renderCallResult(res);
      });
      tools.push(...wrapped.slice(0, entry.maxTools ?? DEFAULT_MAX_TOOLS));
      cleanups.push(() => peer.kill());
      const serverLabel = initResult?.serverInfo?.name
        ? `${initResult.serverInfo.name}${initResult.serverInfo.version ? ` ${initResult.serverInfo.version}` : ""}`
        : "unknown server";
      notes.push(`MCP "${name}" connected via stdio (${serverLabel}): ${wrapped.length} tools available.`);
    } catch (e) {
      peer.kill();
      notes.push(`MCP server "${name}" handshake failed: ${(e as Error).message} — its tools were skipped.`);
    }
  }

  return { tools, cleanup, notes };
}
