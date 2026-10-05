<#
  Idealo-Preischeck – Update von GitHub (Windows)

  Prüft die Version in extension/manifest.json auf GitHub. Ist sie neuer als die installierte,
  wird das Repo als ZIP geladen und der Erweiterungsordner ausgetauscht. manifest.json wird
  zuletzt geschrieben – daran erkennt die Erweiterung die neue Version und lädt sich selbst neu.

  Läuft automatisch über die Aufgabenplanung (bei Anmeldung und alle 3 Stunden).
  Von Hand:  update-jetzt.cmd  (oder: powershell -ExecutionPolicy Bypass -File update.ps1)

  Kompatibel mit Windows PowerShell 5.1.
#>
[CmdletBinding()]
param(
  [switch]$Force,                         # auch ohne neuere Version neu laden
  [switch]$Quiet,                         # keine Ausgabe, nur Protokoll (Aufgabenplanung)
  [string]$InstallDir = $PSScriptRoot,
  [string]$SourceDir                      # Erstinstallation aus einem lokalen Ordner statt von GitHub
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Downloads in PowerShell 5.1 sonst extrem langsam
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$extDir  = Join-Path $InstallDir 'extension'
$logFile = Join-Path $InstallDir 'update.log'

function Write-Log([string]$msg) {
  $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $msg
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  if (-not $Quiet) { Write-Host $msg }
}

function Get-ManifestVersion([string]$dir) {
  $m = Join-Path $dir 'manifest.json'
  if (-not (Test-Path $m)) { return [version]'0.0.0' }
  return [version]((Get-Content $m -Raw -Encoding UTF8 | ConvertFrom-Json).version)
}

# Erweiterungsordner austauschen. manifest.json kommt ganz zum Schluss, damit Chrome nie eine
# halb kopierte Version lädt.
function Sync-Extension([string]$src, [string]$dst) {
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  $robocopy = Get-Command robocopy.exe -ErrorAction SilentlyContinue
  if ($robocopy) {
    & robocopy.exe $src $dst /MIR /XF manifest.json /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Kopieren fehlgeschlagen (robocopy $LASTEXITCODE)" }
  } else {
    Get-ChildItem $dst -Force | Where-Object { $_.Name -ne 'manifest.json' } | Remove-Item -Recurse -Force
    Get-ChildItem $src -Force | Where-Object { $_.Name -ne 'manifest.json' } | Copy-Item -Destination $dst -Recurse -Force
  }
  Copy-Item (Join-Path $src 'manifest.json') (Join-Path $dst 'manifest.json') -Force
}

# Nur ein Update gleichzeitig (Aufgabenplanung + Doppelklick)
$mutex = New-Object System.Threading.Mutex($false, 'Local\IdealoPreischeckUpdate')
if (-not $mutex.WaitOne(0)) { if (-not $Quiet) { Write-Host 'Update läuft bereits.' }; exit 0 }

$tmp = $null
try {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $local = Get-ManifestVersion $extDir

  # --- Erstinstallation aus lokalem Ordner ---
  if ($SourceDir) {
    $srcVersion = Get-ManifestVersion $SourceDir
    if ($Force -or $srcVersion -gt $local) {
      Sync-Extension $SourceDir $extDir
      Write-Log "Installiert aus lokalem Ordner: Version $srcVersion"
    }
    exit 0
  }

  # --- Update von GitHub ---
  $config = Get-Content (Join-Path $InstallDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $repo   = $config.repo
  $branch = 'main'
  if ($config.branch) { $branch = $config.branch }
  if ($repo -notmatch '^[\w.-]+/[\w.-]+$') { throw "Ungültiges Repo in config.json: '$repo'" }

  $headers = @{ 'User-Agent' = 'IdealoPreischeck-Updater'; 'Accept' = 'application/vnd.github+json' }
  if ($config.token) { $headers['Authorization'] = "Bearer $($config.token)" }   # nur für private Repos nötig
  $apiBase = 'https://api.github.com'
  if ($config.apiBase) { $apiBase = $config.apiBase.TrimEnd('/') }   # z. B. GitHub Enterprise
  $api = "$apiBase/repos/$repo"

  # Version auf GitHub: nur die eine Datei, nicht das ganze Repo
  $file = Invoke-RestMethod -Uri "$api/contents/extension/manifest.json?ref=$branch" -Headers $headers
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($file.content -replace '\s', '')))
  $remote = [version](($json | ConvertFrom-Json).version)

  if (-not $Force -and $remote -le $local) {
    Write-Log "Aktuell (installiert $local, GitHub $remote)"
    exit 0
  }

  Write-Log "Neue Version gefunden: $local -> $remote. Lade herunter ..."
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('idealo-update-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'repo.zip'
  Invoke-WebRequest -Uri "$api/zipball/$branch" -Headers $headers -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'x') -Force

  # GitHub packt alles in einen Ordner "besitzer-repo-commit"
  $root = Get-ChildItem (Join-Path $tmp 'x') -Directory | Select-Object -First 1
  $src  = Join-Path $root.FullName 'extension'
  if (-not (Test-Path (Join-Path $src 'manifest.json'))) { throw 'Im Repo fehlt extension/manifest.json' }
  if ((Get-ManifestVersion $src) -ne $remote) { throw 'Heruntergeladene Version passt nicht zur Versionsangabe' }

  Sync-Extension $src $extDir

  # Die Skripte selbst mit aktualisieren (dieses Skript ist bereits geladen, Überschreiben ist unkritisch)
  foreach ($f in 'update.ps1', 'uninstall.ps1', 'run-hidden.vbs', 'update-jetzt.cmd', 'deinstallieren.cmd') {
    $p = Join-Path (Join-Path $root.FullName 'windows') $f
    if (Test-Path $p) { Copy-Item $p (Join-Path $InstallDir $f) -Force }
  }

  Write-Log "Aktualisiert auf Version $remote. Chrome lädt die Erweiterung in den nächsten Minuten selbst neu."
}
catch {
  $msg = $_.Exception.Message
  if ($msg -match '404') { $msg = "GitHub meldet 'nicht gefunden'. Repo-Name in config.json prüfen ($repo) – bei einem privaten Repo wird ein Token benötigt." }
  elseif ($msg -match '403|rate limit') { $msg = "GitHub verweigert gerade den Zugriff (Abfrage-Limit oder fehlende Rechte). Später erneut versuchen. ($msg)" }
  elseif ($msg -match 'remote name|resolve|Verbindung|connect') { $msg = "Keine Verbindung zu GitHub. ($msg)" }
  Write-Log "FEHLER: $msg"
  exit 1
}
finally {
  if ($tmp -and (Test-Path $tmp)) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  # Protokoll kurz halten
  if (Test-Path $logFile) {
    $lines = Get-Content $logFile -Encoding UTF8
    if ($lines.Count -gt 300) { $lines | Select-Object -Last 200 | Set-Content $logFile -Encoding UTF8 }
  }
  $mutex.ReleaseMutex()
}
