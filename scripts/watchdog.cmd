@echo off
rem Watchdog: start the trader if nothing is listening on the monitor port.
rem Registered as a scheduled task (every 2 min) — OS-native restart on crash.
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)) { Start-Process -FilePath '%~dp0start-trader.cmd' -WindowStyle Hidden }"
