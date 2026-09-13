@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-agentbridge.ps1" -ZeroTier -OpenDashboard
if errorlevel 1 (
  echo.
  echo AgentBridge ZeroTier remote startup failed. See the message above.
  pause
)
