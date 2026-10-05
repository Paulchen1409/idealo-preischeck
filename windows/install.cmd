@echo off
rem Idealo-Preischeck installieren (Doppelklick)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
