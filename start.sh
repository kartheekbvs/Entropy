#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  Entropy — production launcher (macOS / Linux)
#  Works with bun or node. Builds once if needed.
# ─────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")"
mkdir -p logs

echo "═════════════════════════════════════════════════"
echo "  ENTROPY — AI AGENT BY KARTHEEK"
echo "  Production launcher (fast mode, ~130MB RAM)"
echo "═════════════════════════════════════════════════"

# runtime check
RUNNER=""
command -v bun >/dev/null 2>&1 && RUNNER="bun"
[ -z "$RUNNER" ] && command -v node >/dev/null 2>&1 && RUNNER="node"
if [ -z "$RUNNER" ]; then
  echo "[X] Neither bun nor node found. Run install.sh first."
  exit 1
fi
echo "  [OK] runtime: $RUNNER"

# dependencies
if [ ! -d node_modules ]; then
  echo "[!] node_modules missing — installing..."
  bun install || exit 1
fi

# database
if [ ! -f db/custom.db ]; then
  echo "[!] db/custom.db missing — creating schema..."
  mkdir -p db
  DATABASE_URL="file:$(pwd)/db/custom.db" bunx prisma db push --accept-data-loss
fi

# production build
if [ ! -f .next/standalone/server.js ]; then
  echo "[!] No production build yet — building (one time, 1-3 min)..."
  "$RUNNER" run build || exit 1
fi

# OpenRelay
if ! curl -s -m 2 localhost:8787/healthz >/dev/null 2>&1; then
  echo "[i] starting OpenRelay on :8787..."
  ( cd openrelay && nohup node server.js > ../logs/openrelay.log 2>&1 < /dev/null & )
else
  echo "  [OK] OpenRelay already running on :8787"
fi

# start the server (detached so this window closing is survivable)
echo "[i] starting production server on http://localhost:3000 ..."
nohup "$RUNNER" run start > logs/server.log 2>&1 < /dev/null &

# wait for readiness
for i in $(seq 1 30); do
  H=$(curl -s -m 5 localhost:3000/api/agent/health 2>/dev/null)
  echo "$H" | grep -q '"ok":true' && break
  sleep 2
done
if echo "$H" | grep -q '"ok":true'; then
  echo "  [OK] AGENT READY — $(echo "$H" | head -c 200)"
else
  echo "  [!] still starting — open http://localhost:3000 and check the Agent tab."
fi

echo
echo "═════════════════════════════════════════════════"
echo "  App:    http://localhost:3000"
echo "  Relay:  http://127.0.0.1:8787"
echo "  Logs:   logs/server.log"
echo "═════════════════════════════════════════════════"
