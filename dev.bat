@echo off
setlocal
title Entropy - dev mode (slow, compiles on the fly)
cd /d "%~dp0"
echo [i] DEV MODE — first page loads compile on the fly (slow, ~2GB RAM).
echo     Prefer start.bat (production, fast). Use this only for editing code.
echo.
call bun run dev:log
pause
