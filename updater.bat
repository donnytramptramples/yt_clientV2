@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo [UPDATER] Starting sync at %date% %time%

:: Get current branch
for /f "tokens=*" %%i in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "current_branch=%%i"
if "%current_branch%"=="" (
    echo [UPDATER] ERROR: Not a git repo
    exit /b 1
)

echo [UPDATER] Branch: %current_branch%

:: Fetch latest from GitHub
git fetch origin %current_branch%
if %errorlevel% neq 0 (
    echo [UPDATER] ERROR: Failed to fetch
    exit /b 1
)

:: Check if update needed (FIXED: proper errorlevel syntax)
git diff --quiet HEAD origin/%current_branch%
if %errorlevel% equ 0 (
    echo [UPDATER] Already up to date
    goto end
)

echo [UPDATER] Changes detected! Updating...

:: Hard reset to match GitHub
git reset --hard origin/%current_branch%
if %errorlevel% neq 0 (
    echo [UPDATER] ERROR: Git reset failed
    exit /b 1
)

:: Install deps
echo [UPDATER] Installing NPM packages...
call npm ci --silent --no-audit --no-fund
if %errorlevel% neq 0 (
    echo [UPDATER] ERROR: npm install failed
    exit /b 1
)

:: Build
echo [UPDATER] Building Vite...
call npm run build
if %errorlevel% neq 0 (
    echo [UPDATER] ERROR: Build failed - server NOT restarted
    exit /b 1
)

:: Update yt-dlp
echo [UPDATER] Updating yt-dlp...
pip install --upgrade --quiet yt-dlp

:: Kill server (only if build succeeded)
echo [UPDATER] Restarting server...
taskkill /F /IM node.exe /T >nul 2>&1

:end
echo [UPDATER] Sync completed at %date% %time%
exit /b 0