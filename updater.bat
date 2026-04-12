@echo off
cd /d "%~dp0"
echo [Checking GitHub...]
git fetch
git status -uno | findstr /C:"behind" > nul
if %errorlevel% == 0 (
    echo [Update Found! Pulling...]
    git pull origin main
    call npm install
    taskkill /F /IM node.exe
) else (
    echo [No updates found. Everything is current.]
)
