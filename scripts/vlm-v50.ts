// v5.0 visual check — confirm the Verdant Farms Cinematic theme on screenshots
import ZAI from "z-ai-web-dev-sdk";
import fs from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log("usage: bun scripts/vlm-v50.ts <png...>");
  process.exit(0);
}

const zai = await ZAI.create();
for (const f of files) {
  const b64 = fs.readFileSync(f).toString("base64");
  try {
    const res = await zai.chat.completions.create({
      model: "glm-5v",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Answer in under 60 words. Describe this web app screenshot: (1) main brand/title text, (2) dominant color theme (is it green/forest/emerald or pink?), (3) do you see a two-button toggle for JOB AGENT and CODING AGENT, (4) any dropdown button with a chevron showing the current section, (5) overall cinematic/glassy quality.",
            },
            { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
          ] as unknown as string, // multimodal payload — SDK types only declare string
        },
      ],
    });
    console.log(`\n=== ${f} ===\n${res.choices[0]?.message?.content ?? "(no content)"}`);
  } catch (e) {
    console.log(`\n=== ${f} === VLM failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
