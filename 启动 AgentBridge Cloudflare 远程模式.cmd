@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-agentbridge.ps1" -CloudflareTunnel -OpenDashboard
if errorlevel 1 (
  echo.
  echo AgentBridge Cloudflare remote startup failed. See the message above.
  pause
)
