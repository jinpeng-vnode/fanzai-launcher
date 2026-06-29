@echo off
setlocal

cd /d "%~dp0"
set "FANZAI_LAUNCHER_ROOT=%~dp0"
set "APP_EXE="

for %%f in ("runtime\electron-app\win-unpacked\*.exe") do (
  set "APP_EXE=%%~ff"
  goto :launch
)

for %%f in ("runtime\electron-app\*.exe") do (
  set "APP_EXE=%%~ff"
  goto :launch
)

echo Launcher executable not found.
pause
exit /b 1

:launch
start "" "%APP_EXE%"
exit /b 0
