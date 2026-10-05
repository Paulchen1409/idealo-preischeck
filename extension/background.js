// Netzwerk-Schicht der Erweiterung (Service Worker).
//
// Alle Anfragen an Idealo laufen hier durch – aus Popup, Panel, Produktseite, Suche und Warenkorb.
// Content-Scripts dürfen idealo.de wegen CORS nicht direkt abfragen; der Service Worker darf es dank
// host_permissions. Ausgewertet (DOMParser) wird im Content-Script, weil Service Worker kein DOM haben.
//
//  ┌──────────────┐  fetch-idealo {priority}   ┌───────────────────────────────────────┐
//  │ Content-     │ ─────────────────────────▶ │ 1. Cache (10 Min.)        → sofort    │
//  │ Scripts /    │                            │ 2. gleiche URL läuft schon → anhängen │
//  │ Popup        │ ◀───────────────────────── │ 3. Warteschlange: high vor low        │
//  └──────────────┘        Antwort             │    eine Anfrage gleichzeitig,         │
//                                              │    Mindestabstand, Pause bei 429/403  │
//                                              └───────────────────────────────────────┘
//
// Prioritäten:
//   high – jemand wartet gerade darauf (Hover, Produktseite, Panel)
//   low  – Stapelarbeit (Warenkorb-Check); läuft nur, wenn nichts Dringendes ansteht,
//          und mit größerem Abstand, damit ein voller Warenkorb Idealo nicht flutet.
// Abbruch: Wird der Warenkorb-Tab geschlossen oder neu geladen, trennt sich sein Port und alle
// noch wartenden low-Aufträge dieses Tabs fliegen raus.
'use strict';

const IDEALO_ORIGIN = 'https://www.idealo.de';
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 80;
const GAP_MS = { high: 400, low: 600 };   // Mindestabstand vor einer Anfrage dieser Priorität
const COOLDOWN_MS = 60 * 1000;            // Pause nach "zu viele Anfragen"
const ASIN_FRESH_MS = 30 * 60 * 1000;     // Ergebnis pro Amazon-Artikel gilt als aktuell …
const ASIN_KEEP_MS = 24 * 60 * 60 * 1000; // … und wird bis zu 24 h als "alter Stand" aufbewahrt
const DETAILS_KEEP_MS = 7 * 24 * 60 * 60 * 1000; // Amazon-Details (EAN/Modell) in storage.local

const cache = new Map();      // url → { time, response }
const inflight = new Map();   // url → Promise
const lanes = { high: [], low: [] };
let running = false;
let lastRequestAt = 0;
let cooldownUntil = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THROTTLED = { error: 'Idealo bremst gerade zu viele Anfragen – bitte kurz warten.', throttled: true };

// ---------- Cache ----------

function fromCache(url) {
  const hit = cache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_MS) { cache.delete(url); return null; }
  return hit.response;
}

function toCache(url, response) {
  // 404/400 merken wir auch (z. B. "kein Preisverlauf"), Serverfehler nicht
  if (!response.ok && response.status !== 404 && response.status !== 400) return;
  cache.set(url, { time: Date.now(), response });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ---------- Warteschlange ----------

/**
 * Stellt eine Anfrage ein. Gleiche URLs werden zusammengelegt; wartet schon ein low-Auftrag
 * und es kommt dieselbe URL mit high, wird er hochgestuft.
 */
function enqueue(url, priority, tabId) {
  const cached = fromCache(url);
  if (cached) return Promise.resolve(cached);
  if (inflight.has(url)) {
    if (priority === 'high') {
      const i = lanes.low.findIndex((j) => j.url === url);
      if (i >= 0) lanes.high.push(...lanes.low.splice(i, 1));
    }
    return inflight.get(url);
  }

  let job;
  const p = new Promise((resolve) => { job = { url, tabId, resolve }; });
  lanes[priority].push(job);
  inflight.set(url, p);
  p.finally(() => inflight.delete(url));
  pump();
  return p;
}

/** Arbeitet die Warteschlange ab – immer nur eine Anfrage gleichzeitig. */
async function pump() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const priority = lanes.high.length ? 'high' : lanes.low.length ? 'low' : null;
      if (!priority) break;

      // Idealo hat gebremst: nicht stur weiterfeuern, sondern alle Wartenden sofort informieren.
      // Der Warenkorb-Check wartet dann selbst und macht später weiter.
      if (Date.now() < cooldownUntil) {
        for (const lane of [lanes.high, lanes.low]) lane.splice(0).forEach((j) => j.resolve(THROTTLED));
        break;
      }

      const wait = lastRequestAt + GAP_MS[priority] - Date.now();
      if (wait > 0) {
        await sleep(Math.min(wait, 250)); // in kleinen Schritten, damit ein neuer high-Auftrag vorgeht
        continue;
      }
      const job = lanes[priority].shift();
      lastRequestAt = Date.now();
      job.resolve(await doFetch(job.url));
    }
  } finally {
    running = false;
  }
}

