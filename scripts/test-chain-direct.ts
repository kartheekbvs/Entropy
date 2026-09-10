// Direct chain test — replicates generateWithAuto outside the server
import { generateWithAuto } from "../src/lib/agent/llm";

async function main() {
  const t0 = Date.now();
  try {
    const out = await generateWithAuto(
      [{ role: "user", content: "reply with exactly one word: pong" }],
      [], // tools
      'You are Entropy, an autonomous agent. Reply in strict JSON: {"final":"text"} or {"toolCalls":[…]}'
    );
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`OK in ${dt}s — provider: ${out.provider}`);
    console.log("text:", (out.response as { text?: string }).text?.slice(0, 120));
    if (out.handoff) console.log("handoff:", out.handoff.slice(0, 160));
  } catch (e) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`CHAIN FAILED in ${dt}s —`, (e as Error).name, (e as Error).message?.slice(0, 500));
  }
  process.exit(0);
}
main();
