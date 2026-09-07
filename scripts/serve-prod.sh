#!/bin/bash
# ─────────────────────────────────────────────────────────────────
#  Entropy — production launcher (idempotent, detached, OOM-proof)
#
#  Runs the FULL runtime stack:
#    1. OpenRelay  — LLM provider relay gateway      (127.0.0.1:8787)
#    2. Next.js    — standalone production server    (0.0.0.0:3000)
#
#  Why standalone? The dev-mode next-server balloons to ~1.95GB RSS
#  and gets OOM-killed (verified in dmesg). The production build
#  boots in ~130ms at ~131MB RSS — 15x leaner, OOM-proof.
#
#  Everything is spawned with `nohup setsid` so the processes fully
#  detach from this shell's process group and survive tool-call
#  boundaries. Safe to re-run any time — it heals/refreshes the stack.
#
#  Usage:  bash scripts/serve-prod.sh [fast]
#          `fast` skips the long readiness soak when re-checking.
# ─────────────────────────────────────────────────────────────────
set -u
cd /home/z/my-project
mkdir -p logs

SOAK="${1:-}"

# ── 1. Load environment (provider keys + DATABASE_URL) ──────────
if [ -f .env ]; then
  set -a; # shellcheck disable=SC1091
  source .env; set +a
fi

log() { echo "[serve-prod] $*"; }

# ── 2. Stop anything stale on our ports (heals zombie states) ───
stop_port() {
  local port="$1" pid
  pid=$(ss -tlnp 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" {print $NF}' \
        | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u | head -1)
  if [ -n "$pid" ]; then
    log "stopping pid $pid on :$port"
    kill "$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$pid" 2>/dev/null
  fi
}

stop_port 3000
stop_port 8787
sleep 1

# ── 3. Start OpenRelay (detached) ───────────────────────────────
if curl -s -m 2 localhost:8787/healthz >/dev/null 2>&1; then
  log "OpenRelay already healthy on :8787"
else
  log "starting OpenRelay on :8787 ..."
  ( cd openrelay && nohup setsid node server.js \
      > ../logs/openrelay.log 2>&1 < /dev/null & )
  disown -a 2>/dev/null || true
fi

# wait for OpenRelay health (max 20s)
OR_OK=0
for i in $(seq 1 20); do
  if curl -s -m 2 localhost:8787/healthz >/dev/null 2>&1; then OR_OK=1; break; fi
  sleep 1
done
if [ "$OR_OK" = "1" ]; then
  log "OpenRelay healthy ✓"
else
  log "WARN: OpenRelay not healthy yet — continuing (agent chat degrades, app still serves)"
fi

# ── 4. Start Next.js production standalone (detached) ───────────
log "starting Next.js production server on :3000 ..."
nohup setsid env PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production \
  node .next/standalone/server.js > logs/next-prod.log 2>&1 < /dev/null &
disown

# wait for readiness (max 40s)
SRV_OK=0
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 3 localhost:3000 2>/dev/null)
  [ "$code" = "200" ] && SRV_OK=1 && break
  sleep 1
done
code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 localhost:3000 2>/dev/null)
if [ "$SRV_OK" != "1" ]; then
  log "FAILED: server did not become ready (HTTP $code)"
  log "--- last 25 lines of logs/next-prod.log ---"
  tail -25 logs/next-prod.log
  exit 1
fi
log "Next.js production server ready: HTTP $code ✓"

# ── 5. Route sweep (the ones the UI polls on load) ──────────────
log "API route sweep:"
FAIL=0
for r in api/applications api/contacts api/agent/runs api/agent/auto \
         api/agent/health api/workspace/tree api/preview/stackblitz; do
  c=$(curl -s -o /dev/null -w "%{http_code}" -m 20 "localhost:3000/$r")
  mark="✓"; [ "$c" = "200" ] || mark="✗"; [ "$c" = "200" ] || FAIL=1
  printf "   /%-28s %s %s\n" "$r" "$c" "$mark"
done

# OpenRelay models endpoint (provider chain live)
if curl -s -m 8 localhost:8787/v1/models | grep -q '"id"'; then
  log "OpenRelay /v1/models: provider chain LIVE ✓"
else
  log "OpenRelay /v1/models: no models listed (check logs/openrelay.log)"
fi

# ── 6. Persistence soak: confirm processes detached & alive ─────
if [ "$SOAK" != "fast" ]; then
  log "soak: sleeping 8s then re-checking liveness ..."
  sleep 8
  P3000=$(ss -tlnp 2>/dev/null | awk '$4 ~ /:3000$/ {print $NF}' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | head -1)
  P8787=$(ss -tlnp 2>/dev/null | awk '$4 ~ /:8787$/ {print $NF}' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | head -1)
  c2=$(curl -s -o /dev/null -w "%{http_code}" -m 5 localhost:3000 2>/dev/null)
  RSS=$( [ -n "$P3000" ] && ps -o rss= -p "$P3000" 2>/dev/null | awk '{printf "%.0fMB", $1/1024}' )
  log "after soak :3000 pid=$P3000 (RSS $RSS) HTTP=$c2 · :8787 pid=$P8787"
  [ "$c2" = "200" ] || { log "server died during soak"; exit 1; }
fi

log "STACK IS UP — app: http://localhost:3000 · relay: http://127.0.0.1:8787"
[ "$FAIL" = "0" ] && exit 0 || exit 2
