#!/usr/bin/env bash
# Package the Job Command Center agent suite into a distributable zip
set -euo pipefail
# portable: project root = parent of this script's directory
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

STAGE="dist/job-command-center"
ZIP="download/job-command-center.zip"

rm -rf dist "$ZIP"
mkdir -p "$STAGE"

# ── Copy project source (no deps/db/build artifacts) ──────────
# NOTE: leading "/" anchors a pattern to the package root — without it
# rsync matches at ANY depth (the old "workspace/" rule silently
# excluded src/app/api/workspace/ too).
rsync -a --exclude-from=- . "$STAGE/" <<'EOF'
node_modules/
.next/
/dist/
/db/
/logs/
/workspace/
/download/
/skills/
/upload/
/tests/
/examples/
/reference/
/tool-results/
/.zscripts/
/.git/
/.z-ai-config
/.env
/tsconfig.check.json
/Caddyfile
/dev.log
/dev-server.log
/server.log
/build.log
/worklog.md
/dev.pid
/bun.lock
/test-results/
/coverage/
*.tsbuildinfo
scripts/*.png
scripts/naukri_*.json
scripts/naukri_page.txt
scripts/jd_test.json
scripts/verify_*.png
scripts/verify-*.png
scripts/agent-console-*.png
scripts/check_*.js
scripts/check_*.ts
scripts/extract_resume.py
scripts/patch-*.py
EOF

# Dev server tee-creates dev.log inside the project — make sure it's absent
rm -f "$STAGE/dev.log" "$STAGE/server.log"

# ── v5.2: ship a CLEAN pre-built SQLite database ───────────────
# The zip's db comes from the live database with all AgentRun test
# rows WIPED (sandbox test junk must never appear as the user's
# "chat history") while the tracker/contacts demo data is kept.
# A pre-pushed db also means the app works even if the user's
# `prisma db push` fails (engines, offline…).
if [ -f db/custom.db ]; then
  mkdir -p "$STAGE/db"
  cp db/custom.db "$STAGE/db/custom.db"
  python3 - "$STAGE/db/custom.db" <<'PYEOF'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
try:
    con.execute("DELETE FROM AgentRun")
    con.execute("DELETE FROM AgentSetting")
    con.commit()
    print("[db-clean] AgentRun/AgentSetting rows wiped; Applications=%d Contacts=%d" % (
        con.execute("SELECT COUNT(*) FROM Application").fetchone()[0],
        con.execute("SELECT COUNT(*) FROM Contact").fetchone()[0]))
except Exception as e:
    print("[db-clean] note:", e)
finally:
    con.close()
PYEOF
else
  echo "NOTE: no live db/custom.db — zip relies on install-time prisma db push"
fi

# v5.2: empty logs dir (never ship sandbox logs)
mkdir -p "$STAGE/logs"

# ── Installers + README from download/ ────────────────────────
cp download/install.sh "$STAGE/"
cp download/install.bat "$STAGE/"
cp download/README.md "$STAGE/"

# ── PDF user guide + its HTML source ──────────────────────────
[ -f download/job-command-center-user-guide.pdf ] && cp download/job-command-center-user-guide.pdf "$STAGE/"
[ -f download/user-guide.html ] && cp download/user-guide.html "$STAGE/user-guide.html"

# ── .env.example ships, and .env ships PRE-CONFIGURED with the owner's ──
# Groq key (v3.5 PRIMARY) + Gemini key (fallback) so the agent works
# out of the box. Keys are read from the project .env at package time
# (never hardcoded in this script — this script itself ships inside the
# zip). Installers keep an existing key on re-run.
[ -f .env.example ] && cp .env.example "$STAGE/"
rm -f "$STAGE/.z-ai-config" "$STAGE/dev-server.log"
OWNER_KEY="$(grep -m1 '^GEMINI_API_KEY=' .env | cut -d= -f2- || true)"
OWNER_GROQ="$(grep -m1 '^GROQ_API_KEY=' .env | cut -d= -f2- || true)"
OWNER_OR="$(grep -m1 '^OPENROUTER_API_KEY=' .env | cut -d= -f2- || true)"
OWNER_NV="$(grep -m1 '^NVIDIA_API_KEY=' .env | cut -d= -f2- || true)"
OWNER_XPL="$(grep -m1 '^EXPLABS_API_KEY=' .env | cut -d= -f2- || true)"
# v4.0: Groq is the REQUIRED primary (user's own key); Gemini optional fallback.
[ -n "$OWNER_GROQ" ] || { echo "ERROR: no GROQ_API_KEY in project .env — refusing to ship a keyless .env"; exit 1; }
[ -z "$OWNER_KEY" ] && echo "NOTE: no GEMINI_API_KEY in project .env — shipping without the Gemini fallback (add one anytime in .env)"
[ -z "$OWNER_OR" ] && echo "NOTE: no OPENROUTER_API_KEY in project .env — GLM-5.2 toggle ships unconfigured"
[ -z "$OWNER_NV" ] && echo "NOTE: no NVIDIA_API_KEY in project .env — Nemotron toggle ships unconfigured"
[ -z "$OWNER_XPL" ] && echo "NOTE: no EXPLABS_API_KEY in project .env — Ex Labs gateway toggle ships unconfigured"
cat > "$STAGE/.env" <<ENV
# Pre-configured by the packager with the owner's keys:
#   GROQ_API_KEY      (PRIMARY — openai/gpt-oss-120b via Groq)
#   OPENROUTER_API_KEY (v4.1 MAIN-MODEL toggle — GLM-5.2, one key → 430+ models)
#   EXPLABS_API_KEY   (v4.3 MAIN-MODEL toggle — Experiential Labs gateway, 313 models)
#   NVIDIA_API_KEY    (v4.1 MAIN-MODEL toggle — nemotron-3-ultra thinking model)
#   GEMINI_API_KEY    (fallback)
# install.bat / install.sh will KEEP these on re-run.
# If you are NOT the owner, replace them (groq: console.groq.com/keys,
# openrouter: openrouter.ai, explabs: platform.experientiallabs.ai,
# nvidia: build.nvidia.com, gemini: aistudio.google.com).
DATABASE_URL=file:./db/custom.db
GROQ_API_KEY=$OWNER_GROQ
GROQ_MODEL=openai/gpt-oss-120b
OPENROUTER_API_KEY=$OWNER_OR
OPENROUTER_MODEL=z-ai/glm-5.2
EXPLABS_API_KEY=$OWNER_XPL
EXPLABS_MODELS=minimax-m2.7-free,kimi-k2.6,glm-5.2,qwen3.6-flash
NVIDIA_API_KEY=$OWNER_NV
NVIDIA_MODEL=nvidia/nemotron-3-ultra-550b-a55b
GLM_API_KEY=
GLM_MODEL=glm-4.6
GEMINI_API_KEY=$OWNER_KEY
GEMINI_MODEL=gemini-flash-latest
AGENT_LLM_PROVIDER=auto
# v5.2 — ENTROPY LOCAL ENGINE: deterministic no-network fallback.
# When no key is configured OR the machine is offline, the local
# engine answers instantly (no timeout lag) and offline coding
# goals still create real files in workspace/. Set 0 to disable.
OFFLINE_ENGINE=1
AGENT_WORKSPACE=
# v4.2: the zero-cost free-model relay (works with ZERO credits on the
# OpenRouter key; each model ~50 req/day, auto-rotation on 429/402)
OPENROUTER_FREE_MODELS=poolside/laguna-s-2.1:free,nvidia/nemotron-3.5-lightning:free,dots-studio/dots3-note-preview:free
# v4.2: local open-weights inference (install https://ollama.com and
# run "ollama pull qwen2.5-coder:7b", then uncomment)
# OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
# OLLAMA_MODEL=qwen2.5-coder:7b
# v4.0: live-streaming console (token-by-token in the terminal); 0 = off
AGENT_LLM_STREAM=1
# v3.7: gpt-oss reasoning budget — "low" = ~3x faster rounds (default),
# "medium"/"high" for harder problems. v4.1: also maps to GLM-5.2 effort
# and Nemotron enable_thinking (Turbo = thinking off).
GROQ_REASONING_EFFORT=low
AGENT_RATE_LLM=15
AGENT_RATE_TOOL=60
AGENT_RATE_SHELL=20
AGENT_RATE_MCP=120
# v4.1: request queuing & backoff (defaults — see llm-resilience.ts)
# AGENT_LLM_MAX_ATTEMPTS=3
# AGENT_LLM_BACKOFF_BASE_MS=1000
# AGENT_LLM_BACKOFF_MAX_MS=30000
# AGENT_LLM_BREAKER_AFTER=3
# AGENT_LLM_BREAKER_MS=90000
# v4.2: daily-budget auto-takeover (the after-400 fallback server)
# AGENT_PROVIDER_DAILY_BUDGET=400
# AGENT_FREECHAIN_DAILY_BUDGET=50
# Optional: unlocks the official github-mcp-server tools (see mcp.config.json)
# GITHUB_PERSONAL_ACCESS_TOKEN=ghp_your_token
# v3.5 marathon limits (defaults if commented): coding 150 / job 60 LLM
# rounds; 90 / 45 minute budgets; 8192 output tokens; 180s LLM timeout.
# AGENT_MAX_ROUNDS=150
# AGENT_BUDGET_MINUTES=90
# AGENT_LLM_MAX_TOKENS=8192
# AGENT_LLM_TIMEOUT_MS=180000
# v4.4: INFINITE RELAY — the provider chain wraps back to the first
# provider with exponential backoff instead of dead-ending. One pass
# = one round; only the deadline ends the rotation.
# AGENT_CHAIN_ROUND_BASE_MS=2000
# AGENT_CHAIN_ROUND_MAX_MS=30000
# AGENT_CHAIN_DEADLINE_MS=120000
# AGENT_CHAIN_ROUNDS=0
# v4.4 (optional): route the app through the bundled OpenRelay gateway
# (node openrelay/server.js → http://127.0.0.1:8787) — every LLM call
# then rides the full 17-step rotation with breakers + failover memory.
# OPENAI_BASE_URL=http://127.0.0.1:8787/v1
# OPENAI_API_KEY=openrelay
# OPENAI_MODEL=openrelay/auto
# v4.5: Remote Python Fresher Radar (GET /api/jobs/remote-python) —
# boards fetch with ZERO keys; AI chain: Experiential Labs (gpt-oss
# first + full catalog waterfall) → openrouter → nvidia → groq LAST.
# REMOTE_PYTHON_MAX_AGE_DAYS=30
# REMOTE_PYTHON_WIDENED_AGE_DAYS=60
# REMOTE_PYTHON_EXPLABS_MODELS=gpt-oss-120b,gpt-oss-20b,qwen3.6-flash,kimi-k2.6,glm-5.2,minimax-m2.7-free
# REMOTE_PYTHON_GROQ_MODELS=openai/gpt-oss-120b,openai/gpt-oss-20b,llama-3.3-70b-versatile
# v4.7: Live Preview Studio — ports probed for agent-built servers
# (the Replit-style PORTS strip). Defaults cover 3000/8787/4597 + the
# usual dev servers; add yours comma-separated.
# PREVIEW_PORTS=3000,8787,4597,5000,8000,5173,4321,8501,11434,1234
ENV

# ── Workspace ships as a FOLDER (AGENT.md memory seed), not build artifacts
mkdir -p "$STAGE/workspace"
cat > "$STAGE/workspace/AGENT.md" <<'AGENTEOF'
# AGENT MEMORY (like CLAUDE.md)
Preferences and notes the coding agent reads at the start of every run.

- Owner: Kartheek — likes dark modern designs, Python and Node stacks.
AGENTEOF

# ── Validate the package before zipping ───────────────────────
for f in package.json prisma/schema.prisma mcp-server/index.ts src/lib/agent/coding-tools.ts \
         src/lib/agent/coding-runner.ts src/lib/agent/llm.ts src/lib/agent/mcp-client.ts \
         src/lib/agent/rate-limit.ts src/lib/workspace.ts \
         src/app/api/agent/health/route.ts src/app/api/workspace/tree/route.ts \
         src/app/api/workspace/file/route.ts src/app/api/workspace/download/route.ts \
         src/app/api/agent/resume/route.ts src/app/api/agent/events/route.ts \
         src/lib/agent/event-bus.ts src/app/api/agent/terminal/route.ts \
         src/app/api/agent/prefs/route.ts src/app/api/workspace/reset/route.ts \
         src/components/dashboard/terminal-console.tsx \
         src/components/dashboard/workspace-explorer.tsx .mcp.json mcp.config.json .env.example \
         workspace/AGENT.md \
         install.sh install.bat README.md scripts/test-mcp-v3.mjs scripts/test-coding-agent.ts \
         scripts/test-provider-guard.ts scripts/test-laptop-sim.ts scripts/test-gemini-history.ts \
         scripts/test-groq-glm.ts scripts/test-mcp-client.ts scripts/test-workspace-api.ts \
         scripts/test-v37.ts scripts/test-v40.ts scripts/test-v41.ts scripts/test-v42.ts \
         scripts/test-v43.ts; do
  [ -f "$STAGE/$f" ] || { echo "MISSING: $f"; exit 1; }
done
# v4.1: the resilience layer + new provider code must ship
for f in src/lib/agent/llm-resilience.ts; do
  [ -f "$STAGE/$f" ] || { echo "MISSING: $f"; exit 1; }
done
# v4.2: the budget server, the free chain, chat-continue + README guarantee
for f in src/lib/agent/llm-budget.ts src/app/api/agent/chat/route.ts; do
  [ -f "$STAGE/$f" ] || { echo "MISSING: $f"; exit 1; }
done
grep -q 'freechainProvider' "$STAGE/src/lib/agent/llm.ts" || { echo "MISSING: v4.2 freechain provider"; exit 1; }
grep -q 'ollamaProvider' "$STAGE/src/lib/agent/llm.ts" || { echo "MISSING: v4.2 ollama provider"; exit 1; }
grep -q 'explabsProvider' "$STAGE/src/lib/agent/llm.ts" || { echo "MISSING: v4.3 Experiential Labs provider"; exit 1; }
grep -q 'api.experientiallabs.ai' "$STAGE/src/lib/agent/llm.ts" || { echo "MISSING: v4.3 gateway base URL"; exit 1; }
grep -q 'minimax-m2.7-free' "$STAGE/src/lib/agent/llm.ts" || { echo "MISSING: v4.3 verified free gateway model"; exit 1; }
grep -q 'EXPLABS_MODELS' "$STAGE/.env.example" || { echo "MISSING: v4.3 EXPLABS env knob in .env.example"; exit 1; }
grep -q '"explabs"' "$STAGE/src/app/api/agent/prefs/route.ts" || { echo "MISSING: v4.3 explabs in prefs route"; exit 1; }
grep -q 'id: "explabs"' "$STAGE/src/components/dashboard/agent-view.tsx" || { echo "MISSING: v4.3 Ex Labs model card"; exit 1; }
grep -q 'explabsModels' "$STAGE/mcp-server/index.ts" || { echo "MISSING: v4.3 MCP budget tool model list"; exit 1; }
[ -f "$STAGE/scripts/test-v43.ts" ] || { echo "MISSING: v4.3 test suite"; exit 1; }
grep -q 'poolside/laguna-s-2.1:free' "$STAGE/src/lib/agent/llm.ts" || { echo "MISSING: v4.2 free relay models"; exit 1; }
grep -q 'ProviderBudgetExhaustedError' "$STAGE/src/lib/agent/llm.ts" || { echo "MISSING: v4.2 budget auto-takeover"; exit 1; }
grep -q 'continueCodingRun' "$STAGE/src/lib/agent/coding-runner.ts" || { echo "MISSING: v4.2 chat-continue"; exit 1; }
grep -q 'ensureProjectReadme' "$STAGE/src/lib/agent/coding-runner.ts" || { echo "MISSING: v4.2 README guarantee"; exit 1; }
grep -q 'agent_budget' "$STAGE/mcp-server/index.ts" || { echo "MISSING: v4.2 MCP agent_budget tool"; exit 1; }
grep -q 'llmBudget' "$STAGE/src/app/api/agent/health/route.ts" || { echo "MISSING: v4.2 health llmBudget"; exit 1; }
grep -q 'OPENROUTER_FREE_MODELS' "$STAGE/.env.example" || { echo "MISSING: v4.2 free-models env knob"; exit 1; }
grep -q 'mainProvider' "$STAGE/src/app/api/agent/prefs/route.ts" || { echo "MISSING: v4.1 mainProvider toggle in prefs route"; exit 1; }
grep -q 'openrouterProvider' "$STAGE/src/lib/agent/llm.ts" || { echo "MISSING: v4.1 OpenRouter provider"; exit 1; }
grep -q 'nvidiaProvider' "$STAGE/src/lib/agent/llm.ts" || { echo "MISSING: v4.1 NVIDIA provider"; exit 1; }
grep -q 'withLlmResilience' "$STAGE/src/lib/agent/llm.ts" || { echo "MISSING: v4.1 resilience wiring in llm.ts"; exit 1; }
# v3.6: jszip + syntax highlighter must be in the shipped dependency manifest
grep -q '"jszip"' "$STAGE/package.json" || { echo "MISSING: jszip dependency in package.json"; exit 1; }
grep -q '"react-syntax-highlighter"' "$STAGE/package.json" || { echo "MISSING: react-syntax-highlighter dependency"; exit 1; }
# v4.0: live terminal deps
grep -q '"@xterm/xterm"' "$STAGE/package.json" || { echo "MISSING: @xterm/xterm dependency"; exit 1; }
grep -q '"@xterm/addon-fit"' "$STAGE/package.json" || { echo "MISSING: @xterm/addon-fit dependency"; exit 1; }
# v4.4: OpenRelay — the never-fail relay gateway ships inside the app
for f in openrelay/server.js openrelay/lib/engine.js openrelay/lib/breaker.js \
         openrelay/lib/providers.js openrelay/lib/queue.js openrelay/lib/usage.js \
         openrelay/public/index.html openrelay/README.md openrelay/LICENSE \
         openrelay/config.json openrelay/config.example.json openrelay/package.json; do
  [ -f "$STAGE/$f" ] || { echo "MISSING: $f"; exit 1; }
done
# v4.6 smoke suite is optional in the shipped zip (sandbox resets sometimes drop it)
[ -f "$STAGE/openrelay/test/smoke.js" ] || echo "NOTE: openrelay/test/smoke.js not in this build (lost to env reset)"
grep -q 'RELAY ROUNDS' "$STAGE/src/lib/agent/llm.ts" || { echo "MISSING: v4.4 relay-rounds rotation"; exit 1; }
grep -q 'announceRelay' "$STAGE/src/lib/agent/llm.ts" || { echo "MISSING: v4.4 relay announcements"; exit 1; }
grep -q 'AGENT_CHAIN_DEADLINE_MS' "$STAGE/src/lib/agent/llm.ts" || { echo "MISSING: v4.4 chain deadline knob"; exit 1; }
grep -q 'wrap-around' "$STAGE/openrelay/lib/engine.js" || { echo "MISSING: v4.4 OpenRelay wrap-around engine"; exit 1; }
grep -q 'never drops the baton' "$STAGE/openrelay/README.md" || { echo "MISSING: OpenRelay README"; exit 1; }
# v4.5: Remote Python Fresher Radar must ship
for f in src/lib/jobs/remote-python.ts src/lib/jobs/remote-python-llm.ts \
         src/app/api/jobs/remote-python/route.ts \
         src/components/dashboard/remote-jobs-view.tsx scripts/test-v45.ts; do
  [ -f "$STAGE/$f" ] || { echo "MISSING: $f"; exit 1; }
done
grep -q 'Remote Python' "$STAGE/src/components/dashboard/command-center.tsx" || { echo "MISSING: v4.5 radar tab"; exit 1; }
# v4.7: Live Preview Studio — the Replit-style webview must ship
for f in src/lib/preview.ts src/hooks/use-preview-channel.ts \
         "src/app/api/preview/[[...path]]/route.ts" \
         src/app/api/preview/events/route.ts \
         src/app/api/preview/ports/route.ts \
         src/components/dashboard/preview-studio.tsx \
         scripts/test-v47.ts scripts/test-v47-e2e.ts; do
  [ -f "$STAGE/$f" ] || { echo "MISSING: $f"; exit 1; }
done
grep -q 'Preview Studio' "$STAGE/src/components/dashboard/command-center.tsx" || { echo "MISSING: v4.7 studio tab"; exit 1; }
grep -q 'publishPreviewWrite' "$STAGE/src/lib/agent/coding-tools.ts" || { echo "MISSING: v4.7 agent-write publish hooks"; exit 1; }
grep -q 'injectPreviewRuntime' "$STAGE/src/lib/preview.ts" || { echo "MISSING: v4.7 runtime injection"; exit 1; }
# v4.9: the old static chat mini panel is GONE — StackBlitz Live App is
# the one live preview in the chat now
! grep -q 'PreviewMiniPanel' "$STAGE/src/components/dashboard/agent-view.tsx" || { echo "LEAK: v4.7 static mini preview still wired in agent-view (removed in v4.9)"; exit 1; }
grep -q 'StackBlitzLivePanel' "$STAGE/src/components/dashboard/agent-view.tsx" || { echo "MISSING: v4.9 StackBlitz live panel in agent-view"; exit 1; }
grep -q 'PREVIEW_PORTS' "$STAGE/.env.example" || { echo "MISSING: v4.7 PREVIEW_PORTS knob in .env.example"; exit 1; }
grep -q 'PREVIEW_PORTS' "$STAGE/.env" || { echo "MISSING: v4.7 PREVIEW_PORTS knob in shipped .env"; exit 1; }
grep -q 'collectRemotePythonRoles' "$STAGE/src/lib/jobs/remote-python.ts" || { echo "MISSING: v4.5 board pipeline"; exit 1; }
grep -q 'VERIFIED_BOARDS' "$STAGE/src/lib/jobs/remote-python.ts" || { echo "MISSING: v4.5 verified boards registry"; exit 1; }
grep -q 'gpt-oss-120b' "$STAGE/src/lib/jobs/remote-python-llm.ts" || { echo "MISSING: v4.5 gpt-oss chain head"; exit 1; }
grep -q 'experientiallabs' "$STAGE/src/lib/jobs/remote-python-llm.ts" || { echo "MISSING: v4.5 ExLabs gateway"; exit 1; }
grep -q 'REMOTE_PYTHON_MAX_AGE_DAYS' "$STAGE/.env.example" || { echo "MISSING: v4.5 env knobs in .env.example"; exit 1; }
# v4.8: the StackBlitz SDK layer must ship
for f in src/lib/stackblitz-project.ts src/components/dashboard/stackblitz-embed.tsx \
         src/app/api/preview/stackblitz/route.ts scripts/test-v49.ts; do
  [ -f "$STAGE/$f" ] || { echo "MISSING: $f"; exit 1; }
done
grep -q 'stackblitz' "$STAGE/package.json" || { echo "MISSING: @stackblitz/sdk dependency"; exit 1; }
# v4.9: the AUTO-RUN COORDINATOR — delete the old app, generate a new
# site, the StackBlitz container re-boots itself on agent quiet
grep -q 'scheduleReboot' "$STAGE/src/components/dashboard/stackblitz-embed.tsx" || { echo "MISSING: v4.9 auto-run coordinator"; exit 1; }
grep -q 'REBOOT_QUIET_MS' "$STAGE/src/components/dashboard/stackblitz-embed.tsx" || { echo "MISSING: v4.9 quiet-gated reboots"; exit 1; }
grep -q 'rootChanged' "$STAGE/src/components/dashboard/stackblitz-embed.tsx" || { echo "MISSING: v4.9 new-project root reboot trigger"; exit 1; }
grep -q 'min(72vh' "$STAGE/src/components/dashboard/stackblitz-embed.tsx" || { echo "MISSING: v4.9 taller embed"; exit 1; }
grep -q 'FRESHEST-WORK-WINS' "$STAGE/src/lib/stackblitz-project.ts" || { echo "MISSING: v4.9 freshest-work root selection"; exit 1; }
grep -q '4.9.0' "$STAGE/src/app/api/preview/stackblitz/route.ts" || { echo "MISSING: v4.9 feed version"; exit 1; }

# ── v5.2: Windows/offline reliability gates ───────────────────
for f in src/lib/agent/offline.ts src/lib/db.ts scripts/server.js \
         scripts/postbuild.js scripts/dev-log.js start.bat start.sh dev.bat \
         db/custom.db; do
  [ -f "$STAGE/$f" ] || { echo "MISSING: v5.2 $f"; exit 1; }
done
grep -q 'offlineGenerate' "$STAGE/src/lib/agent/llm.ts" || { echo "MISSING: v5.2 offline engine wired into llm.ts"; exit 1; }
grep -q 'probeNetwork' "$STAGE/src/lib/agent/llm.ts" || { echo "MISSING: v5.2 network gate"; exit 1; }
grep -q 'ENTROPY_PROJECT_ROOT' "$STAGE/src/lib/db.ts" || { echo "MISSING: v5.2 cross-platform db path resolution"; exit 1; }
# cross-platform package.json scripts (no POSIX-only tee/NODE_ENV= prefix)
! grep -q '"dev": "next dev.*tee' "$STAGE/package.json" || { echo "LEAK: POSIX-only dev script (tee)"; exit 1; }
! grep -q '"start": "NODE_ENV=' "$STAGE/package.json" || { echo "LEAK: POSIX-only start script (env prefix)"; exit 1; }
grep -q '"start": "node scripts/server.js"' "$STAGE/package.json" || { echo "MISSING: v5.2 cross-platform start script"; exit 1; }
grep -q 'postbuild.js' "$STAGE/package.json" || { echo "MISSING: v5.2 cross-platform build script"; exit 1; }
# the chat-history overflow fix must ship (break-words + viewport block)
grep -q 'break-words' "$STAGE/src/components/dashboard/agent-view.tsx" || { echo "MISSING: v5.2 transcript wrap hardening"; exit 1; }
grep -q '\[&>div\]:!block' "$STAGE/src/components/ui/scroll-area.tsx" || { echo "MISSING: v5.2 ScrollArea viewport fix"; exit 1; }
# installers must launch PRODUCTION, not dev
grep -q 'bun run start' "$STAGE/install.bat" || { echo "MISSING: v5.2 production launch in install.bat"; exit 1; }
grep -q 'bun run start' "$STAGE/install.sh" || { echo "MISSING: v5.2 production launch in install.sh"; exit 1; }
grep -q '^OFFLINE_ENGINE=1' "$STAGE/.env" || { echo "MISSING: v5.2 offline engine armed in shipped .env"; exit 1; }
# shipped db must be clean (zero test runs)
RUNS=$(python3 -c "
import sqlite3
con = sqlite3.connect('$STAGE/db/custom.db')
print(con.execute('SELECT COUNT(*) FROM AgentRun').fetchone()[0])
con.close()")
[ "$RUNS" = "0" ] || { echo "LEAK: shipped db contains $RUNS AgentRun rows (test junk)"; exit 1; }
# no sandbox logs in the package
! find "$STAGE/logs" -name '*.log' -size +1c | grep -q . || { echo "LEAK: sandbox logs in package"; exit 1; }

# sanity: sandbox secrets must NOT be inside the package
[ ! -f "$STAGE/.z-ai-config" ] || { echo "LEAK: .z-ai-config in package"; exit 1; }
# the shipped .env must contain ONLY the safe pre-configured template:
# owner's Gemini key present, no sandbox paths, no z-ai/openai leftovers
grep -q '^GROQ_API_KEY=gsk_..' "$STAGE/.env" || { echo "LEAK: shipped .env missing the pre-configured Groq key"; exit 1; }
grep -q '^OPENROUTER_MODEL=z-ai/glm-5.2' "$STAGE/.env" || { echo "MISSING: v4.1 GLM-5.2 default model in shipped .env"; exit 1; }
grep -q '^EXPLABS_API_KEY=xpl_..' "$STAGE/.env" || echo "NOTE: shipped .env has no pre-configured Ex Labs key (toggle ships unconfigured)"
grep -q '^EXPLABS_MODELS=minimax-m2.7-free' "$STAGE/.env" || { echo "MISSING: v4.3 gateway waterfall in shipped .env"; exit 1; }
grep -q '^NVIDIA_MODEL=nvidia/nemotron-3-ultra-550b-a55b' "$STAGE/.env" || { echo "MISSING: v4.1 Nemotron model in shipped .env"; exit 1; }
# Gemini fallback is optional in v4.0 (Groq primary is the hard requirement above)
! grep -q '/home/z' "$STAGE/.env" || { echo "LEAK: sandbox path in shipped .env"; exit 1; }
# NOTE: 'z-ai/glm-5.2' is the legit OpenRouter model id — only ZAI key
# names are leaks (the sandbox SDK key must never ship).
! grep -qE '^(ZAI_API_KEY|Z_AI_API_KEY|ZAI_GLMAPI_KEY)=' "$STAGE/.env" || { echo "LEAK: z-ai SDK key in shipped .env"; exit 1; }
! grep -q '^OPENAI_API_KEY=..' "$STAGE/.env" || { echo "LEAK: openai key in shipped .env"; exit 1; }
! grep -q '^GITHUB_PERSONAL_ACCESS_TOKEN=..' "$STAGE/.env" || { echo "LEAK: github token in shipped .env"; exit 1; }
echo "✓ package contents validated ($(find "$STAGE" -type f | wc -l) files)"

# ── Zip ───────────────────────────────────────────────────────
mkdir -p download
(cd dist && zip -qr "../$ZIP" job-command-center -x "*/.DS_Store")
echo "✓ created $ZIP ($(du -h "$ZIP" | cut -f1))"
unzip -l "$ZIP" | head -8
unzip -l "$ZIP" | tail -3
