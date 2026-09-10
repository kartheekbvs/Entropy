// Quick probe: does z-ai-web-dev-sdk work in this sandbox?
import ZAISdk from "z-ai-web-dev-sdk";

async function main() {
  try {
    const zai = await ZAISdk.create();
    console.log("ZAI.create() OK");
    const completion = await zai.chat.completions.create({
      messages: [{ role: "user", content: 'Reply with exactly: {"final":"pong"}' }],
      thinking: { type: "disabled" },
      max_tokens: 200,
    });
    console.log("content:", JSON.stringify(completion.choices?.[0]?.message?.content ?? "").slice(0, 200));
    console.log("usage:", completion.usage?.total_tokens);
  } catch (e) {
    console.log("ZAI FAILED:", (e as Error).message?.slice(0, 300));
  }
}
main();
