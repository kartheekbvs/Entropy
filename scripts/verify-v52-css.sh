#!/bin/bash
# v5.2 CSS verification — chat history + transcript must never
# horizontally overflow. Runs against the production server :3000.
set -u
cd /home/z/my-project
PORT=3000

agent-browser set viewport 1440 900 >/dev/null 2>&1
agent-browser open "http://localhost:$PORT" >/dev/null 2>&1
agent-browser wait --load networkidle >/dev/null 2>&1
sleep 2

echo "[1] open the Agent tab (CODING AGENT → Agent Console):"
agent-browser find role tab click --name "CODING AGENT" >/dev/null 2>&1
sleep 2
DD=$(agent-browser snapshot -i 2>/dev/null | rg -o 'button "Agent Console" \[ref=e[0-9]+\]' | rg -o 'e[0-9]+' | head -1)
[ -n "$DD" ] && agent-browser click @"$DD" >/dev/null 2>&1
sleep 2

echo "[2] Run History overflow measurement:"
agent-browser eval "(() => {
  const areas = [...document.querySelectorAll('[data-slot=scroll-area-viewport]')];
  const out = areas.map(v => ({ sw: v.scrollWidth, cw: v.clientWidth, overflow: v.scrollWidth > v.clientWidth + 1 }));
  const body = document.body;
  return JSON.stringify({areas: out, pageOverflows: body.scrollWidth > body.clientWidth + 1, bodySW: body.scrollWidth, bodyCW: body.clientWidth});
})()" 2>&1 | tail -1

echo "[3] transcript (open the latest run with a LONG path goal):"
agent-browser eval "(() => {
  // click the first run row in Run History
  const rows = [...document.querySelectorAll('button')].filter(b => b.textContent && b.textContent.includes('v49-lab'));
  if (rows.length) { rows[0].click(); return 'clicked run with v49-lab goal'; }
  const any = [...document.querySelectorAll('[role=log]')];
  return any.length ? 'transcript present (no v49 run row found — using current)' : 'no transcript';
})()" 2>&1 | tail -1
sleep 3

echo "[4] transcript overflow measurement (long unbreakable tokens):"
agent-browser eval "(() => {
  const log = document.querySelector('[role=log]');
  if (!log) return JSON.stringify({error: 'no transcript'});
  const goal = log.querySelector('p.break-words, div .break-words');
  return JSON.stringify({
    logSW: log.scrollWidth, logCW: log.clientWidth,
    overflows: log.scrollWidth > log.clientWidth + 1,
    goalHasBreakWords: Boolean(goal),
    wrapped: goal ? goal.getBoundingClientRect().height > 20 : null
  });
})()" 2>&1 | tail -1

echo "[5] screenshot:"
agent-browser screenshot scripts/verify-v52-history.png 2>&1 | tail -1

echo "[6] whole-page overflow check at narrow width (mobile-ish 900px):"
agent-browser set viewport 900 900 >/dev/null 2>&1
sleep 1
agent-browser eval "JSON.stringify({pageOverflows: document.body.scrollWidth > document.body.clientWidth + 1})" 2>&1 | tail -1
agent-browser screenshot scripts/verify-v52-narrow.png 2>&1 | tail -1
agent-browser set viewport 1440 900 >/dev/null 2>&1
echo "done"
