@echo off
cd /d "%~dp0"
echo [UPDATER] Syncing with GitHub...

:: Detect the current branch automatically
set "current_branch="
for /f "tokens=*" %%i in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "current_branch=%%i"
if "%current_branch%"=="" (
    echo [UPDATER] Could not detect current branch.
    goto end
)

:: Fetch latest info from GitHub
git fetch origin

:: Verify the remote branch exists
set "remote_branch=origin/%current_branch%"
git show-ref --verify --quiet refs/remotes/%remote_branch%
if errorlevel 1 (
    echo [UPDATER] Remote branch %remote_branch% not found.
    for /f "tokens=3 delims= " %%b in ('git remote show origin ^| findstr /c:"HEAD branch"') do set "current_branch=%%b"
    if "%current_branch%"=="" (
        echo [UPDATER] Could not detect remote HEAD branch.
        goto end
    )
    set "remote_branch=origin/%current_branch%"
    echo [UPDATER] Using remote default branch %remote_branch%.
)

:: Force local files to match GitHub exactly
git reset --hard %remote_branch%
if errorlevel 1 (
    echo [UPDATER] Git reset failed. Aborting.
    goto end
)

:: Check if the code actually changed since the last run
git rev-parse --verify HEAD@{1} >nul 2>&1
if errorlevel 0 (
    git diff --quiet HEAD@{1} HEAD
    if errorlevel 0 (
        echo [UPDATER] No changes on GitHub.
        goto end
    )
)

echo [UPDATER] UPDATING DETECTED!

:: Install new packages
echo [UPDATER] Installing NPM packages...
call npm install

:: REBUILD VITE FRONTEND (Crucial for React changes)
echo [UPDATER] Building Vite production files...
call npm run build

:: Update your YouTube downloader
echo [UPDATER] Updating yt-dlp...
pip install --upgrade yt-dlp

:: Kill the running server
:: Your engine.bat (running in Task Scheduler) will see this and restart the site
echo [UPDATER] Restarting server...
taskkill /F /IM node.exe /T > nul 2>&1

:end
echo [UPDATER] Task Finished.
