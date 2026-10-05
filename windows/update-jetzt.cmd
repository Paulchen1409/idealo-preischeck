@echo off
rem Sofort auf GitHub nach einer neuen Version schauen
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
echo.
pause
