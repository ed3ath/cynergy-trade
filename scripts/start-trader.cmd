@echo off
rem Boots the autonomous trader detached from any shell session.
rem Env comes from .env (gitignored) — never hardcode secrets here.
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f "usebackq tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"
pnpm exec tsx apps/trader/src/index.ts >> logs\trader.log 2>&1
