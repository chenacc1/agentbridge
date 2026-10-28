@echo off
setlocal
set "pauseOnExit=1"
if /I "%~1"=="--no-pause" set "pauseOnExit=0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-agentbridge.ps1"
set "exitCode=%errorlevel%"

if "%pauseOnExit%"=="1" (
  echo.
  if "%exitCode%"=="0" (
    echo Safe shutdown check completed.
  ) else (
    echo Safe shutdown did not complete. Review the message above.
  )
  pause
)

exit /b %exitCode%
