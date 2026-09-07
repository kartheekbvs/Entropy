// ─────────────────────────────────────────────────────────────
// test-provider-guard.ts — regression test for the Windows bug:
//   "ERROR init failed: Configuration file not found or invalid.
//    Please create .z-ai-config in your project, home directory, or /etc."
//
// Simulates a fresh user laptop (no GEMINI/OPENAI key, no .z-ai-config)
// and verifies the agent fails with ACTIONABLE instructions instead
// of the raw z-ai SDK error. Run: bun scripts/test-provider-guard.ts
// ─────────────────────────────────────────────────────────────
import {
  generateWithAuto,
  assertProviderConfigured,
  getProviderHealth,
  zaiConfigPath,
  diagnoseRunError,
  translateZaiInitError,
  NoLlmProviderError,
} from "../src/lib/agent/llm";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  }
}
function clearZaiProbeCache() {
  (globalThis as Record<string, unknown>).__agentZaiProbe = undefined;
}

// ── 0. baseline: sandbox z-ai detection still works (no regression) ──
console.log("0) sandbox z-ai detection (no regression)");
delete process.env.AGENT_DISABLE_ZAI;
const zp = await zaiConfigPath();
check("zaiConfigPath() still finds the sandbox config", typeof zp === "string" && zp.length > 0, `got: ${zp}`);

// ── 1. simulate a fresh user machine ─────────────────────────
console.log("1) simulated user laptop (no keys, no .z-ai-config)");
delete process.env.GEMINI_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_MODEL;
delete process.env.OPENAI_MODEL;
delete process.env.OPENAI_BASE_URL;
delete process.env.AGENT_LLM_PROVIDER;
// v3.5 providers — a fresh laptop has none of these either
delete process.env.GROQ_API_KEY;
delete process.env.GROQ_MODEL;
delete process.env.GROQ_API_BASE;
delete process.env.GROQ_BASE_URL;
delete process.env.GLM_API_KEY;
delete process.env.ZAI_GLMAPI_KEY;
delete process.env.ZAI_API_KEY;
delete process.env.Z_AI_API_KEY;
delete process.env.GLM_MODEL;
delete process.env.GLM_API_BASE;
delete process.env.ZAI_API_BASE;
process.env.AGENT_DISABLE_ZAI = "1"; // user laptops have no .z-ai-config
clearZaiProbeCache();
check("zaiConfigPath() returns null (guard active)", (await zaiConfigPath()) === null);

// ── 2. shared preflight ──────────────────────────────────────
console.log("2) assertProviderConfigured() preflight");
const pre = await assertProviderConfigured();
check("preflight fails", pre.ok === false);
check(
  "message carries the fix steps (Groq primary + Gemini fallback)",
  /console\.groq\.com\/keys/.test(pre.message) && /GROQ_API_KEY=your-groq-key/.test(pre.message) && /aistudio\.google\.com/.test(pre.message),
  pre.message.slice(0, 160)
);
check("message points at install.bat / install.sh restart", /install\.(bat|sh)/.test(pre.message));
check(
  "no cryptic SDK error in message",
  !/Configuration file not found|\.z-ai-config in your project/i.test(pre.message)
);

// ── 3. generateWithAuto — the exact "Deploy Agent" code path ─
console.log("3) generateWithAuto() — the Deploy Agent path");
let err: unknown = null;
try {
  await generateWithAuto([{ role: "user", text: "hi" }], [], "system");
} catch (e) {
  err = e;
}
check("throws", err !== null);
check(
  "throws NoLlmProviderError",
  err instanceof NoLlmProviderError || (err as Error)?.name === "NoLlmProviderError",
  String((err as Error)?.name)
);
const emsg = (err as Error)?.message ?? "";
check("message is actionable (contains fix URL)", /aistudio\.google\.com/.test(emsg));
check(
  "the Windows error text is GONE (no 'init failed', no 'Configuration file not found')",
  !/init failed|Configuration file not found/i.test(emsg),
  emsg.slice(0, 120)
);

// ── 4. lazy env reads: key added after boot is picked up ─────
console.log("4) lazy env reads (add key without restart)");
process.env.GEMINI_API_KEY = "AIza-fake-key-lazy-read-test";
const pre2 = await assertProviderConfigured();
check("preflight passes immediately after in-process key set", pre2.ok === true);
const health = await getProviderHealth();
check("health shows gemini configured", health.providers.find((p) => p.name === "gemini")?.configured === true);
check("health.anyConfigured true", health.anyConfigured === true);
delete process.env.GEMINI_API_KEY;

// ── 5. forced-mode guards ────────────────────────────────────
console.log("5) forced provider mode guards");
process.env.AGENT_LLM_PROVIDER = "gemini";
const pre3 = await assertProviderConfigured();
check(
  "forced gemini without key → fails with forced-mode message",
  pre3.ok === false && /forced via AGENT_LLM_PROVIDER/.test(pre3.message),
  pre3.message.slice(0, 120)
);
process.env.AGENT_LLM_PROVIDER = "zai";
const pre4 = await assertProviderConfigured();
check(
  "forced zai without config → fails with actionable message",
  pre4.ok === false && /aistudio\.google\.com/.test(pre4.message) && !/Configuration file not found/i.test(pre4.message)
);
// v3.5: forced groq / glm without keys → the new actionable messages
process.env.AGENT_LLM_PROVIDER = "groq";
const pre4b = await assertProviderConfigured();
check(
  "forced groq without key → fails with console.groq.com hint",
  pre4b.ok === false && /console\.groq\.com\/keys/.test(pre4b.message) && /GROQ_API_KEY/.test(pre4b.message),
  pre4b.message.slice(0, 120)
);
process.env.AGENT_LLM_PROVIDER = "glm";
const pre4c = await assertProviderConfigured();
check(
  "forced glm without key → fails with z.ai hint",
  pre4c.ok === false && /https:\/\/z\.ai/.test(pre4c.message) && /GLM_API_KEY/.test(pre4c.message),
  pre4c.message.slice(0, 120)
);
delete process.env.AGENT_LLM_PROVIDER;

