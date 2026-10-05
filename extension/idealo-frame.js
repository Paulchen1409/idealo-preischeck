// Läuft in einem unsichtbaren Rahmen mit https://www.idealo.de/robots.txt (siehe offscreen.html).
// Idealos Preisverlaufs-Dienst antwortet nur Anfragen von idealo.de selbst; von hier aus ist die
// Anfrage echt "same-origin". Der Hintergrund-Worker schickt Aufträge über einen Port.
(() => {
  'use strict';
  // Nur im Rahmen unserer Erweiterung arbeiten – nicht, wenn jemand robots.txt normal öffnet
  if (window.top === window) return;
  const extOrigin = new URL(chrome.runtime.getURL('')).origin;
  if (location.ancestorOrigins?.[0] !== extOrigin) return;

  const ALLOWED = /^https:\/\/www\.idealo\.de\/price-chart\//;

  function connect() {
    let port;
    try { port = chrome.runtime.connect({ name: 'idealo-frame' }); } catch { return; } // Erweiterung neu geladen
    port.onMessage.addListener(async ({ id, url }) => {
      if (!ALLOWED.test(url)) { port.postMessage({ id, error: 'Nicht erlaubte Adresse' }); return; }
      try {
        const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
        port.postMessage({ id, ok: res.ok, status: res.status, url: res.url, html: await res.text() });
      } catch (err) {
        port.postMessage({ id, error: err.message || 'Netzwerkfehler' });
      }
    });
    // Der Service Worker schläft zwischendurch ein → dann neu verbinden (weckt ihn bei Bedarf)
    port.onDisconnect.addListener(() => setTimeout(connect, 1000));
  }
  connect();
})();
