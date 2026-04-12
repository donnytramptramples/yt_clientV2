@echo off
cd /d "%~dp0"
echo [UPDATER] Syncing with GitHub...

:: Check for local changes
git status --porcelain > nul
if %errorlevel% == 0 (
    :: No local changes, safe to pull
    git pull 2>&1 | findstr /C:"Already up to date" > nul
    if %errorlevel% == 0 (
        echo [UPDATER] No changes on GitHub.
    ) else (
        goto update
    )
) else (
    :: Local changes detected, stash them
    echo [UPDATER] Stashing local changes...
    git stash push -m "auto stash by updater"
    git pull 2>&1 | findstr /C:"Already up to date" > nul
    if %errorlevel% == 0 (
        echo [UPDATER] No changes on GitHub.
        echo [UPDATER] Restoring stashed changes...
        git stash pop
    ) else (
        goto update
    )
)
goto end

:update
echo [UPDATER] UPDATING DETECTED!
call npm install
echo [UPDATER] Updating yt-dlp...
pip install --upgrade yt-dlp
echo [UPDATER] Restarting server...
taskkill /F /IM node.exe /T > nul 2>&1
start "" engine.bat
echo [UPDATER] Restoring stashed changes if any...
git stash pop 2> nul

:end
pause
