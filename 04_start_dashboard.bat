@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

cd /d "%~dp0"

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" (
  set "NODE_EXE=C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)

if not exist "%NODE_EXE%" (
  echo [ERROR] Node.js not found.
  pause
  exit /b 1
)

echo.
echo ========================================
echo Xianyu local dashboard
echo ========================================
echo.
echo URL:
echo   http://127.0.0.1:8788/sellers.html
echo.
echo Close this window to stop the dashboard server.
echo.

set "XIANYU_DASHBOARD_PORT=8788"
start "" "http://127.0.0.1:8788/sellers.html"
"%NODE_EXE%" "_internal\dashboard_server.cjs"

set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo [STOPPED] Dashboard server exited with code %EXIT_CODE%.
echo.
pause
exit /b %EXIT_CODE%
