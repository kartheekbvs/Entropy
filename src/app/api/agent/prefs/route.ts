import { NextRequest, NextResponse } from "next/server";
import { getRuntimeLlmPrefs, setRuntimeLlmPrefs, providerChainOrder, openrouterFreeModels, explabsModels, type RuntimeLlmPrefs, type ProviderName } from "@/lib/agent/llm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────
// GET/POST /api/agent/prefs — v4.0/v4.1 runtime LLM preferences.
//
// v4.1 adds the MAIN-MODEL TOGGLE (mainProvider): the console's
// Antigravity-style model selector writes here and the provider
// chain re-orders on the NEXT round without a server restart —
// groq ⚡ / openrouter GLM-5.2 🧠 / nvidia Nemotron 🔬 / … —
// everything not selected becomes an ordered fallback.
// The UI persists prefs in localStorage and re-posts on load,
// so they survive restarts too.
// ─────────────────────────────────────────────────────────────

const EFFORTS = new Set(["low", "medium", "high"]);
const PROVIDERS = new Set<ProviderName>([
  "groq",
  "openrouter",
  "explabs",
  "freechain",
  "nvidia",
  "ollama",
  "glm",
  "gemini",
  "openai",
  "zai",
]);

export async function GET() {
  return NextResponse.json({
    prefs: getRuntimeLlmPrefs(),
    chain: providerChainOrder(),
    env: {
      groqReasoningEffort: process.env.GROQ_REASONING_EFFORT || "low (default)",
      groqModel: process.env.GROQ_MODEL || "openai/gpt-oss-120b (default)",
      openrouterModel: process.env.OPENROUTER_MODEL || "z-ai/glm-5.2 (default)",
      nvidiaModel: process.env.NVIDIA_MODEL || "nvidia/nemotron-3-ultra-550b-a55b (default)",
      // v4.2 — the free relay chain + local ollama defaults
      openrouterFreeModels: openrouterFreeModels(),
      ollamaBase: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1 (default)",
      ollamaModel: process.env.OLLAMA_MODEL || "qwen2.5-coder:7b (default)",
      // v4.3 — the Experiential Labs gateway waterfall
      explabsBase: process.env.EXPLABS_API_BASE || "https://api.experientiallabs.ai/v1 (default)",
      explabsModels: explabsModels(),
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as RuntimeLlmPrefs & { mainProvider?: ProviderName | null };
    const patch: RuntimeLlmPrefs & { mainProvider?: ProviderName | null } = {};

    if (typeof body.reasoningEffort === "string" && EFFORTS.has(body.reasoningEffort)) {
      patch.reasoningEffort = body.reasoningEffort as RuntimeLlmPrefs["reasoningEffort"];
    }
    if (typeof body.model === "string" && body.model.trim()) {
      patch.model = body.model.trim().slice(0, 80);
    } else if (body.model === null) {
      // explicit clear (model: null) — back to the .env/default model
      (patch as { model?: string | null }).model = null;
    }
    // v4.1 — the MAIN-MODEL TOGGLE. Valid names apply (front of the
    // chain); null clears it (back to the default registry order).
    if (typeof body.mainProvider === "string" && PROVIDERS.has(body.mainProvider as ProviderName)) {
      patch.mainProvider = body.mainProvider as ProviderName;
    } else if (body.mainProvider === null) {
      (patch as { mainProvider?: ProviderName | null }).mainProvider = null;
    }
    if (typeof body.streaming === "boolean") {
      patch.streaming = body.streaming;
    }

    const prefs = setRuntimeLlmPrefs(patch);
    return NextResponse.json({ ok: true, prefs, chain: providerChainOrder() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
