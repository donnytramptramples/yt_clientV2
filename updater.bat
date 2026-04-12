@echo off
cd /d "%~dp0"
echo [UPDATER] Checking GitHub...

:: Download latest info from GitHub
git fetch origin main

:: Compare your local version to the remote version
for /f %%i in ('git rev-parse HEAD') do set LOCAL=%%i
for /f %%j in ('git rev-parse @{u}') do set REMOTE=%%j

if "%LOCAL%" == "%REMOTE%" (
    echo [UPDATER] Already up to date.
) else (
    echo [UPDATER] New code found! Pulling now...
    git pull origin main
    echo [UPDATER] Installing packages...
    call npm install
    echo [UPDATER] Restarting server...
    taskkill /F /IM node.exe /T
)
pause
