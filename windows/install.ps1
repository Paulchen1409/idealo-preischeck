<#
  Idealo-Preischeck – Installation unter Windows (ohne Chrome Web Store)

  1. Fragt nach dem Browser (Vorschlag: dein Standardbrowser)
  2. Kopiert die Erweiterung nach %LOCALAPPDATA%\IdealoPreischeck\extension
  3. Richtet die automatische Aktualisierung von GitHub ein (Aufgabenplanung:
     einmal täglich, unsichtbar; war der PC aus, beim nächsten Start)
  4. Öffnet die Erweiterungsseite des Browsers und legt den Ordnerpfad in die Zwischenablage

  Einmalig nötig (lassen Chromium-Browser nicht anders zu): Entwicklermodus an →
  "Entpackte Erweiterung laden". Danach aktualisiert sich alles selbst – in jedem Browser,
  der den Ordner geladen hat.

  Start: Doppelklick auf install.cmd
  Kompatibel mit Windows PowerShell 5.1, keine Administratorrechte nötig.
#>
[CmdletBinding()]
param(
  [string]$Repo,             # z. B. "paul/idealo-preischeck"; sonst aus config.json oder Nachfrage
  [string]$Branch = 'main',
  [ValidateSet('', 'chrome', 'edge', 'brave', 'opera', 'operagx', 'vivaldi')]
  [string]$Browser = '',     # ohne Angabe: Auswahl im Fenster
  [switch]$NoTask,           # keine Aufgabenplanung (nur kopieren)
  [switch]$NoBrowser         # Browser nicht öffnen
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

# ---------- Browser wählen ----------
# Unterstützt: Chromium-Browser (laden entpackte Manifest-V3-Erweiterungen). Firefox nicht –
# dort lassen sich unsignierte Erweiterungen nur vorübergehend laden.
$browsers = @(
  @{ id = 'chrome';  name = 'Google Chrome'; exe = 'chrome.exe';   page = 'chrome://extensions/'
     paths = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
     devmode = 'Oben rechts "Entwicklermodus" einschalten' },
  @{ id = 'edge';    name = 'Microsoft Edge'; exe = 'msedge.exe';  page = 'edge://extensions/'
     paths = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
     devmode = 'Links in der Seitenleiste "Entwicklermodus" einschalten' },
  @{ id = 'brave';   name = 'Brave';          exe = 'brave.exe';   page = 'brave://extensions/'
     paths = @("$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe", "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe", "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe")
     devmode = 'Oben rechts "Entwicklermodus" einschalten' },
  @{ id = 'opera';   name = 'Opera';          exe = 'launcher.exe'; page = 'opera://extensions/'
     paths = @("$env:LOCALAPPDATA\Programs\Opera\launcher.exe", "$env:LOCALAPPDATA\Programs\Opera\opera.exe", "$env:ProgramFiles\Opera\launcher.exe")
     devmode = 'Oben rechts "Entwicklermodus" einschalten' },
  @{ id = 'operagx'; name = 'Opera GX';       exe = 'launcher.exe'; page = 'opera://extensions/'
     paths = @("$env:LOCALAPPDATA\Programs\Opera GX\launcher.exe", "$env:LOCALAPPDATA\Programs\Opera GX\opera.exe", "$env:ProgramFiles\Opera GX\launcher.exe")
     devmode = 'Oben rechts "Entwicklermodus" einschalten' },
  @{ id = 'vivaldi'; name = 'Vivaldi';        exe = 'vivaldi.exe'; page = 'vivaldi://extensions/'
     paths = @("$env:LOCALAPPDATA\Vivaldi\Application\vivaldi.exe", "$env:ProgramFiles\Vivaldi\Application\vivaldi.exe")
     devmode = 'Oben rechts "Entwicklermodus" einschalten' }
)

function Find-BrowserExe($b) {
  foreach ($p in $b.paths) { if ($p -and (Test-Path $p)) { return $p } }
  # Registrierte Programmpfade (z. B. bei Installation in einen anderen Ordner); Opera nutzt hier opera.exe
  if ($b.id -notlike 'opera*') {
    foreach ($key in "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$($b.exe)",
                     "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$($b.exe)",
                     "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\$($b.exe)") {
      try { $v = (Get-ItemProperty -Path $key -ErrorAction Stop).'(default)'; if ($v -and (Test-Path $v)) { return $v } } catch { }
    }
  }
  return $null
}

# Standardbrowser aus der Windows-Einstellung für https-Links
$defaultId = $null
$defaultName = $null
try {
  $progId = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -ErrorAction Stop).ProgId
  switch -Regex ($progId) {
    '^ChromeHTML'     { $defaultId = 'chrome' }
    '^MSEdgeHTM'      { $defaultId = 'edge' }
    '^BraveHTML'      { $defaultId = 'brave' }
    '^OperaGXStable'  { $defaultId = 'operagx' }
    '^Opera'          { if (-not $defaultId) { $defaultId = 'opera' } }
    '^VivaldiHTM'     { $defaultId = 'vivaldi' }
    '^FirefoxURL'     { $defaultName = 'Firefox' }
  }
} catch { }

