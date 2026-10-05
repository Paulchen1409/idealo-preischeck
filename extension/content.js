// Fügt auf Amazon-Produktseiten unter dem Preis einen Idealo-Button ein.
// Klick öffnet das Preis-Panel (dieselbe Oberfläche wie das Erweiterungs-Popup) direkt auf der Seite.
(() => {
  'use strict';
  if (window.top !== window) return; // nicht in Amazon-iframes

  const DEFAULTS = { showButton: true, autoCheck: true, sort: 'total', freeShipOnly: false };
  const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
  const PRICE_ANCHORS = [
    '#corePriceDisplay_desktop_feature_div',
    '#corePrice_desktop',
    '#corePrice_feature_div',
    '#apex_desktop',
    '#price',
  ];

  let settings = { ...DEFAULTS };
  let btnHost = null;   // Button (Shadow DOM)
  let btnLabel = null;
  let btnBadge = null;
  let panelHost = null; // Panel mit iframe (Shadow DOM)
  let iframe = null;
  let isOpen = false;
  let currentAsin = null;
  let asinSince = 0;     // Zeitpunkt des letzten Produkt-/Variantenwechsels
  const VARIANT_DELAY_MS = 500; // nur nach Variantenwechsel; beim ersten Laden wird sofort geprüft
  const TICK_MS = 300;
  let checkedAsin = null; // für welches Produkt die automatische Prüfung schon lief
  let lastCheck = null;   // { offers, ld, amzPrice } – für Neuberechnung bei geänderten Einstellungen

  const fmt = (n) => n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
  const getAsin = () => (location.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i) || [])[1] || '';
  const isProductPage = () => !!document.getElementById('productTitle') && !!getAsin();

  function findAnchor() {
    for (const sel of PRICE_ANCHORS) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null && el.textContent.includes('€')) return el;
    }
    return null;
  }

  // ---------- Button ----------

  function createButton() {
    btnHost = document.createElement('div');
    btnHost.id = 'idealo-preischeck-button';
    const root = btnHost.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { display: block; margin: 6px 0 10px; }
        button {
          all: unset; box-sizing: border-box; cursor: pointer;
          display: inline-flex; align-items: center; gap: 8px;
          padding: 6px 12px 6px 10px; border-radius: 999px;
          background: #0a3761; color: #fff;
          font: 600 13px/1.2 "Amazon Ember", Arial, sans-serif;
          box-shadow: 0 1px 2px rgba(0,0,0,.15);
          transition: background .15s;
        }
        button:hover { background: #0d4a82; }
        button:focus-visible { outline: 2px solid #ff6600; outline-offset: 2px; }
        .dot { width: 9px; height: 9px; border-radius: 50%; background: #ff6600; flex: none; }
        .badge {
          font-weight: 700; font-size: 12px; padding: 2px 7px; border-radius: 999px;
          background: rgba(255,255,255,.16);
        }
        .badge:empty { display: none; }
        .badge.good { background: #1f9d55; }
        .badge.bad  { background: rgba(255,255,255,.16); color: #ffd2c2; }
        .spin {
          width: 10px; height: 10px; border: 2px solid rgba(255,255,255,.35);
          border-top-color: #fff; border-radius: 50%; animation: s .8s linear infinite;
        }
        @keyframes s { to { transform: rotate(360deg); } }
      </style>
      <button type="button" title="Preise auf Idealo vergleichen">
        <span class="dot"></span>
        <span class="label">Idealo-Preis prüfen</span>
        <span class="badge"></span>
      </button>`;
    btnLabel = root.querySelector('.label');
    btnBadge = root.querySelector('.badge');
    root.querySelector('button').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isOpen ? closePanel() : openPanel();
    });
  }

  let buttonState = { state: 'idle', msg: {} }; // letzter Zustand – auch wenn der Button noch nicht steht

  function setButtonState(state, msg = {}) {
    buttonState = { state, msg };
    if (!btnHost) return; // wird beim Einfügen nachgeholt
    btnBadge.className = 'badge';
    btnBadge.textContent = '';
    if (state === 'loading') {
      btnLabel.textContent = 'Idealo';
      btnBadge.innerHTML = '<span class="spin"></span>';
      btnBadge.className = 'badge';
    } else if (state === 'ok') {
      const kind = msg.kind === 'price' ? 'Artikel' : 'inkl. Versand';
      btnLabel.textContent = `Idealo: ${fmt(msg.value)} ${kind}`;
      if (msg.diff != null && msg.diff > 0.009) {
        btnBadge.textContent = `${fmt(msg.diff)} günstiger`;
        btnBadge.classList.add('good');
      } else if (msg.diff != null && msg.diff < -0.009) {
        btnBadge.textContent = 'Amazon günstiger';
        btnBadge.classList.add('bad');
      } else if (msg.diff != null) {
        btnBadge.textContent = 'gleicher Preis';
      }
    } else if (state === 'choose') {
      btnLabel.textContent = 'Idealo: Produkt wählen';
    } else if (state === 'none') {
      btnLabel.textContent = 'Idealo: kein Treffer';
    } else if (state === 'error') {
      btnLabel.textContent = 'Idealo: Fehler – klicken';
    } else {
      btnLabel.textContent = 'Idealo-Preis prüfen';
    }
  }

  function insertButton() {
    const anchor = findAnchor();
    if (!anchor) return false;
    if (!btnHost) {
      createButton();
      setButtonState(buttonState.state, buttonState.msg); // Ergebnis kam evtl. schon vor dem Button
    }
    if (btnHost.previousElementSibling !== anchor) anchor.insertAdjacentElement('afterend', btnHost);
    return true;
  }

  // ---------- Panel ----------

  function ensurePanel() {
    if (panelHost) return;
    panelHost = document.createElement('div');
    panelHost.id = 'idealo-preischeck-panel';
    const root = panelHost.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host {
          position: absolute; z-index: 2147483000; width: 380px;
          border-radius: 12px; overflow: hidden;
          box-shadow: 0 12px 32px rgba(0,0,0,.28), 0 0 0 1px rgba(0,0,0,.08);
          background: #fff;
          visibility: hidden; opacity: 0; pointer-events: none;
          transform: translateY(-4px); transition: opacity .12s, transform .12s;
        }
        :host(.open) { visibility: visible; opacity: 1; pointer-events: auto; transform: none; }
        iframe { display: block; width: 380px; height: 220px; border: 0; }
      </style>`;
    iframe = document.createElement('iframe');
    iframe.title = 'Idealo-Preisvergleich';
    const data = scrapeAmazon();
    iframe.src = chrome.runtime.getURL('popup.html') +
      `?embed=1&origin=${encodeURIComponent(location.origin)}#${encodeURIComponent(JSON.stringify(data))}`;
    root.appendChild(iframe);
    document.body.appendChild(panelHost);
    if (!settings.autoCheck) setButtonState('loading');
  }

  function positionPanel() {
    if (!panelHost || !btnHost) return;
    const r = btnHost.shadowRoot.querySelector('button').getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, document.documentElement.clientWidth - 388));
    panelHost.style.top = `${r.bottom + window.scrollY + 6}px`;
    panelHost.style.left = `${left + window.scrollX}px`;
  }

  function openPanel() {
    ensurePanel();
    positionPanel();
    panelHost.classList.add('open');
    isOpen = true;
  }

  function closePanel() {
    if (panelHost) panelHost.classList.remove('open');
    isOpen = false;
  }

  function resetForNewProduct() {
    closePanel();
    if (panelHost) panelHost.remove();
    panelHost = null;
    iframe = null;
    lastCheck = null;
    setButtonState('idle');
  }

  // ---------- Automatische Prüfung beim Laden der Seite ----------
  // Läuft direkt hier im Content-Script (Laden über den Hintergrund-Worker, Auswertung mit idealo.js),
  // damit der Button den Preis zeigt, ohne dass man klicken muss.

  async function autoCheck(asin) {
    checkedAsin = asin;
    setButtonState('loading');
    try {
      const data = scrapeAmazon();
      const found = await findProduct(data);
      if (asin !== currentAsin) return; // inzwischen andere Variante gewählt
      if (!found.url) { setButtonState(found.matches.length ? 'choose' : 'none'); return; }
      const doc = found.doc || (await fetchHtml(found.url)).doc;
      if (asin !== currentAsin) return;
      // Amazon-Preis erst jetzt lesen: Bei Varianten lädt Amazon ihn oft erst nach
      const amzPrice = parseEuro(scrapeAmazon().priceText) ?? parseEuro(data.priceText);
      lastCheck = { offers: parseOffers(doc), ld: parseJsonLd(doc), amzPrice };
      const best = computeBest(lastCheck.offers, lastCheck.ld, settings, lastCheck.amzPrice);
      setButtonState(best.state, best);
    } catch (err) {
      console.warn('[Idealo-Preischeck]', err);
      if (asin === currentAsin) setButtonState('error');
    }
  }

  // Nachrichten aus dem Panel
  window.addEventListener('message', (e) => {
    if (!iframe || e.source !== iframe.contentWindow || e.origin !== EXT_ORIGIN) return;
    const m = e.data;
    if (!m || m.source !== 'idealo-preischeck') return;
    if (m.type === 'best') setButtonState(m.state || (m.value != null ? 'ok' : 'none'), m);
    else if (m.type === 'height') iframe.style.height = `${Math.min(Math.max(m.height, 120), 600)}px`;
    else if (m.type === 'close') closePanel();
  });

  // Klick daneben oder Escape schließt das Panel
  document.addEventListener('mousedown', (e) => {
    if (!isOpen) return;
    const path = e.composedPath();
    if (path.includes(panelHost) || path.includes(btnHost)) return;
    closePanel();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen) closePanel(); });
  window.addEventListener('resize', () => isOpen && positionPanel());

  // ---------- Steuerung ----------

  function tick() {
    if (!settings.showButton || !isProductPage()) {
      if (btnHost?.isConnected) btnHost.remove();
      if (isOpen) closePanel();
      return;
    }
    const asin = getAsin();
    if (asin !== currentAsin) {
      // Erster Aufruf: Seite ist fertig geladen → sofort prüfen.
      // Variantenwechsel: Amazon tauscht EAN/Details kurz nach → kurz warten, sonst suchen wir die alte Variante.
      asinSince = currentAsin === null ? -Infinity : Date.now();
      currentAsin = asin;
      resetForNewProduct();
    }
    // Prüfung braucht den Button nicht – sofort starten, Ergebnis erscheint, sobald der Button steht
    if (settings.autoCheck && checkedAsin !== asin && Date.now() - asinSince >= VARIANT_DELAY_MS) autoCheck(asin);
    insertButton();
  }

  chrome.storage.sync.get(DEFAULTS).then((s) => {
    settings = { ...DEFAULTS, ...s };
    tick();
    // Variantenwechsel und nachgeladene Preise erkennen (billig: nur URL und ein paar Selektoren)
    setInterval(tick, TICK_MS);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const k of Object.keys(DEFAULTS)) if (changes[k]) settings[k] = changes[k].newValue;
    // Sortierung / Versandfilter geändert → Button-Preis neu berechnen
    if ((changes.sort || changes.freeShipOnly) && lastCheck) {
      const best = computeBest(lastCheck.offers, lastCheck.ld, settings, lastCheck.amzPrice);
      setButtonState(best.state, best);
    }
    tick();
  });
})();
