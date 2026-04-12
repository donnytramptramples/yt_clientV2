@echo off
cd /d "%~dp0"
echo [UPDATER] Checking GitHub...
git fetch
git status -uno | findstr /C:"behind" > nul
if %errorlevel% == 0 (
    echo [UPDATER] New code found! Updating...
    git pull origin main
    call npm install
    echo [UPDATER] Restarting engine...
    taskkill /F /IM node.exe
) else (
    echo [UPDATER] No changes found.
)
