# Amazon → Idealo Preischeck

Chrome-Erweiterung (Manifest V3), die Amazon-Preise mit Idealo vergleicht.

## Installation

1. `chrome://extensions` öffnen, oben rechts **Entwicklermodus** einschalten.
2. **Entpackte Erweiterung laden** und diesen Ordner wählen.
3. Nach Updates dort auf ↻ klicken und offene Amazon-Tabs neu laden.

## Funktionen

| Wo | Was |
|---|---|
| Produktseite | Button unter dem Preis mit Idealo-Bestpreis; Klick öffnet das Panel mit Angeboten und Preisverlauf |
| Suche | Etikett je Ergebnis; Preis wird erst nach 500 ms Hover (oder Klick) geladen |
| Warenkorb | Banner über der Kasse mit Gesamtersparnis, live während des Scans; Etikett an jedem Artikel |
| Popup (Icon) | Gleiche Ansicht wie das Panel, plus Einstellungen (⚙) |

## Dateien

| Datei | Läuft in | Aufgabe |
|---|---|---|
| `manifest.json` | – | Rechte, Content-Scripts je Seitentyp |
| `background.js` | Service Worker | Netzwerk-Schicht: Prioritäts-Warteschlange, Drosselung, Cache, Abbruch, ASIN-Cache |
| `idealo.js` | überall | Gemeinsame Logik: Suche, Treffer-Prüfung, Angebote, Preisverlauf, Bestpreis |
| `scrape.js` | Produktseite, Warenkorb, Popup | Amazon-Produktdaten (Titel, Preis, EAN, Marke, Modell) |
| `content.js` | Produktseite | Button unter dem Preis, automatische Prüfung, Panel |
| `search.js` | Suchseiten | Hover-Etiketten |
| `cart.js` | Warenkorb | Banner, Scan-Arbeiter, MutationObserver |
| `popup.html/.css/.js` | Popup und Panel | Angebotsliste, Einstellungen |
| `sparkline.js` | Popup und Panel | Preisverlauf als SVG-Kurve |

## Warteschlange (background.js)

Content-Scripts dürfen idealo.de wegen CORS nicht direkt abfragen; der Service Worker darf es über
`host_permissions`. Deshalb läuft **jede** Idealo-Anfrage über ihn:

1. **Cache** (10 Min.) → sofortige Antwort.
2. **Gleiche URL läuft schon** → an die laufende Anfrage anhängen (keine Doppelabfrage).
3. **Warteschlange mit zwei Spuren**
   - `high`: jemand wartet (Hover, Produktseite, Panel), Abstand ≥ 400 ms
   - `low`: Stapelarbeit (Warenkorb), Abstand ≥ 900 ms, läuft nur, wenn `high` leer ist
   - Es läuft immer nur **eine** Anfrage gleichzeitig. Kommt dieselbe URL mit `high`, wird ein wartender `low`-Auftrag hochgestuft.
4. **Bremse**: Antwortet Idealo mit 429/403, werden alle Wartenden sofort informiert und 60 s lang keine Anfragen gestellt. Der Warenkorb-Check pausiert und macht danach beim selben Artikel weiter.
5. **Abbruch**: Die Warenkorb-Seite hält einen Port offen. Wird sie geschlossen oder neu geladen, verwirft der Worker ihre wartenden `low`-Aufträge.
6. **ASIN-Cache** (`chrome.storage.session`, 30 Min.): Ergebnis je Amazon-Artikel, gemeinsam für Suche und Warenkorb; übersteht Neustarts des Service Workers.

Ausgewertet (DOMParser) wird im Content-Script, weil Service Worker kein DOM haben.

## Warenkorb-Check (cart.js)

**Geschwindigkeit** (gemessen/simuliert für 7 Artikel inkl. Bündel = 9 Amazon-Seiten, 14 Idealo-Abfragen):

| | erstes Öffnen | erneut öffnen |
|---|---|---|
| bis 1.4.1 | ~23,5 s | ~23,5 s |
| ab 1.5.0 | ~11 s | ~8 s; Ergebnisse < 24 h sofort, < 30 Min. ganz ohne Abfrage |

- Amazon-Details werden für alle Artikel vorab und bis zu 4 parallel geholt (gemessen: 4 Seiten in 1,6 s statt 6,9 s nacheinander) und 7 Tage in `storage.local` gemerkt.
- Idealo bleibt bewusst seriell (Schutz vor Sperren), Mindestabstand im Warenkorb 600 ms.
- Stale-while-revalidate: Ergebnisse bis 24 h alt erscheinen sofort, werden danach im Hintergrund aufgefrischt.


- **Auslesen**: Amazon liefert pro Artikel `data-asin`, `data-price`, `data-quantity`, `data-producttitle`, `data-isselected`. Nur ausgewählte Artikel zählen zur Ersparnis.
- **Arbeiter**: genau ein Artikel zur Zeit, ausgewählte zuerst:
  ASIN-Cache → Amazon-Produktseite (EAN/Modell) → Idealo-Suche → Idealo-Angebote.
  Von der ~2,7 MB großen Amazon-Seite wird nur der Detail-Ausschnitt (~450 KB) geparst (~10 ms).
