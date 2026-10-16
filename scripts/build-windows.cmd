@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

echo [Build NSIS]
call npm run tauri -- build --bundles nsis
set "BUILD_EXIT=%ERRORLEVEL%"

if not "%BUILD_EXIT%"=="0" (
  echo tauri build failed: %BUILD_EXIT%
  exit /b %BUILD_EXIT%
)

echo [Done]
dir /b "%CD%\src-tauri\target\release\bundle\nsis\*"
exit /b 0
