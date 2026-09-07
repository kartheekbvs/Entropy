// ─────────────────────────────────────────────────────────────
// Autopilot scheduler — fires agent runs on a fixed cadence.
// Started automatically at server boot via src/instrumentation.ts.
// Cadence is read from the AgentSetting singleton row, so the UI
// can change it live. Minimum interval: 30 minutes.
// ─────────────────────────────────────────────────────────────

import { db } from "@/lib/db";
import { isAgentBusy, startAgentRun } from "./runner";

const MIN_INTERVAL_MINUTES = 30;
const TICK_MS = 60_000;

// Timer lives on globalThis: Next dev keeps instrumentation and route
// modules in separate graphs — shared state must survive module duplication.
const g = globalThis as unknown as {
  __agentSchedulerTimer?: ReturnType<typeof setInterval> | null;
  __agentSchedulerStarted?: boolean;
};

export async function getAgentSetting() {
  let s = await db.agentSetting.findUnique({ where: { id: "singleton" } });
  if (!s) {
    s = await db.agentSetting.create({ data: { id: "singleton" } });
  }
  return s;
}

async function tick(): Promise<void> {
  const setting = await getAgentSetting();
  if (!setting.autopilotEnabled) return;
  if (isAgentBusy()) return; // try again next tick — don't skip the cadence

  const intervalMs = Math.max(MIN_INTERVAL_MINUTES, setting.intervalMinutes) * 60_000;
  const last = setting.lastRunAt?.getTime() ?? 0;
  if (Date.now() - last < intervalMs) return;

  // Mark immediately so parallel ticks can't double-fire
  await db.agentSetting.update({
    where: { id: "singleton" },
    data: { lastRunAt: new Date() },
  });
  console.log(
    `[agent] autopilot firing scheduled run (every ${Math.max(MIN_INTERVAL_MINUTES, setting.intervalMinutes)} min)`
  );
  await startAgentRun(setting.goalsTemplate, "autopilot");
}

export function startScheduler(): void {
  if (g.__agentSchedulerStarted) return;
  g.__agentSchedulerStarted = true;
  g.__agentSchedulerTimer = setInterval(() => {
    void tick().catch((e) => console.error("[agent] scheduler tick failed:", e));
  }, TICK_MS);
  g.__agentSchedulerTimer.unref?.();
  console.log("[agent] autopilot scheduler online (checks every 60s)");
}

export function schedulerStatus(): { running: boolean; minIntervalMinutes: number } {
  return { running: Boolean(g.__agentSchedulerTimer), minIntervalMinutes: MIN_INTERVAL_MINUTES };
}
