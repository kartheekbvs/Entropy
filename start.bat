@echo off
setlocal enabledelayedexpansion
title Entropy - AI Agent (production)
cd /d "%~dp0"

echo ═════════════════════════════════════════════════
echo   ENTROPY — AI AGENT BY KARTHEEK
echo   Production launcher (fast mode, ~130MB RAM)
echo ═════════════════════════════════════════════════

REM ── runtime check (bun preferred, node works) ───────────────
set "RUNNER="
where bun >nul 2>&1 && set "RUNNER=bun"
if not defined RUNNER (
  where node >nul 2>&1 && set "RUNNER=node"
)
if not defined RUNNER (
  echo [X] Neither bun nor node found. Run install.bat first.
  pause & exit /b 1
)
echo   [OK] runtime: %RUNNER%

REM ── dependencies present? ───────────────────────────────────
if not exist node_modules (
  echo [!] node_modules missing - installing dependencies first...
  call bun install
  if not %errorlevel%==0 ( echo [X] install failed & pause & exit /b 1 )
)

REM ── database present? (ships pre-created; repair if missing) ─
if not exist db\custom.db (
  echo [!] db\custom.db missing - creating schema...
  if not exist db mkdir db
  set "DATABASE_URL=file:%~dp0db\custom.db"
  call bunx prisma db push --accept-data-loss
)

REM ── production build present? build it once (1-3 min) ───────
if not exist .next\standalone\server.js (
  echo [!] No production build yet - building ^(one time, 1-3 min^)...
  call %RUNNER% run build
  if not %errorlevel%==0 ( echo [X] build failed & pause & exit /b 1 )
)

REM ── OpenRelay provider relay (:8787) ────────────────────────
powershell -NoProfile -Command "try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/healthz' -UseBasicParsing -TimeoutSec 2 } catch {}" >nul 2>&1
if not %errorlevel%==0 (
  echo [i] starting OpenRelay provider relay on :8787...
  start /b cmd /c "cd openrelay && node server.js > ..\logs\openrelay.log 2>&1"
  if not exist logs mkdir logs
) else (
  echo   [OK] OpenRelay already running on :8787
)

REM ── start the production server ─────────────────────────────
if not exist logs mkdir logs
echo [i] starting production server on http://localhost:3000 ...
start "" http://localhost:3000
start /b cmd /c "%RUNNER% run start > logs\server.log 2>&1"

echo   Waiting for the server...
powershell -NoProfile -Command "$ok=$false; for ($i=0; $i -lt 30; $i++) { Start-Sleep -Seconds 2; try { $r = Invoke-WebRequest -Uri 'http://localhost:3000/api/agent/health' -UseBasicParsing -TimeoutSec 5; $j = $r.Content | ConvertFrom-Json; if ($j.ok) { $prov = ($j.agent.providers | Where-Object {$_.configured} | Select-Object -First 3 | ForEach-Object {$_.name}) -join ', '; $net = if ($j.agent.networkOnline -eq $true) {'online'} elseif ($j.agent.networkOnline -eq $false) {'OFFLINE - local engine armed'} else {''}; Write-Output ('  [OK] AGENT READY - ' + $prov + ' ' + $net); $ok=$true; break } } catch {} }; if (-not $ok) { Write-Output '  [!] still starting - open http://localhost:3000 and check the Agent tab.' }"

echo.
echo ═════════════════════════════════════════════════
echo   App:      http://localhost:3000
echo   Relay:    http://127.0.0.1:8787
echo   Logs:     logs\server.log
echo   Keep this window open. Stop: close it.
echo ═════════════════════════════════════════════════
pause