- **MutationObserver**: Der Callback setzt nur einen Timer (400 ms); `reconcile()` vergleicht dann den Warenkorb. Neue Artikel → Warteschlange; gelöschte → raus; Menge/Preis/Auswahl → nur neu rechnen, keine neue Anfrage. Eigene Elemente (Banner, Etiketten) werden ignoriert.
- **Bündel**: Amazon-Bündel werden über die Bündel-Produktseite in ihre Bestandteile zerlegt (ASIN, Anzahl).
  Jedes Teil wird mit eigener EAN bei Idealo gesucht; verglichen wird Bündelpreis gegen Σ (Anzahl × Idealo-Bestpreis).
  Fehlt ein Teil bei Idealo, zählt das Bündel nicht zur Ersparnis (sonst wäre der Vergleich unfair).
- **Zeichnen**: höchstens einmal pro Frame (`requestAnimationFrame`); in Hintergrund-Tabs gar nicht.
- **Rechnung**: Ersparnis = (Amazon-Preis − Idealo-Bestpreis) × Menge, nur wenn Idealo günstiger ist. Der Idealo-Preis enthält je Stück den Versand; bei mehreren Stück ist das eher vorsichtig gerechnet, weil Shops den Versand meist nur einmal berechnen.

## Suche: doppelte Produkte

Dasselbe Produkt kann mehrfach auf der Suchseite stehen (z. B. „Gesponsert“ und normal). Zustand und
Ergebnis gibt es deshalb einmal pro ASIN, Etiketten einmal pro Suchergebnis; ein Ergebnis mit Etikett
bekommt nie ein zweites. Beobachter (Suche, Warenkorb) arbeiten mit begrenzter Verzögerung statt mit
einem bei jeder Änderung neu startenden Timer, damit sie auch auf Seiten mit Dauer-Änderungen laufen.

## Preisverlauf

Idealos Preisverlaufs-Dienst (`/price-chart/…/history`) antwortet nur Anfragen von idealo.de selbst
(gemessen in Brave: von idealo.de 200, von amazon.de 503, aus der Erweiterung ein leeres 404 – auch mit
angepassten Headern). Deshalb:

1. `background.js` legt ein Offscreen-Dokument (`offscreen.html`) an, das `https://www.idealo.de/robots.txt`
   in einen Rahmen lädt – die einzige Idealo-Adresse ohne `X-Frame-Options`.
2. `idealo-frame.js` läuft als Content-Script in diesem Rahmen (nur wenn der übergeordnete Rahmen unsere
   Erweiterung ist), verbindet sich per Port mit dem Worker und holt Verlaufs-URLs als same-origin-Anfrage.
3. Klappt das nicht, folgt ein direkter Abruf mit angepassten Headern (Sitzungsregel, nur für Worker-Anfragen).

## Prime-Check (Warenkorb)

Frage: Lohnt es sich, bis zum nächsten Prime-Event zu warten? (`prime.js`, Anzeige in `cart.js`)

- **Termine** stehen in `PRIME_EVENTS` (Quelle: Amazons Pressemitteilungen). Neue Termine kommen per Update.
  Ist kein Termin angekündigt, wird das letzte Event derselben Art + 52 Wochen als „voraussichtlich" gezeigt.
- **Daten:** Idealo-Preisverlauf mit `period=2Y` – täglich, reicht ca. 15 Monate zurück (also über das
  letzte gleichartige Event hinaus). Idealo erfasst Prime-Angebote (gemessen Prime Day 2026: Echo Dot −46 %,
  Fire TV Stick −19 %, Kindle Paperwhite −15 %).
- **Je vergangenem Event:** Normalpreis = Median Tag −37…−8 vor Start; Prime-Preis = Minimum von Tag −7
  (frühe Angebote) bis Event-Ende; Rabatt = 1 − Prime-Preis / Normalpreis (< 2 % zählt als 0).
- **Schätzung:** Rabatt des letzten Events derselben Art (sonst des jüngsten) × heutiger Bestpreis
  (min. Amazon, Idealo) – höchstens bis auf den damaligen Prime-Preis. Ein Produkt, das vor einem Jahr nur
  allgemein billiger war, gilt so nicht als „Warten lohnt sich".
- **Anzeige:** zählt Artikel mit Ersparnis ≥ max(1 €, 3 %); Bündel = Summe der Teile. Läuft das Event gerade,
  wird keine Ersparnis versprochen. Ergebnisse je Produkt 12 h in `storage.local`.

## Grenzen

- Idealo hat keine offizielle Schnittstelle; Angebote werden aus der Webseite gelesen, der Preisverlauf kommt von der internen Schnittstelle der Idealo-Kurve. Ändert Idealo etwas, zeigen Button und Panel einen Hinweis statt falscher Werte.
- In der Suche gibt es keine EAN, dort wird nur über den Titel gesucht.
- Prime-Check: Schätzung aus der Vergangenheit, keine Garantie. Neue Produkte (jünger als das letzte Event) haben keine Daten.
- Idealo-Einzelangebote ohne Shopnamen (oft Amazon selbst) werden bewusst nicht als Treffer gewertet.
