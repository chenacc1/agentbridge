@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-agentbridge.ps1" -OpenDashboard
if errorlevel 1 (
  echo.
  echo AgentBridge startup failed. See the message above.
  pause
)
