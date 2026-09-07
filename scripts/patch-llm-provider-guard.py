#!/usr/bin/env python3
"""Finish the llm.ts provider-guard patch:
- cached .z-ai-config probe + zaiAvailable()
- buildNoProviderMessage() + assertProviderConfigured()
- getProviderHealth on lazy getters
Idempotent: safe to re-run.
"""
import sys, re

PATH = "/home/z/my-project/src/lib/agent/llm.ts"
src = open(PATH, encoding="utf-8").read()
orig = src
changed = []

def sub_once(desc, old, new, count=1):
    global src
    if old in src:
        src = src.replace(old, new, count)
        changed.append(f"APPLIED: {desc}")
    elif new in src:
        changed.append(f"ALREADY: {desc}")
    else:
        changed.append(f"!! NOT FOUND: {desc}")
        return False
    return True

ok = True

# ── 1. zaiConfigPath → cached probe + zaiAvailable ──────────────
old_probe = '''async function zaiConfigPath(): Promise<string | null> {
  const { promises: fsp } = await import("node:fs");
  const os = await import("node:os");
  const candidates = [
    "./.z-ai-config",
    `${os.homedir()}/.z-ai-config`,
    "/etc/.z-ai-config",
  ];
  for (const p of candidates) {
    try {
      await fsp.access(p);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}'''

new_probe = '''// ── .z-ai-config existence probe (cached 60s on globalThis) ──
// The z-ai SDK only works where a .z-ai-config file exists (the build
// sandbox). Probing BEFORE calling ZAI.create() means a normal user's
// machine never hits the SDK's cryptic init error. Env overrides:
//   AGENT_DISABLE_ZAI=1  → force-off (tests / strict setups)
//   ZAI_CONFIG_PATH=…    → point at a custom config location
const ZAI_PROBE_KEY = "__agentZaiProbe";
const ZAI_PROBE_TTL_MS = 60 * 1000;

export async function zaiConfigPath(): Promise<string | null> {
  if (env("AGENT_DISABLE_ZAI") === "1") return null;
  const { promises: fsp } = await import("node:fs");
  const custom = env("ZAI_CONFIG_PATH");
  if (custom) {
    try {
      await fsp.access(custom);
      return custom;
    } catch {
      return null;
    }
  }
  const g = globalThis as Record<string, unknown>;
  const cached = g[ZAI_PROBE_KEY] as { path: string | null; at: number } | undefined;
  if (cached && Date.now() - cached.at < ZAI_PROBE_TTL_MS) return cached.path;
  const os = await import("node:os");
  const candidates = [
    "./.z-ai-config",
    `${os.homedir()}/.z-ai-config`,
    "/etc/.z-ai-config",
  ];
  let found: string | null = null;
  for (const p of candidates) {
    try {
      await fsp.access(p);
      found = p;
      break;
    } catch {
      /* keep looking */
    }
  }
  g[ZAI_PROBE_KEY] = { path: found, at: Date.now() };
  return found;
}

async function zaiAvailable(): Promise<boolean> {
  return (await zaiConfigPath()) !== null;
}

/**
 * The single actionable message shown whenever NO usable provider exists.
 * Used by generateWithAuto, both runner preflights, /api/agent/health and
 * the MCP agent_health tool — one voice everywhere.
 */
export function buildNoProviderMessage(
  forced: "gemini" | "openai" | null,
  failures?: string[]
): string {
  const lines: string[] = [];
  if (failures && failures.length > 0) {
    lines.push("NO LLM PROVIDER RESPONDED — every configured provider failed:");
    for (const f of failures) lines.push(`  • ${f}`);
    lines.push("");
    lines.push("Check the key(s) for typos, quota, and billing. Common causes: pasted the wrong key, free-tier quota exhausted, or no internet.");
  } else {
    lines.push("NO LLM PROVIDER CONFIGURED — the agent cannot think without at least one API key.");
  }
  lines.push("");
  if (forced === "openai") {
    lines.push("Fix (openai is forced via AGENT_LLM_PROVIDER): set OPENAI_API_KEY in the .env file inside the project folder, then restart the server.");
  } else if (forced === "gemini") {
    lines.push("Fix (gemini is forced via AGENT_LLM_PROVIDER): set GEMINI_API_KEY in the .env file inside the project folder, then restart the server.");
  } else {
    lines.push("HOW TO FIX (2 minutes, free):");
    lines.push("  1. Get a FREE Gemini key: https://aistudio.google.com/apikey → 'Create API key' → copy it");
    lines.push("  2. Open the .env file in the project folder and set (create the line if missing):");
    lines.push("       GEMINI_API_KEY=your-key-here");
    lines.push("  3. Restart the server (close this window and run install.bat / install.sh again — your keys are KEPT)");
    lines.push("  4. Click 'Recheck' on the Agent tab preflight card, then re-run the goal");
    lines.push("");
    lines.push("Optional second provider: OPENAI_API_KEY=sk-proj-… (any OpenAI-compatible key; set OPENAI_BASE_URL for z.ai/DeepSeek/Groq/OpenRouter).");
  }
  lines.push("");
  lines.push("Note: the z-ai SDK fallback only works in the original build sandbox (its .z-ai-config file is not distributed) — on your own machine use GEMINI_API_KEY or OPENAI_API_KEY in .env.");
  lines.push("The dashboard itself (tracker, feeds, JD match) works without any key — only the autonomous agent needs one.");
  return lines.join("\\n");
}

/** Shared runner preflight: fail FAST + actionable before burning a round. */
export async function assertProviderConfigured(): Promise<{
  ok: boolean;
  message: string;
}> {
  const mode = env("AGENT_LLM_PROVIDER") || "auto";
  if (mode === "gemini" && !geminiKey()) {
    return { ok: false, message: buildNoProviderMessage("gemini") };
  }
  if (mode === "openai" && !openaiKey()) {
    return { ok: false, message: buildNoProviderMessage("openai") };
  }
  if (mode === "zai" && !(await zaiAvailable())) {
    return { ok: false, message: buildNoProviderMessage(null) };
  }
  if (mode === "auto") {
    const hasAny = geminiKey() || openaiKey() || (await zaiAvailable());
    if (!hasAny) return { ok: false, message: buildNoProviderMessage(null) };
  }
  return { ok: true, message: "" };
}'''

