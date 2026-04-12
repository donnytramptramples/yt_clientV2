@echo off
cd /d "%~dp0"
echo [UPDATER] Checking and pulling latest code...

:: 1. Force the pull (this will only download if there's something new)
git pull origin main

:: 2. Check if the pull actually changed anything
:: (This searches the git logs to see if the local head changed in the last 5 seconds)
git log -1 --since="5 seconds ago" | findstr /C:"commit" > nul

if %errorlevel% == 0 (
    echo [UPDATER] New code detected. Installing and Restarting...
    call npm install
    taskkill /F /IM node.exe
) else (
    echo [UPDATER] Already up to date.
)
