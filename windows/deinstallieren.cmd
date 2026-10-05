@echo off
rem Automatische Updates und Installationsordner entfernen
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
echo.
pause
