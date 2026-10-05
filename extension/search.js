// Idealo-Etiketten in der Amazon-Suche – Preise werden erst bei Bedarf geladen ("Hover-to-Fetch").
//
// Jedes Suchergebnis bekommt ein kleines Etikett unter dem Preis. Geladen wird erst, wenn die Maus
// mindestens 500 ms auf dem Etikett oder dem Produktbild bleibt (oder beim Klick aufs Etikett).
// So entstehen nur Anfragen für Produkte, die einen wirklich interessieren; der Hintergrund-Worker
// reiht sie zusätzlich in eine Warteschlange mit Mindestabstand ein.
//
// Aufbau: Dasselbe Produkt kann mehrfach auf der Seite stehen (z. B. "Gesponsert" und normal).
// Deshalb gibt es pro ASIN genau EINEN Eintrag (Zustand, Ergebnis) und pro Suchergebnis eine
// Ansicht (Etikett). Ein Suchergebnis, das schon ein Etikett hat, bekommt nie ein zweites.
(() => {
  'use strict';
  if (window.top !== window) return;

  const HOVER_DELAY_MS = 500;
  const DEFAULTS = { searchLabels: true, sort: 'total', freeShipOnly: false };
  const ITEM_SEL = '[data-component-type="s-search-result"][data-asin]';
  const LABEL_CLASS = 'idealo-preischeck-label';

  let settings = { ...DEFAULTS };
  const entries = new Map();   // asin → { asin, state, result, offers, ld, amzPrice, productUrl, searchUrl, views:Set }

  const fmt = (n) => n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

  // ---------- Suchergebnis auslesen ----------

  function readItem(el) {
    const recipe = el.querySelector('[data-cy="title-recipe"]') || el;
    // Manche Layouts haben Marke und Titel in getrennten Überschriften
    const parts = [...recipe.querySelectorAll('h2')].map((h) => clean(h.textContent)).filter(Boolean);
    let title = [...new Set(parts)].join(' ').replace(/^Gesponserte Anzeige\s*[–-]\s*/i, '');
    if (!title) title = clean(el.querySelector('img.s-image')?.alt);

    let priceText = '';
    const p = el.querySelector('[data-cy="price-recipe"] .a-price:not(.a-text-price)') ||
              el.querySelector('.a-price:not(.a-text-price)');
    if (p) {
      const off = p.querySelector('.a-offscreen')?.textContent?.trim();
      if (off && /\d/.test(off)) priceText = off;
      else {
        const whole = p.querySelector('.a-price-whole')?.textContent.replace(/[^\d.]/g, '');
        const frac = p.querySelector('.a-price-fraction')?.textContent.replace(/\D/g, '') || '00';
        if (whole) priceText = `${whole},${frac} €`;
      }
    }
    return { asin: el.dataset.asin, title, priceText, brand: '', model: '', ean: '' };
  }

  // ---------- Etikett (Ansicht) ----------

  function getEntry(asin) {
    let entry = entries.get(asin);
    if (!entry) {
      entry = { asin, state: 'idle', views: new Set(), timer: null };
      entries.set(asin, entry);
    }
    return entry;
  }

  function createLabel(entry, el) {
    const host = document.createElement('div');
    host.className = LABEL_CLASS;
    host.style.cssText = 'display:block;margin:4px 0 2px;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .tag {
          all: unset; box-sizing: border-box; cursor: pointer; max-width: 100%;
          display: inline-flex; align-items: center; gap: 6px;
          padding: 2px 8px 2px 6px; border-radius: 999px;
          font: 500 12px/18px "Amazon Ember", Arial, sans-serif;
          color: #0a3761; background: #eef3f9; border: 1px solid #d3deeb;
          transition: background .15s, border-color .15s;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .tag:hover { background: #e2ebf6; border-color: #b9cbe0; }
        .tag:focus-visible { outline: 2px solid #ff6600; outline-offset: 1px; }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: #ff6600; flex: none; }
        .price { font-weight: 700; }
        .badge { font-size: 11px; font-weight: 700; padding: 0 6px; border-radius: 999px; }
        .badge.good { color: #fff; background: #1f9d55; }
        .badge.bad { color: #6b7385; background: #e6e8ee; }
        .muted { color: #6b7385; }
        .spin {
          width: 9px; height: 9px; flex: none; border-radius: 50%;
          border: 2px solid #c9d6e6; border-top-color: #0a3761; animation: s .8s linear infinite;
        }
        @keyframes s { to { transform: rotate(360deg); } }
        :host([data-state="ok"]) .tag { background: #fff; }
      </style>
      <button class="tag" type="button"></button>`;
    const view = { host, ui: root.querySelector('.tag'), el };
    view.ui.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onLabelClick(entry, el);
    });
    hoverTarget(entry, el, host);
    const img = el.querySelector('[data-cy="image-container"], .s-product-image-container');
    if (img) hoverTarget(entry, el, img);
    entry.views.add(view);
    renderView(entry, view);
    return host;
  }

  function render(entry) {
    for (const view of entry.views) {
      if (!view.host.isConnected) entry.views.delete(view); // von Amazon entfernt → vergessen
      else renderView(entry, view);
    }
  }

  function renderView(entry, view) {
    const ui = view.ui;
    view.host.dataset.state = entry.state;
    const r = entry.result;
    let html = '<span class="dot"></span>';
    let title = '';
    switch (entry.state) {
      case 'idle':
        html += '<span class="muted">idealo-Preis prüfen</span>';
        title = 'Maus kurz auf dieses Etikett oder das Produktbild halten (oder klicken), um den Preis bei Idealo zu prüfen';
        break;
      case 'loading':
        html = '<span class="spin"></span><span class="muted">idealo …</span>';
        title = 'Suche bei Idealo …';
        break;
      case 'ok': {
        const kind = r.kind === 'price' ? 'Artikel' : 'inkl. Versand';
        html += `<span>idealo</span><span class="price">${fmt(r.value)}</span>`;
        if (r.diff != null && r.diff > 0.009) html += `<span class="badge good">−${fmt(r.diff)}</span>`;
        else if (r.diff != null && r.diff < -0.009) html += '<span class="badge bad">Amazon günstiger</span>';
        title = `Günstigster Preis ${kind}${r.shop ? ` bei ${r.shop}` : ''} – klicken öffnet Idealo`;
        break;
      }
      case 'choose':
        html += '<span class="muted">idealo: kein eindeutiger Treffer</span>';
        title = 'Idealo hat ähnliche, aber nicht sicher passende Produkte gefunden – klicken öffnet die Suche';
        break;
      case 'none':
        html += '<span class="muted">nicht auf idealo</span>';
        title = 'Kein passendes Produkt auf Idealo gefunden – klicken öffnet die Suche';
        break;
      case 'error':
        html += '<span class="muted">idealo: Fehler ↻</span>';
        title = `${entry.error || 'Fehler'} – klicken zum erneut Versuchen`;
        break;
    }
    if (ui.innerHTML !== html) ui.innerHTML = html;
    ui.title = title;
  }

  // ---------- Hover-Logik ----------

  function hoverTarget(entry, el, target) {
    target.addEventListener('mouseenter', () => {
      if (entry.state !== 'idle' && entry.state !== 'error') return;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => check(entry, el), HOVER_DELAY_MS);
    });
    target.addEventListener('mouseleave', () => {
      clearTimeout(entry.timer);
      entry.timer = null;
    });
  }

  function onLabelClick(entry, el) {
    clearTimeout(entry.timer);
    if (entry.state === 'idle' || entry.state === 'error') return check(entry, el);
    if (entry.state === 'loading') return;
    const url = entry.state === 'ok' ? entry.productUrl : entry.searchUrl;
    if (url) window.open(url, '_blank', 'noopener');
  }

  // ---------- Prüfung ----------

  async function check(entry, el) {
    if (entry.state === 'loading' || entry.state === 'ok') return;
    entry.state = 'loading';
    entry.error = '';
    render(entry);
    try {
      const data = readItem(el);
      if (!data.title) throw new Error('Titel nicht gefunden');
      // Schon einmal geprüft (z. B. im Warenkorb oder vorhin in der Suche)? Dann ohne neue Anfrage.
      let res = await asinCache.get(entry.asin);
      if (!res) {
        res = { ...(await checkAmazonItem(data, 'high')), quality: 'title' };
        asinCache.set(entry.asin, res);
      }
      apply(entry, res, parseEuro(data.priceText));
    } catch (err) {
      console.warn('[Idealo-Preischeck]', err);
      entry.state = 'error';
      entry.error = err.message;
    }
    render(entry);
  }

  function apply(entry, res, amzPrice) {
    entry.searchUrl = res.searchUrl;
    entry.productUrl = res.productUrl;
    entry.offers = res.offers;
    entry.ld = res.ld;
    entry.amzPrice = amzPrice;
    if (res.state !== 'found') { entry.state = res.state === 'bundle' ? 'none' : res.state; return; }
    entry.result = computeBest(entry.offers, entry.ld, settings, entry.amzPrice);
    entry.state = entry.result.state === 'ok' ? 'ok' : 'none';
  }

  // ---------- Etiketten einfügen (auch nach Filterwechsel / Nachladen) ----------

  function scan() {
    if (!settings.searchLabels) return;
    document.querySelectorAll(ITEM_SEL).forEach((el) => {
      const asin = el.dataset.asin;
      if (!/^[A-Z0-9]{10}$/.test(asin || '')) return;
      const existing = el.querySelector(`.${LABEL_CLASS}`);
      if (existing?.shadowRoot) return;   // hat schon ein (funktionierendes) Etikett → nichts tun
      existing?.remove();                 // leere Kopie (z. B. von Amazon mitgeklont) → ersetzen
      const anchor = el.querySelector('[data-cy="price-recipe"]') || el.querySelector('[data-cy="title-recipe"]');
      if (!anchor) return;
      anchor.appendChild(createLabel(getEntry(asin), el));
    });
  }

  function removeAll() {
    document.querySelectorAll(`.${LABEL_CLASS}`).forEach((n) => n.remove());
    for (const entry of entries.values()) entry.views.clear();
  }

  let scanTimer = null;
  const observer = new MutationObserver((mutations) => {
    // Eigene Etiketten lösen keinen neuen Durchlauf aus
    const own = (n) => n.nodeType === 1 && n.classList.contains(LABEL_CLASS);
    if (mutations.every((m) => [...m.addedNodes, ...m.removedNodes].every(own))) return;
    // Höchstens ein Durchlauf alle 300 ms – und garantiert, auch wenn die Seite sich ständig ändert
    // (ein Timer, der bei jeder Änderung neu startet, käme bei Dauer-Änderungen nie zum Zug).
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 300);
  });

  chrome.storage.sync.get(DEFAULTS).then((s) => {
    settings = { ...DEFAULTS, ...s };
    scan();
    observer.observe(document.body, { childList: true, subtree: true });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const k of Object.keys(DEFAULTS)) if (changes[k]) settings[k] = changes[k].newValue;
    if (changes.searchLabels) { settings.searchLabels ? scan() : removeAll(); }
    if (changes.sort || changes.freeShipOnly) {
      for (const entry of entries.values()) {
        if (entry.offers && entry.state !== 'loading' && entry.state !== 'choose') {
          entry.result = computeBest(entry.offers, entry.ld, settings, entry.amzPrice);
          entry.state = entry.result.state === 'ok' ? 'ok' : 'none';
          render(entry);
        }
      }
    }
  });
})();
