@echo off
cd /d "%~dp0"
echo [UPDATER] Syncing with GitHub...

:: Check for updates and pull if available
git pull origin main 2>&1 | findstr /C:"Already up to date" > nul

if %errorlevel% == 0 (
    echo [UPDATER] No changes on GitHub.
) else (
    echo [UPDATER] UPDATING DETECTED!
    call npm install
    echo [UPDATER] Updating yt-dlp...
    pip install --upgrade yt-dlp
    echo [UPDATER] Restarting server...
    taskkill /F /IM node.exe /T > nul 2>&1
    start "" engine.bat
)
pause
