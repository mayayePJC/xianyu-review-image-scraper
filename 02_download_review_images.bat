@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

cd /d "%~dp0"

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" (
  set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
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
echo Xianyu review image downloader - resumable
echo ========================================
echo.
echo Reads:
echo   data\link_state.csv
echo Writes/updates:
echo   data\image_state.csv
echo   images\
echo.
echo Batch limits:
echo   max sellers per run: 1
echo   max images per run: 30
echo.

"%NODE_EXE%" "_internal\xianyu_public_review_image_scraper.cjs" --mode download-images --cdp-url= --max-links-per-run 1 --max-images-per-run 30 --scroll-steps 16 --min-delay-ms 1200 --max-delay-ms 2500

set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo [DONE] Finished. Check:
  echo %CD%\data\image_state.csv
  echo %CD%\images
) else (
  echo [ERROR] Exited with code %EXIT_CODE%.
)
echo.
pause
exit /b %EXIT_CODE%
