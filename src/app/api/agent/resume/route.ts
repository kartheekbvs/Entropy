import { NextRequest, NextResponse } from "next/server";
import { resumeCodingAgentRun } from "@/lib/agent/coding-runner";

export const maxDuration = 60;

// POST /api/agent/resume — v3.7 "fallback the memory": continue a
// crashed / interrupted / LLM-dead coding run from its disk checkpoint
// with the FULL conversation memory restored. The next healthy provider
// picks up exactly where the dead one stopped.
// body: { runId }
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { runId?: string };
    const runId = (body.runId ?? "").toString().trim();
    if (!runId) {
      return NextResponse.json({ error: "runId is required." }, { status: 400 });
    }
    const result = await resumeCodingAgentRun(runId);
    return NextResponse.json(result, { status: result.ok ? 201 : 400 });
  } catch (error) {
    console.error("POST /api/agent/resume failed:", error);
    return NextResponse.json({ error: "Could not resume the run." }, { status: 500 });
  }
}