ok = sub_once("cached zaiConfigPath + zaiAvailable + buildNoProviderMessage + assertProviderConfigured", old_probe, new_probe) and ok

# ── 2. getProviderHealth lazy getters ──────────────────────────
old_h1 = '''  providers.push(
    GEMINI_KEY
      ? { name: "gemini", configured: true, detail: `GEMINI_API_KEY set (model: ${GEMINI_MODEL})` }'''
new_h1 = '''  providers.push(
    geminiKey()
      ? { name: "gemini", configured: true, detail: `GEMINI_API_KEY set (model: ${geminiModel()})` }'''
ok = sub_once("health gemini lazy getter", old_h1, new_h1) and ok

old_h2 = '''  providers.push(
    OPENAI_KEY
      ? { name: "openai", configured: true, detail: `OPENAI_API_KEY set (model: ${OPENAI_MODEL}, base: ${OPENAI_BASE})` }'''
new_h2 = '''  providers.push(
    openaiKey()
      ? { name: "openai", configured: true, detail: `OPENAI_API_KEY set (model: ${openaiModel()}, base: ${openaiBase()})` }'''
ok = sub_once("health openai lazy getter", old_h2, new_h2) and ok

# ── 3. verify no stale references remain ───────────────────────
for stale in ["GEMINI_KEY", "OPENAI_KEY", "OPENAI_MODEL", "OPENAI_BASE", "GEMINI_MODEL"]:
    if re.search(rf"\b{stale}\b", src):
        changed.append(f"!! STALE REFERENCE REMAINS: {stale}")
        ok = False

if src != orig:
    open(PATH, "w", encoding="utf-8").write(src)

print("\n".join(changed))
sys.exit(0 if ok else 1)
