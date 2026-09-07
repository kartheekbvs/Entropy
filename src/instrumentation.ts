// Next.js instrumentation hook — runs once at server boot.
// Boots the agent autopilot scheduler so the agent works
// automatically without anyone touching the dashboard.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  try {
    const { startScheduler } = await import("@/lib/agent/scheduler");
    startScheduler();
  } catch (e) {
    console.error("[agent] scheduler failed to start:", e);
  }
}
