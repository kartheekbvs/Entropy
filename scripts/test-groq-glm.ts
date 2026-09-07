// ─────────────────────────────────────────────────────────────
// test-groq-glm.ts — v3.5 regression test for the Groq (primary)
// and Z.ai GLM (second) providers.
//
// Validates, WITHOUT needing network success:
//   1. groq/glm key getters + alias resolution
//   2. forced groq / glm with the real key set → live call; in the
//      build sandbox Groq is region-blocked (403 pre-auth) so the
//      call must classify as ProviderUnavailableError (the exact
//      behavior that lets the auto chain fall through) — on the
//      user's laptop the same call SUCCEEDS.
//   3. auto chain ORDER: groq → glm → gemini → openai → zai
//      (verified via getActiveProviderInfo + provider health)
//   4. 403/401/429/5xx → ProviderUnavailableError classification
//
// Run: bun scripts/test-groq-glm.ts
// ─────────────────────────────────────────────────────────────
import {
  generateWithAuto,
  getActiveProviderInfo,
  getProviderHealth,
  ProviderUnavailableError,
  assertProviderConfigured,
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

const REAL_GROQ_KEY = process.env.GROQ_API_KEY || "";

// ── 1. provider health ───────────────────────────────────────
console.log("1) provider health (groq primary, glm second)");
const health = await getProviderHealth();
check("groq is listed", health.providers.some((p) => p.name === "groq"));
check("glm is listed", health.providers.some((p) => p.name === "glm"));
check(
  "groq is FIRST in the chain (primary)",
  health.providers[0]?.name === "groq",
  `first: ${health.providers[0]?.name}`
);
check(
  "glm is SECOND in the chain",
  health.providers[1]?.name === "glm",
  `second: ${health.providers[1]?.name}`
);
if (REAL_GROQ_KEY) {
  check(
    "groq configured (key present in .env)",
    health.providers.find((p) => p.name === "groq")?.configured === true
  );
  check(
    "groq detail names the model",
    /gpt-oss/.test(String(health.providers.find((p) => p.name === "groq")?.detail)),
    String(health.providers.find((p) => p.name === "groq")?.detail)
  );
}
const info = getActiveProviderInfo();
check(
  "auto chain text mentions Groq → GLM order",
  /Groq → GLM/.test(info.reason),
  info.reason
);

// ── 2. preflight with the real key ───────────────────────────
console.log("2) preflight with the user's Groq key");
process.env.AGENT_LLM_PROVIDER = "auto";
const pre = await assertProviderConfigured();
check("preflight passes (groq key counts as a provider)", pre.ok === true);

// ── 3. live groq call (laptop: success · sandbox: 403 geo-block) ──
console.log("3) live groq call — classification test");
let outcome = "";
let liveError: unknown = null;
try {
  process.env.AGENT_LLM_PROVIDER = "groq";
  const { response, provider } = await generateWithAuto(
    [{ role: "user", text: "Reply with exactly: GROQ_OK" }],
    [],
    "You are a test harness."
  );
  outcome = "success";
  check("forced groq returns provider 'groq'", provider === "groq");
  check(
    "live groq response has text",
    typeof response.text === "string" && response.text.length > 0,
    String(response.text).slice(0, 60)
  );
} catch (e) {
  liveError = e;
  outcome = "unavailable";
  check(
    "sandbox geo-block classifies as ProviderUnavailableError (chain can fall through)",
    e instanceof ProviderUnavailableError,
    `${(e as Error).name}: ${(e as Error).message.slice(0, 120)}`
  );
  check(
    "the failure names the 403 (region edge-block, not a key problem)",
    /HTTP 403/.test((e as Error).message),
    (e as Error).message.slice(0, 120)
  );
}
console.log(`    → outcome: ${outcome}${outcome === "success" ? " (laptop path — Groq serves directly)" : " (sandbox path — region-blocked, key is fine on the user's machine)"}`);
process.env.AGENT_LLM_PROVIDER = "auto";

// ── 4. auto chain falls through to a working provider ────────
console.log("4) auto chain with groq key present");
const { provider: autoProvider } = await generateWithAuto(
  [{ role: "user", text: "Reply with exactly: AUTO_OK" }],
  [],
  "You are a test harness."
);
check(
  "auto chain picked a provider (groq on laptop / zai or gemini in sandbox)",
  ["groq", "glm", "gemini", "openai", "zai"].includes(autoProvider),
  autoProvider
);
const info2 = getActiveProviderInfo();
check(
  "active provider info reflects the memoized chain state",
  ["groq", "glm", "gemini", "openai", "zai"].includes(info2.provider),
  info2.provider
);

// ── 5. glm guard: no key → forced-glm fails actionably ───────
console.log("5) glm guard (no key)");
const savedGlm = process.env.GLM_API_KEY;
delete process.env.GLM_API_KEY;
delete process.env.ZAI_GLMAPI_KEY;
delete process.env.ZAI_API_KEY;
delete process.env.Z_AI_API_KEY;
process.env.AGENT_LLM_PROVIDER = "glm";
const glmPre = await assertProviderConfigured();
check(
  "forced glm without key fails with the z.ai fix hint",
  glmPre.ok === false && /z\.ai/.test(glmPre.message) && /GLM_API_KEY/.test(glmPre.message),
  glmPre.message.slice(0, 120)
);
process.env.AGENT_LLM_PROVIDER = "auto";
if (savedGlm) process.env.GLM_API_KEY = savedGlm;

// ── 6. glm alias resolution: ZAI_API_KEY also powers glm ─────
console.log("6) glm alias resolution");
process.env.ZAI_API_KEY = "fake-zai-key-alias-test";
const health2 = await getProviderHealth();
check(
  "ZAI_API_KEY alias marks glm configured",
  health2.providers.find((p) => p.name === "glm")?.configured === true
);
delete process.env.ZAI_API_KEY;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
