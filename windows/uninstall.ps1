<#
  Idealo-Preischeck – Deinstallation unter Windows
  Entfernt die automatische Aktualisierung und den Installationsordner.
  Die Erweiterung selbst bitte vorher in chrome://extensions entfernen.
#>
$ErrorActionPreference = 'Continue'
$InstallDir = Join-Path $env:LOCALAPPDATA 'IdealoPreischeck'

Write-Host ''
Write-Host '  Idealo-Preischeck – Deinstallation' -ForegroundColor Cyan
Write-Host '  Bitte zuerst in chrome://extensions die Erweiterung entfernen.'
$answer = Read-Host '  Automatische Updates und Ordner jetzt entfernen? (j/n)'
if ($answer -notmatch '^[jJyY]') { Write-Host '  Abgebrochen.'; exit 0 }

Unregister-ScheduledTask -TaskName 'IdealoPreischeck-Update' -Confirm:$false -ErrorAction SilentlyContinue
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'IdealoPreischeck-Update.lnk'
if (Test-Path $lnk) { Remove-Item $lnk -Force }

Set-Location $env:TEMP   # nicht im Ordner stehen, der gelöscht wird
Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path $InstallDir) {
  Write-Host "  Ordner konnte nicht vollständig gelöscht werden (noch in Chrome geladen?): $InstallDir" -ForegroundColor Yellow
} else {
  Write-Host '  Entfernt.' -ForegroundColor Green
}
