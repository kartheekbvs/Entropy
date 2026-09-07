#!/bin/bash
# v5.1 full-stack browser verification — runs INSIDE one tool call because the
# sandbox reaps background servers at call boundaries.
# Boots the PRODUCTION standalone server (not dev — 15x less RAM, OOM-proof),
# sweeps every component with agent-browser, captures screenshots + errors,
# then tears the server down.
set -u
cd /home/z/my-project

PORT=3000
LOG=logs/next-prod.log
echo "[1/9] booting production server (standalone)..."
node .next/standalone/server.js > "$LOG" 2>&1 &
SRV=$!
disown

# wait for readiness (max 40s)
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 3 localhost:$PORT 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 1
done
code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 localhost:$PORT)
echo "[2/9] server ready: HTTP $code (pid $SRV)"
if [ "$code" != "200" ]; then
  echo "SERVER FAILED"; tail -20 "$LOG"; kill $SRV 2>/dev/null; exit 1
fi

# API route sweep on production server
echo "[3/9] API route sweep:"
for r in "api/applications" "api/contacts" "api/agent/run" "api/agent/auto" "api/preview/ports" "api/preview/stackblitz"; do
  c=$(curl -s -o /dev/null -w "%{http_code}" -m 15 "localhost:$PORT/$r")
  echo "   /$r → $c"
done

echo "[4/9] browser sweep..."
agent-browser set viewport 1440 900 >/dev/null 2>&1
agent-browser open "http://localhost:$PORT" 2>&1 | tail -1
agent-browser wait --load networkidle >/dev/null 2>&1
sleep 3

echo "[5/9] theme token check (bright palette):"
agent-browser eval "JSON.stringify({primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(), border: getComputedStyle(document.documentElement).getPropertyValue('--border').trim(), accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), mutedFg: getComputedStyle(document.documentElement).getPropertyValue('--muted-foreground').trim()})" 2>&1 | tail -1
agent-browser screenshot scripts/verify-v51-prod-home.png 2>&1 | tail -1

echo "[6/9] JOB AGENT dropdown → Tracker:"
agent-browser snapshot -i 2>/dev/null | rg 'button "Command Center"' | head -1
agent-browser find role button click --name "Command Center" >/dev/null 2>&1
sleep 1
# click Tracker menu item
agent-browser snapshot -i 2>/dev/null | rg 'menuitem "Tracker' | head -1
TR_REF=$(agent-browser snapshot -i 2>/dev/null | rg -o 'menuitem "Tracker[^"]*" \[ref=e[0-9]+\]' | rg -o 'e[0-9]+' | head -1)
[ -n "$TR_REF" ] && agent-browser click @"$TR_REF" >/dev/null 2>&1
agent-browser wait --text "Application pipeline" >/dev/null 2>&1 && echo "   tracker rendered ✓"
agent-browser screenshot scripts/verify-v51-prod-tracker.png 2>&1 | tail -1

echo "[7/9] CODING AGENT mode + Live App Preview dropdown:"
agent-browser find role tab click --name "CODING AGENT" >/dev/null 2>&1
sleep 2
DD_REF=$(agent-browser snapshot -i 2>/dev/null | rg -o 'button "Agent Console" \[ref=e[0-9]+\]' | rg -o 'e[0-9]+' | head -1)
[ -n "$DD_REF" ] && agent-browser click @"$DD_REF" >/dev/null 2>&1
sleep 1
LP_REF=$(agent-browser snapshot -i 2>/dev/null | rg -o 'menuitem "Live App Preview[^"]*" \[ref=e[0-9]+\]' | rg -o 'e[0-9]+' | head -1)
[ -n "$LP_REF" ] && agent-browser click @"$LP_REF" >/dev/null 2>&1
sleep 12
agent-browser eval "JSON.stringify({iframes: document.querySelectorAll('iframe').length, phase: (document.body.textContent.match(/BOOTING|RUNNING|LIVE|FAILED|NEW APP/i)||['none'])[0], scrollY: window.scrollY})" 2>&1 | tail -1
agent-browser screenshot scripts/verify-v51-prod-stackblitz.png 2>&1 | tail -1

echo "[8/9] error audit:"
ERRS=$(agent-browser errors 2>/dev/null | rg -v "info|HMR|Fast Refresh|React DevTools" | head -5)
[ -z "$ERRS" ] && echo "   0 page errors ✓" || echo "$ERRS"
CONS=$(agent-browser console 2>/dev/null | rg -i "error" | rg -v "agent|ERR_EMPTY" | head -5)
[ -z "$CONS" ] && echo "   0 console errors ✓" || echo "$CONS"

echo "[9/9] teardown"
agent-browser close >/dev/null 2>&1
kill $SRV 2>/dev/null
sleep 1
echo "DONE v5.1 production browser sweep"
