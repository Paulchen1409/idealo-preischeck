# Idealo-Preischeck für Amazon

Chrome-Erweiterung, die Amazon-Preise mit Idealo vergleicht: Button und Preisverlauf auf Produktseiten,
Etiketten in der Suche, Spar-Check im Warenkorb – und ein Prime-Check, ob sich Warten bis zum nächsten
Prime Day / den Prime Deal Days lohnt. Technische Details: [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md).

## Installation unter Windows (ohne Web Store)

Läuft in Chromium-Browsern: **Chrome, Edge, Brave, Opera, Opera GX, Vivaldi**. (Firefox nicht – dort lassen sich
unsignierte Erweiterungen nur vorübergehend laden.)

1. Repo als ZIP herunterladen (**Code → Download ZIP**) und entpacken.
2. `windows\config.json` zeigt bereits auf dieses Repo (`Paulchen1409/idealo-preischeck`) – bei einem Fork dort den eigenen Namen eintragen.
3. `windows\install.cmd` doppelklicken. Das Skript
   - fragt nach dem Browser – dein Windows-Standardbrowser ist vorausgewählt (Enter),
   - kopiert die Erweiterung nach `%LOCALAPPDATA%\IdealoPreischeck\extension`,
   - richtet die automatische Aktualisierung ein (einmal täglich, unsichtbar),
   - öffnet die Erweiterungsseite des gewählten Browsers und legt den Ordnerpfad in die Zwischenablage.
4. **Einmalig im Browser:** Entwicklermodus an → *Entpackte Erweiterung laden* → in der Adresszeile
   des Dialogs `Strg+V`, Enter → *Ordner auswählen*. Eine alte, von Hand geladene Version dort entfernen.

Den Ordner kannst du auch in mehreren Browsern gleichzeitig laden – alle bekommen dieselben Updates.

Keine Administratorrechte nötig. Der Ordner aus Schritt 1 kann danach gelöscht werden.

## Updates

- Die Aufgabe `IdealoPreischeck-Update` läuft einmal täglich um 10:00 (war der PC aus: beim nächsten Start) und vergleicht die Version in `extension/manifest.json` auf GitHub
  mit der installierten. Ist sie neuer, wird der Ordner ausgetauscht.
- Die Erweiterung merkt das selbst (spätestens nach 5 Minuten) und lädt sich neu – kein Klick im Browser nötig.
  Der Browser spielt fürs Update keine Rolle: Das Skript tauscht nur die Dateien im Ordner aus.
- Sofort aktualisieren: `%LOCALAPPDATA%\IdealoPreischeck\update-jetzt.cmd`
- Protokoll: `%LOCALAPPDATA%\IdealoPreischeck\update.log`

### Neue Version veröffentlichen

1. Änderungen im Ordner `extension/` machen.
2. In `extension/manifest.json` die `version` erhöhen (z. B. `1.6.0` → `1.6.1`). **Ohne neue Versionsnummer kein Update.**
3. Auf `main` pushen.

### Privates Repo

Fein granuliertes GitHub-Token mit Leserecht *Contents* für dieses eine Repo erstellen und in
`%LOCALAPPDATA%\IdealoPreischeck\config.json` als `"token": "github_pat_…"` eintragen.
Das Token liegt dort im Klartext – deshalb nur Leserecht und nur für dieses Repo.

## Deinstallieren

1. Im Browser auf der Erweiterungsseite (`chrome://extensions`, `brave://extensions`, …) die Erweiterung entfernen.
2. `%LOCALAPPDATA%\IdealoPreischeck\deinstallieren.cmd` ausführen (entfernt Aufgabe und Ordner).

## Aufbau des Repos

```
extension/   die Chrome-Erweiterung (Manifest V3)
windows/     install.cmd, update.ps1, uninstall.ps1, config.json
docs/        Architektur und Logik
```