async function doFetch(url) {
  try {
    const res = await fetch(url, { credentials: 'include', headers: { Accept: 'text/html,application/json' } });
    if (res.status === 429 || res.status === 403) {
      cooldownUntil = Date.now() + COOLDOWN_MS;
      return THROTTLED;
    }
    const response = { ok: res.ok, status: res.status, url: res.url, html: await res.text() };
    toCache(url, response);
    return response;
  } catch (err) {
    return { error: err.message || 'Netzwerkfehler' };
  }
}

/** Wartende low-Aufträge eines Tabs verwerfen (Warenkorb geschlossen/neu geladen). */
function cancelTab(tabId) {
  const keep = [];
  for (const job of lanes.low) {
    if (job.tabId === tabId) job.resolve({ error: 'abgebrochen', cancelled: true });
    else keep.push(job);
  }
  lanes.low = keep;
}

// ---------- Ergebnis-Cache pro ASIN (überlebt Neustarts des Service Workers) ----------

/**
 * Liefert { data, age } für einen Artikel, wenn das Ergebnis höchstens maxAge alt ist.
 * Ältere Ergebnisse (bis 24 h) bleiben gespeichert, damit der Warenkorb sie sofort zeigen und
 * im Hintergrund aktualisieren kann.
 */
async function asinGet(asin, maxAge = ASIN_FRESH_MS) {
  const key = `asin:${asin}`;
  const { [key]: hit } = await chrome.storage.session.get(key);
  if (!hit) return null;
  const age = Date.now() - hit.time;
  if (age > ASIN_KEEP_MS) { chrome.storage.session.remove(key); return null; }
  return age <= maxAge ? { data: hit.data, age } : null;
}

function asinSet(asin, data) {
  return chrome.storage.session.set({ [`asin:${asin}`]: { time: Date.now(), data } });
}

/** Veraltete Amazon-Details (EAN/Modell, 7 Tage) aus storage.local entfernen */
async function pruneDetails() {
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter((k) => k.startsWith('amzd:') && Date.now() - (all[k]?.time || 0) > DETAILS_KEEP_MS);
  if (old.length) await chrome.storage.local.remove(old);
}
chrome.runtime.onStartup.addListener(pruneDetails);
chrome.runtime.onInstalled.addListener(pruneDetails);

// ---------- Nachrichten ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg?.type) return;

  if (msg.type === 'fetch-idealo') {
    let url;
    try { url = new URL(msg.url); } catch { sendResponse({ error: 'Ungültige Adresse' }); return; }
    if (url.origin !== IDEALO_ORIGIN) { sendResponse({ error: 'Nur idealo.de ist erlaubt' }); return; }
    const priority = msg.priority === 'low' ? 'low' : 'high';
    enqueue(url.href, priority, sender.tab?.id).then(sendResponse);
    return true; // Antwort kommt asynchron
  }

  if (msg.type === 'asin-get' && /^[A-Z0-9]{10}$/.test(msg.asin)) {
    const maxAge = Math.min(Number(msg.maxAge) || ASIN_FRESH_MS, ASIN_KEEP_MS);
    asinGet(msg.asin, maxAge).then(sendResponse, () => sendResponse(null));
    return true;
  }

  if (msg.type === 'asin-set' && /^[A-Z0-9]{10}$/.test(msg.asin)) {
    asinSet(msg.asin, msg.data).then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }
});

// Warenkorb-Seite hält einen Port offen; trennt er sich, verwerfen wir ihre wartenden Aufträge.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'cart' || port.sender?.id !== chrome.runtime.id) return;
  const tabId = port.sender.tab?.id;
  port.onDisconnect.addListener(() => { if (tabId != null) cancelTab(tabId); });
});

// ---------- Selbst-Neuladen bei Installation ohne Web Store ----------
// Das Windows-Update-Skript tauscht die Dateien im Erweiterungsordner aus (manifest.json zuletzt).
// Entpackt geladene Erweiterungen lesen ihre Dateien direkt von der Festplatte – wir vergleichen
// daher regelmäßig die Version in der manifest.json mit der laufenden und laden uns bei Bedarf neu.
async function checkForUpdatedFiles() {
  try {
    const self = await chrome.management.getSelf();
    if (self.installType !== 'development') return; // nur bei "Entpackte Erweiterung laden"
    const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    const onDisk = (await res.json()).version;
    if (onDisk && onDisk !== chrome.runtime.getManifest().version) chrome.runtime.reload();
  } catch { /* Datei wird evtl. gerade geschrieben – beim nächsten Mal erneut */ }
}
// Wecker nur anlegen, wenn es ihn noch nicht gibt – sonst würde jedes Aufwachen des Workers ihn neu starten
chrome.alarms.get('disk-version').then((a) => { if (!a) chrome.alarms.create('disk-version', { periodInMinutes: 5 }); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'disk-version') checkForUpdatedFiles(); });
// Zusätzlich bei jedem Start des Workers (passiert z. B. bei jeder Amazon-Seite) – kostet nur einen lokalen Dateizugriff
checkForUpdatedFiles();
