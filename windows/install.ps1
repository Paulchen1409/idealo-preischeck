<#
  Idealo-Preischeck – Installation unter Windows (ohne Chrome Web Store)

  1. Kopiert die Erweiterung nach %LOCALAPPDATA%\IdealoPreischeck\extension
  2. Richtet die automatische Aktualisierung von GitHub ein (Aufgabenplanung:
     bei Anmeldung und alle 3 Stunden, unsichtbar)
  3. Öffnet chrome://extensions und legt den Ordnerpfad in die Zwischenablage

  Einmalig nötig (lässt Chrome nicht anders zu): Entwicklermodus an → "Entpackte Erweiterung laden".
  Danach aktualisiert sich alles selbst.

  Start: Doppelklick auf install.cmd
  Kompatibel mit Windows PowerShell 5.1, keine Administratorrechte nötig.
#>
[CmdletBinding()]
param(
  [string]$Repo,             # z. B. "paul/idealo-preischeck"; sonst aus config.json oder Nachfrage
  [string]$Branch = 'main',
  [switch]$NoTask,           # keine Aufgabenplanung (nur kopieren)
  [switch]$NoChrome          # Chrome nicht öffnen
)

$ErrorActionPreference = 'Stop'
$here       = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
$InstallDir = Join-Path $env:LOCALAPPDATA 'IdealoPreischeck'
$extDir     = Join-Path $InstallDir 'extension'
$taskName   = 'IdealoPreischeck-Update'

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }

Say ''
Say '  Idealo-Preischeck – Installation' 'Cyan'
Say '  ─────────────────────────────────' 'Cyan'

# ---------- GitHub-Repo bestimmen ----------
$cfgFile = Join-Path $here 'config.json'
$token = $null
if (-not $Repo -and (Test-Path $cfgFile)) {
  $c = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $Repo = $c.repo
  if ($c.branch) { $Branch = $c.branch }
  if ($c.token)  { $token = $c.token }
}
while (-not $Repo -or $Repo -notmatch '^[\w.-]+/[\w.-]+$' -or $Repo -like 'DEIN-*') {
  $Repo = (Read-Host '  GitHub-Repo für Updates (Format: besitzer/name)').Trim()
}

# ---------- Dateien kopieren ----------
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
foreach ($f in 'update.ps1', 'uninstall.ps1', 'run-hidden.vbs', 'update-jetzt.cmd', 'deinstallieren.cmd') {
  $p = Join-Path $here $f
  if (Test-Path $p) {
    Copy-Item $p (Join-Path $InstallDir $f) -Force
    Unblock-File (Join-Path $InstallDir $f) -ErrorAction SilentlyContinue   # "aus dem Internet"-Markierung entfernen
  }
}

# Vorhandenes Token aus einer früheren Installation behalten
$oldCfg = Join-Path $InstallDir 'config.json'
if (-not $token -and (Test-Path $oldCfg)) {
  try { $token = (Get-Content $oldCfg -Raw -Encoding UTF8 | ConvertFrom-Json).token } catch { }
}
$cfg = [ordered]@{ repo = $Repo; branch = $Branch }
if ($token) { $cfg.token = $token }
($cfg | ConvertTo-Json) | Set-Content $oldCfg -Encoding UTF8

$update = Join-Path $InstallDir 'update.ps1'

# Erstinstallation: aus dem mitgelieferten Ordner (schnell, ohne Internet) …
$localExt = Join-Path (Split-Path $here -Parent) 'extension'
if (Test-Path (Join-Path $localExt 'manifest.json')) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $update -SourceDir $localExt
}
# … danach auf GitHub nach einer neueren Version schauen
Say '  Prüfe GitHub auf Updates …'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $update
if (-not (Test-Path (Join-Path $extDir 'manifest.json'))) {
  Say '  Die Erweiterung konnte nicht installiert werden – siehe update.log.' 'Red'
  Say "  $InstallDir\update.log" 'Red'
  exit 1
}
$version = (Get-Content (Join-Path $extDir 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
Say "  Installiert: Version $version" 'Green'

# ---------- Automatische Aktualisierung ----------
if (-not $NoTask) {
  $vbs = Join-Path $InstallDir 'run-hidden.vbs'
  try {
    $action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
    $atLogon  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    try {
      $every3h = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10) -RepetitionInterval (New-TimeSpan -Hours 3)
    } catch {
      # Ältere Windows-10-Versionen verlangen eine Dauer
      $every3h = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10) -RepetitionInterval (New-TimeSpan -Hours 3) -RepetitionDuration (New-TimeSpan -Days 3650)
    }
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($atLogon, $every3h) -Settings $settings `
      -Description 'Holt neue Versionen der Chrome-Erweiterung Idealo-Preischeck von GitHub.' -Force | Out-Null
    Say '  Automatische Updates: aktiv (bei Anmeldung und alle 3 Stunden)' 'Green'
  } catch {
    # Fallback ohne Aufgabenplanung: beim Anmelden über den Autostart-Ordner
    $startup = [Environment]::GetFolderPath('Startup')
    $lnk = Join-Path $startup 'IdealoPreischeck-Update.lnk'
    $sh = New-Object -ComObject WScript.Shell
    $s = $sh.CreateShortcut($lnk); $s.TargetPath = 'wscript.exe'; $s.Arguments = "`"$vbs`""; $s.Save()
    Say "  Aufgabenplanung nicht möglich ($($_.Exception.Message))." 'Yellow'
    Say '  Updates laufen stattdessen bei jeder Anmeldung (Autostart).' 'Yellow'
  }
}

# ---------- Chrome: einmalig entpackt laden ----------
Set-Clipboard -Value $extDir
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

Say ''
Say '  Letzter Schritt in Chrome (nur dieses eine Mal):' 'Cyan'
Say '   1. Oben rechts "Entwicklermodus" einschalten'
Say '   2. "Entpackte Erweiterung laden" klicken'
Say '   3. Im Ordner-Dialog oben in die Adresszeile klicken, Strg+V, Enter, "Ordner auswählen"'
Say "      (der Pfad ist schon in der Zwischenablage: $extDir)"
Say '   4. Eine ältere, von Hand geladene Version der Erweiterung dort entfernen'
Say ''
Say '  Danach aktualisiert sich die Erweiterung von selbst.' 'Green'
Say "  Jetzt sofort aktualisieren: $InstallDir\update-jetzt.cmd"
Say ''

if (-not $NoChrome) {
  if ($chrome) { Start-Process $chrome 'chrome://extensions/' }
  else { Say '  Chrome nicht gefunden – bitte chrome://extensions selbst öffnen.' 'Yellow' }
}
