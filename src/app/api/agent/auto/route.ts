import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAgentSetting, schedulerStatus } from "@/lib/agent/scheduler";
import { isAgentBusy, activeRunId, startAgentRun } from "@/lib/agent/runner";
import { getActiveProviderInfo } from "@/lib/agent/llm";

const MIN_INTERVAL_MIN = 30;

// GET /api/agent/auto — autopilot status + LLM provider info
export async function GET() {
  try {
    const setting = await getAgentSetting();
    const intervalMinutes = Math.max(MIN_INTERVAL_MIN, setting.intervalMinutes);
    const lastRunAt = setting.lastRunAt?.getTime() ?? null;
    const nextRunAt = setting.autopilotEnabled && lastRunAt
      ? new Date(lastRunAt + intervalMinutes * 60_000).toISOString()
      : null;
    return NextResponse.json({
      autopilotEnabled: setting.autopilotEnabled,
      intervalMinutes,
      goalsTemplate: setting.goalsTemplate,
      lastRunAt: setting.lastRunAt?.toISOString() ?? null,
      nextRunAt,
      busy: isAgentBusy(),
      activeRunId: activeRunId(),
      scheduler: schedulerStatus(),
      llm: getActiveProviderInfo(),
    });
  } catch (error) {
    console.error("GET /api/agent/auto failed:", error);
    return NextResponse.json({ error: "Could not read autopilot status." }, { status: 500 });
  }
}

// POST /api/agent/auto — update autopilot config, or fire a run now
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      enabled?: boolean;
      intervalMinutes?: number;
      goalsTemplate?: string;
      runNow?: boolean;
    };

    const current = await getAgentSetting();
    const data: Record<string, unknown> = {};

    if (typeof body.enabled === "boolean") data.autopilotEnabled = body.enabled;
    if (typeof body.intervalMinutes === "number") {
      data.intervalMinutes = Math.min(1440, Math.max(MIN_INTERVAL_MIN, Math.round(body.intervalMinutes)));
    }
    if (typeof body.goalsTemplate === "string") {
      const t = body.goalsTemplate.trim();
      if (t.length < 10 || t.length > 2000) {
        return NextResponse.json({ error: "Goal template must be 10–2000 characters." }, { status: 400 });
      }
      data.goalsTemplate = t;
    }

    if (Object.keys(data).length > 0) {
      await db.agentSetting.update({ where: { id: "singleton" }, data });
    }

    let triggered: string | null = null;
    if (body.runNow) {
      if (isAgentBusy()) {
        return NextResponse.json(
          { error: "An agent run is already in progress.", activeRunId: activeRunId() },
          { status: 409 }
        );
      }
      const setting = await getAgentSetting();
      triggered = await startAgentRun(setting.goalsTemplate, "autopilot");
    }

    return NextResponse.json({ ok: true, triggered });
  } catch (error) {
    console.error("POST /api/agent/auto failed:", error);
    return NextResponse.json({ error: "Could not update autopilot settings." }, { status: 500 });
  }
}
