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

echo.
echo ========================================
echo Generate local HTML site
echo ========================================
echo.
echo Reads:
echo   data\link_state.csv
echo   data\image_state.csv
echo Writes:
echo   site\links.html
echo   site\images.html
echo.

"%NODE_EXE%" "_internal\generate_site.cjs"

set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo [DONE] Site generated.
  echo Opening:
  echo %CD%\site\links.html
  start "" "%CD%\site\links.html"
) else (
  echo [ERROR] Exited with code %EXIT_CODE%.
)
echo.
pause
exit /b %EXIT_CODE%