foreach ($b in $browsers) { $b.path = Find-BrowserExe $b }
$installed = @($browsers | Where-Object { $_.path })

# Vorauswahl: Standardbrowser, sonst der erste installierte
$preset = $browsers | Where-Object { $_.id -eq $defaultId -and $_.path } | Select-Object -First 1
if (-not $preset) { $preset = $installed | Select-Object -First 1 }
if ($defaultId) { $defaultName = ($browsers | Where-Object { $_.id -eq $defaultId }).name }

$chosen = $null
if ($Browser) {
  $chosen = $browsers | Where-Object { $_.id -eq $Browser } | Select-Object -First 1
} else {
  Say ''
  if ($defaultName) { Say "  Dein Standardbrowser: $defaultName" }
  if ($defaultName -eq 'Firefox') { Say '  (Firefox kann diese Erweiterung nicht dauerhaft laden – bitte einen anderen wählen.)' 'Yellow' }
  Say '  In welchem Browser soll die Erweiterung laufen?' 'Cyan'
  for ($i = 0; $i -lt $browsers.Count; $i++) {
    $b = $browsers[$i]
    $mark = ''
    if (-not $b.path) { $mark = '  (nicht gefunden)' }
    if ($preset -and $b.id -eq $preset.id) { $mark += '  ← Enter' }
    $color = 'Gray'; if (-not $b.path) { $color = 'DarkGray' }
    Say ("   {0}  {1}{2}" -f ($i + 1), $b.name, $mark) $color
  }
  while (-not $chosen) {
    $answer = (Read-Host '  Nummer eingeben (Enter = Vorschlag)').Trim()
    if (-not $answer -and $preset) { $chosen = $preset; break }
    $n = 0
    if ([int]::TryParse($answer, [ref]$n) -and $n -ge 1 -and $n -le $browsers.Count) {
      $chosen = $browsers[$n - 1]
      if (-not $chosen.path) { Say "  Hinweis: $($chosen.name) wurde nicht gefunden – die Seite musst du dann selbst öffnen." 'Yellow' }
    } else {
      Say '  Bitte eine Zahl aus der Liste eingeben.' 'Yellow'
    }
  }
}
Say "  Gewählt: $($chosen.name)" 'Green'

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
$cfg = [ordered]@{ repo = $Repo; branch = $Branch; browser = $chosen.id }
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
    # Einmal täglich um 10:00 – war der PC zu der Zeit aus, läuft es beim nächsten Start (StartWhenAvailable)
    $daily    = New-ScheduledTaskTrigger -Daily -At '10:00'
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $daily -Settings $settings `
      -Description 'Holt einmal täglich neue Versionen der Browser-Erweiterung Idealo-Preischeck von GitHub.' -Force | Out-Null
    Say '  Automatische Updates: einmal täglich (10:00 oder beim nächsten Start)' 'Green'
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

# ---------- Browser: einmalig entpackt laden ----------
Set-Clipboard -Value $extDir

Say ''
Say "  Letzter Schritt in $($chosen.name) (nur dieses eine Mal):" 'Cyan'
Say "   1. Die Seite $($chosen.page) öffnet sich gleich (sonst in die Adresszeile tippen)"
Say "   2. $($chosen.devmode)"
Say '   3. "Entpackte Erweiterung laden" klicken'
Say '   4. Im Ordner-Dialog oben in die Adresszeile klicken, Strg+V, Enter, "Ordner auswählen"'
Say "      (der Pfad ist schon in der Zwischenablage: $extDir)"
Say '   5. Eine ältere, von Hand geladene Version der Erweiterung dort entfernen'
Say ''
Say '  Danach aktualisiert sich die Erweiterung von selbst.' 'Green'
Say "  Jetzt sofort aktualisieren: $InstallDir\update-jetzt.cmd"
Say ''

if (-not $NoBrowser) {
  if ($chosen.path) {
    try { Start-Process -FilePath $chosen.path -ArgumentList $chosen.page }
    catch { Say "  $($chosen.name) ließ sich nicht starten – bitte $($chosen.page) selbst öffnen." 'Yellow' }
  } else {
    Say "  $($chosen.name) nicht gefunden – bitte $($chosen.page) selbst öffnen." 'Yellow'
  }
}
