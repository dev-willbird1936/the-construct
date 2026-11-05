@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found on PATH.
  echo Install Node.js 20+ and try again.
  pause
  exit /b 1
)

where python >nul 2>&1
if errorlevel 1 (
  echo Python was not found on PATH.
  echo Install Python 3.10+ and try again.
  pause
  exit /b 1
)

if not exist "backend\node_modules" (
  echo Installing backend dependencies...
  pushd backend
  call npm install
  popd
)

start "Spacetime Object Volume - backend" /d "%~dp0backend" cmd /k "node server.js"
start "Spacetime Object Volume - frontend" /d "%~dp0" cmd /k "python serve.py 4175"
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:4175/"

echo Spacetime Object Volume is running at http://127.0.0.1:4175/
echo Close both server windows to stop it.
