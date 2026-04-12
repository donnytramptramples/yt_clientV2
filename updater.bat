@echo off
cd /d "%~dp0"
git fetch
git status -uno | findstr /C:"behind" > nul
if %errorlevel% == 0 (
    git pull origin main
    call npm install
    taskkill /F /IM node.exe
)
