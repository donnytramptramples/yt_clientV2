@echo off
cd /d "%~dp0"
echo [UPDATER] Syncing with GitHub...

:: Get current branch
for /f "tokens=*" %%i in ('git branch --show-current') do set current_branch=%%i

:: Fetch latest from remote
git fetch origin

:: Reset to remote branch, discarding any local changes
git reset --hard origin/%current_branch%

:: Check if there were changes (compare with previous HEAD)
git diff --quiet HEAD@{1} HEAD
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
