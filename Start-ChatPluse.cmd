@echo off
setlocal
cd /d "%~dp0"
set "PATH=%~dp0.runtime\node20;C:\Program Files\Git\cmd;C:\Program Files\Docker\Docker\resources\bin;%PATH%"
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\start-stack.ps1"
endlocal
