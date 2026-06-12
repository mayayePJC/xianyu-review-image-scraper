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

if not exist "_internal\node_modules\playwright-core" (
  if not exist "..\node_modules\playwright-core" (
    echo [INFO] Installing dependency: playwright-core
    if exist "C:\Program Files\nodejs\npm.cmd" (
      call "C:\Program Files\nodejs\npm.cmd" install --prefix "_internal" --no-audit --no-fund
    ) else (
      call npm.cmd install --prefix "_internal" --no-audit --no-fund
    )
    if errorlevel 1 (
      echo [ERROR] Dependency install failed.
      pause
      exit /b 1
    )
  )
)

echo.
echo ========================================
echo Xianyu link discovery - resumable
echo ========================================
echo.
echo Writes/updates:
echo   data\link_state.csv
echo.
echo Batch limits:
echo   max keywords: 3
echo   max new links: 10
echo   max review checks: 10
echo   max open browser pages: 2
echo   seller-name refresh: skipped during link discovery
echo.

"%NODE_EXE%" "_internal\xianyu_public_review_image_scraper.cjs" --mode discover-links --cdp-url= --max-keywords 3 --max-candidates 10 --max-candidates-per-keyword 10 --max-inspect-pages 10 --max-refresh-pages 0 --max-open-pages 2 --skip-seller-name-refresh --scroll-steps 8 --min-delay-ms 1200 --max-delay-ms 2500

set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo [DONE] Finished. Check:
  echo %CD%\data\link_state.csv
) else (
  echo [ERROR] Exited with code %EXIT_CODE%.
)
echo.
pause
exit /b %EXIT_CODE%