// v3.5: provider health lists groq + glm with the right hints
process.env.GROQ_API_KEY = "gsk-fake-for-health-check";
const healthV35 = await getProviderHealth();
check(
  "health shows groq configured with model detail",
  healthV35.providers.find((p) => p.name === "groq")?.configured === true &&
    /openai\/gpt-oss-120b/.test(String(healthV35.providers.find((p) => p.name === "groq")?.detail))
);
check(
  "health shows glm entry with z.ai hint when unconfigured",
  healthV35.providers.find((p) => p.name === "glm")?.configured === false &&
    /z\.ai/.test(String(healthV35.providers.find((p) => p.name === "glm")?.hint ?? ""))
);
delete process.env.GROQ_API_KEY;

// ── 6. all-providers-fail path (bad key → aggregated diagnosis) ──
console.log("6) all-providers-failed aggregation");
process.env.GEMINI_API_KEY = "AIza-deliberately-invalid";
let err2: unknown = null;
try {
  await generateWithAuto([{ role: "user", text: "hi" }], [], "system");
} catch (e) {
  err2 = e;
}
const emsg2 = (err2 as Error)?.message ?? "";
check("throws NoLlmProviderError", (err2 as Error)?.name === "NoLlmProviderError");
check("diagnosis names the failing provider", /gemini:/i.test(emsg2), emsg2.slice(0, 160));
check("still ends with fix guidance", /aistudio\.google\.com|restart the server/i.test(emsg2));
delete process.env.GEMINI_API_KEY;

// ── 7. THE USER'S REAL SCENARIO: invalid user-created .z-ai-config ────
// The v3.1/v3.2 error told users to "create .z-ai-config" — the user did
// (empty file) and the error looped forever. The probe must validate
// CONTENT, and every surface must translate the cryptic SDK text.
console.log("7) user-created INVALID .z-ai-config (the exact laptop bug)");
import { promises as fs7 } from "node:fs";
import os7 from "node:os";
import path7 from "node:path";
const tmp7 = await fs7.mkdtemp(path7.join(os7.tmpdir(), "zaicfg-"));
const badCfg = path7.join(tmp7, ".z-ai-config");
await fs7.writeFile(badCfg, ""); // EMPTY file — what a user creates
process.env.ZAI_CONFIG_PATH = badCfg;
delete process.env.AGENT_DISABLE_ZAI;
clearZaiProbeCache();
check("empty .z-ai-config is REJECTED by the probe (invalid content)", (await zaiConfigPath()) === null);
const pre7 = await assertProviderConfigured();
check("preflight fails cleanly with empty config file", pre7.ok === false);
check(
  "preflight message is the actionable fix (no 'create .z-ai-config' advice)",
  /aistudio\.google\.com/.test(pre7.message) && !/create \.z-ai-config|Configuration file not found/i.test(pre7.message),
  pre7.message.slice(0, 120)
);
await fs7.writeFile(badCfg, "{ not valid json !!"); // garbage content
clearZaiProbeCache();
check("garbage JSON .z-ai-config is REJECTED too", (await zaiConfigPath()) === null);
await fs7.writeFile(badCfg, JSON.stringify({ baseUrl: "https://x.example" })); // missing apiKey
clearZaiProbeCache();
check("config missing apiKey is REJECTED", (await zaiConfigPath()) === null);
await fs7.writeFile(badCfg, JSON.stringify({ baseUrl: "https://x.example", apiKey: "k" })); // VALID
clearZaiProbeCache();
check("a VALID config is still accepted (no sandbox regression)", (await zaiConfigPath()) === badCfg);
await fs7.rm(tmp7, { recursive: true, force: true });
delete process.env.ZAI_CONFIG_PATH;

// ── 8. error translation — the exact cryptic text the user saw ──
console.log("8) diagnoseRunError() / translateZaiInitError() translation");
const RAW_SDK =
  "init failed: Configuration file not found or invalid. Please create .z-ai-config in your project, home directory, or /etc.";
const translated = translateZaiInitError(
  new Error("Configuration file not found or invalid. Please create .z-ai-config in your project, home directory, or /etc.")
);
check(
  "translateZaiInitError removes the 'create .z-ai-config' advice",
  !/create \.z-ai-config/i.test(translated) && /Gemini key/i.test(translated),
  translated.slice(0, 120)
);
const d1 = diagnoseRunError(new Error(RAW_SDK));
check(
  "diagnoseRunError swaps the exact user error for the actionable message",
  /NO LLM PROVIDER|aistudio\.google\.com/.test(d1) && !/create \.z-ai-config|init failed: Configuration/i.test(d1),
  d1.slice(0, 120)
);
const d2 = diagnoseRunError(new NoLlmProviderError("already friendly"));
check("friendly errors pass through unchanged", d2 === "already friendly");
const d3 = diagnoseRunError(new Error("some unrelated tool failure"));
check("unrelated errors pass through unchanged", d3 === "some unrelated tool failure");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
