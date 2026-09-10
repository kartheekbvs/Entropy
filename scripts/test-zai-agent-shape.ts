// Replicate the agent's real zai call shape: system prompt + tools + history
import ZAISdk from "z-ai-web-dev-sdk";

const SYSTEM = `You are Entropy, an autonomous job-hunt agent. Reply in strict JSON protocol: {"toolCalls":[{"id":"c1","name":"tool","args":{}}]} or {"final":"text"}. Available tools decide actions.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "fs_write",
      description: "Write a file into the agent workspace. Provide path and full content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_public_jobs",
      description: "Search public job boards for roles matching a query. Returns role, company, location, url, posted.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string" },
          location: { type: "string" },
          limit: { type: "number" },
        },
        required: ["role"],
      },
    },
  },
];

async function main() {
  const t0 = Date.now();
  try {
    const zai = await ZAISdk.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: 'Goal: reply with exactly one word: pong (JSON protocol)' },
      ],
      // NOTE: app sends tools inside the message content (JSON protocol),
      // but also test native tool passing if supported
      thinking: { type: "disabled" },
      max_tokens: 8192,
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`OK in ${dt}s — content:`, JSON.stringify(completion.choices?.[0]?.message?.content ?? "").slice(0, 200));
    console.log("usage:", JSON.stringify(completion.usage ?? {}));
  } catch (e) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`FAILED in ${dt}s —`, (e as Error).message?.slice(0, 400));
    console.log("name:", (e as Error).name);
  }
}
main();
