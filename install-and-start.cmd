@echo off
setlocal
cd /d "%~dp0"

echo [chatpulse] Installing dependencies and preparing local files...
call npm run setup
if errorlevel 1 (
  echo [chatpulse] Setup failed.
  exit /b 1
)

echo [chatpulse] Starting ChatPulse stack...
call start-stack.cmd
if errorlevel 1 (
  echo [chatpulse] Start failed.
  exit /b 1
)

echo.
echo [chatpulse] Done.
echo [chatpulse] Frontend: http://127.0.0.1:5173
echo [chatpulse] Backend : http://localhost:8000
echo [chatpulse] Default first-login account: Nana
echo [chatpulse] Default first-login password: 12345
endlocal
