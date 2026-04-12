@echo off
cd /d "%~dp0"
:loop
cls
echo [ENGINE] Starting server...
node server.js
echo [ENGINE] Server stopped/crashed. Restarting in 10s...
timeout /t 10
goto loop
step 