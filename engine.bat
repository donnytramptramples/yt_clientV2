@echo off
cd /d "%~dp0"
:loop
node server.js
echo Server stopped. Restarting in 10s...
timeout /t 10
goto loop
