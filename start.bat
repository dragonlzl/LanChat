@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found. Please install Node.js 22+ first.
  exit /b 1
)

if not exist package.json (
  echo [ERROR] package.json not found. Please run this script from the project root.
  exit /b 1
)

if not exist node_modules (
  echo [INFO] node_modules not found. Running npm install...
  call npm install
  if errorlevel 1 exit /b %errorlevel%
)

if "%~1"=="" (
  set "START_ARGS=--host 0.0.0.0 --port 3000 --data-dir ./data"
) else (
  set "START_ARGS=%*"
)

echo [INFO] Starting LAN Chat...
echo [INFO] Command: npm run start -- %START_ARGS%
call npm run start -- %START_ARGS%
exit /b %errorlevel%
