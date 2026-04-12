@echo off
cd /d "%~dp0"
echo [UPDATER] Syncing with GitHub...

:: 1. Actually pull the code (this moves the files into your folder)
git pull origin main

:: 2. Check if the pull actually did anything 
:: (It looks for the 'up to date' message in the last command)
git pull origin main | findstr /C:"Already up to date" > nul

if %errorlevel% == 0 (
    echo [UPDATER] No changes on GitHub.
) else (
    echo [UPDATER] UPDATING DETECTED!
    call npm install
    echo [UPDATER] Restarting node server...
    taskkill /F /IM node.exe /T
)
pause
