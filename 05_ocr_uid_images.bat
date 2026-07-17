@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

cd /d "%~dp0"

set "PYTHONDONTWRITEBYTECODE=1"
set "PYTHONPYCACHEPREFIX=%~dp0_internal\tmp_pycache"

set "PYTHON_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if not exist "%PYTHON_EXE%" (
  set "PYTHON_EXE=python"
)

echo.
echo ========================================
echo OCR UID from review images
echo ========================================
echo.
echo Reads/writes:
echo   data\image_state.csv
echo Adds/updates:
echo   uid
echo   usable
echo.

"%PYTHON_EXE%" -B "_internal\ocr_uid_from_images.py"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo [DONE] OCR finished. Regenerating HTML site...
  if exist "C:\Program Files\nodejs\node.exe" (
    "C:\Program Files\nodejs\node.exe" "_internal\generate_site.cjs"
  ) else (
    node "_internal\generate_site.cjs"
  )
) else (
  echo [ERROR] OCR exited with code %EXIT_CODE%.
)
echo.
pause
exit /b %EXIT_CODE%
