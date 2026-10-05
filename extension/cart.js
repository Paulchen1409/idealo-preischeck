// Einkaufswagen-Check: prüft alle Artikel im Amazon-Warenkorb bei Idealo und zeigt über der Kasse,
// wie viel man woanders sparen könnte.
//
// Ablauf
//   1. Warenkorb auslesen – Amazon liefert ASIN, Preis, Menge, Titel und "ausgewählt" als data-Attribute.
//   2. Sofort anzeigen, was schon bekannt ist: Ergebnisse bis 24 h alt erscheinen direkt und werden
//      im Hintergrund aktualisiert ("stale-while-revalidate").
//   3. Zwei Stufen, die gleichzeitig laufen:
//        a) Amazon-Details (EAN/Modell/Bündel-Teile) für ALLE Artikel vorab holen – bis zu 4 parallel,
//           7 Tage in storage.local gemerkt. Das sind Amazon-Abfragen, keine Idealo-Abfragen.
//        b) Idealo-Prüfung EINZELN nacheinander über die "low"-Spur des Hintergrund-Workers,
//           der sie hinter dringende Anfragen (Hover, Produktseite) reiht und Abstand hält.
//   4. MutationObserver erkennt Änderungen (Menge, Löschen, Auswahl, AJAX-Neuaufbau). Neue Artikel
//      kommen in die Warteschlange, bei Mengenänderungen wird nur neu gerechnet – ohne neue Anfrage.
//   5. Banner und kleine Etiketten an den Artikeln aktualisieren sich live.
(() => {
  'use strict';
  if (window.top !== window) return;
  if (!/^\/(gp\/cart|cart)/.test(location.pathname)) return;

  const DEFAULTS = { cartCheck: true, primeCheck: true, sort: 'total', freeShipOnly: false };
  const ROW_SEL = '[data-name="Active Items"] [data-asin][data-itemtype="active"]';
  const ROW_SEL_FALLBACK = '[data-asin][data-itemtype="active"]';
  const THROTTLE_PAUSE_MS = 65 * 1000;
  const FRESH_MS = 30 * 60 * 1000;            // jünger: gilt als aktuell, keine neue Prüfung
  const STALE_MS = 24 * 60 * 60 * 1000;       // bis dahin: sofort zeigen, im Hintergrund aktualisieren
  const DETAILS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const AMAZON_PARALLEL = 4;                  // gleichzeitige Amazon-Abrufe (gemessen: 4 Seiten in 1,6 s statt 6,9 s)

  let settings = { ...DEFAULTS };
  const items = new Map();   // asin → Artikel
  const queue = [];          // ASINs, die noch geprüft werden müssen
  const refreshQueue = [];   // ASINs mit altem Ergebnis, die im Hintergrund aktualisiert werden
  let working = false;
  let pausedUntil = 0;
  let bannerHost = null;
  let ui = {};
  let detailsOpen = false;
  let port = null;
  let primeOpen = false;

  // Prime-Check: Analyse je Idealo-Produkt (Preisverlauf 2 Jahre → Prime-Rabatte), siehe prime.js
  const PRIME_TTL_MS = 12 * 60 * 60 * 1000;
  const primeData = new Map();   // idealo-ID → { status: 'pending'|'loading'|'done'|'error', analysis }
  const primeQueue = [];
  let primeWorking = false;

  const fmt = (n) => n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- 1. Warenkorb auslesen ----------

  function readCart() {
    let rows = [...document.querySelectorAll(ROW_SEL)];
    if (!rows.length) rows = [...document.querySelectorAll(ROW_SEL_FALLBACK)];
    const seen = new Set();
    return rows.map((row) => {
      const asin = row.dataset.asin;
      if (!/^[A-Z0-9]{10}$/.test(asin || '') || seen.has(asin)) return null;
      seen.add(asin);
      const price = parseFloat(row.dataset.price);
      return {
        asin,
        row,
        title: clean(row.dataset.producttitle || row.querySelector('.sc-product-title, .a-truncate-full')?.textContent),
        price: Number.isFinite(price) ? price : parseEuro(row.querySelector('.a-price .a-offscreen')?.textContent),
        qty: Math.max(1, parseInt(row.dataset.quantity, 10) || 1),
        selected: row.dataset.isselected !== '0',
      };
    }).filter(Boolean);
  }

  /**
   * Holt EAN, Marke und Modell von der Amazon-Produktseite. Die Seite ist ~2,7 MB groß; damit das
   * Auslesen schnell bleibt, werden nur die nötigen Ausschnitte geparst.
   * Bei Bündeln kommen zusätzlich die Bestandteile mit: [{ asin, count, title }].
   */
  async function fetchAmazonDetails(asin) {
    const url = `${location.origin}/dp/${asin}`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const html = await res.text();
    if (/validateCaptcha|Robot Check/i.test(html.slice(0, 30000))) return null; // Amazon will prüfen
    const parseSlice = (from, to) =>
      new DOMParser().parseFromString(`<body>${html.slice(Math.max(0, from), Math.min(html.length, to))}</body>`, 'text/html');

    let details = { title: '', brand: '', model: '', ean: '', url };
    const markers = ['id="prodDetails"', 'id="productDetails_techSpec_section_1"', 'id="detailBullets_feature_div"',
                     'id="productOverview_feature_div"', 'id="productDetails_detailBullets_sections1"']
      .map((m) => html.indexOf(m)).filter((i) => i >= 0);
    if (markers.length) details = scrapeAmazon(parseSlice(Math.min(...markers) - 2000, Math.max(...markers) + 120000), url);

    // Bündel-Bereich gibt es auf vielen Seiten leer – nur auslesen, wenn wirklich Bestandteile drinstehen
    const b = html.indexOf('id="bundleComponentDetails_feature_div"');
    if (b >= 0 && html.indexOf('bundle-component-details-component-title-0', b) > 0) {
      details.components = readBundleComponents(parseSlice(b - 500, b + 200000));
    }
    return details;
  }

  /** Bestandteile eines Amazon-Bündels: Titel ("2 von …" = Anzahl) und ASIN des jeweiligen Links */
  function readBundleComponents(doc) {
    const sec = doc.querySelector('#bundleComponentDetails_feature_div') || doc.body;
    const titles = [...sec.querySelectorAll('[id^="bundle-component-details-component-title-"]')];
    const fallbackAsins = [...new Set([...sec.querySelectorAll('a[href*="/dp/"]')]
      .map((a) => (a.getAttribute('href').match(/\/dp\/([A-Z0-9]{10})/) || [])[1]).filter(Boolean))];
    return titles.map((t, i) => {
      // Nächsten Container suchen, der genau diesen einen Bestandteil mit Link enthält
      let box = t;
      while (box && box !== sec && !box.querySelector('a[href*="/dp/"]')) box = box.parentElement;
      const single = box && box !== sec &&
        box.querySelectorAll('[id^="bundle-component-details-component-title-"]').length === 1;
      const href = single ? box.querySelector('a[href*="/dp/"]').getAttribute('href') : '';
      const asin = (href.match(/\/dp\/([A-Z0-9]{10})/) || [])[1] || fallbackAsins[i] || null;
      const text = clean(t.textContent);
      const m = text.match(/^(\d+)\s+von\s+(.*)$/i);
      return { asin, count: m ? Number(m[1]) : 1, title: m ? m[2] : text };
    }).filter((c) => c.asin);
  }

  // ---------- Amazon-Details: parallel, mit Wochen-Cache ----------

  // Einfacher Begrenzer: höchstens AMAZON_PARALLEL Abrufe gleichzeitig
  let amazonRunning = 0;
  const amazonWaiting = [];
  async function limited(task) {
    if (amazonRunning >= AMAZON_PARALLEL) await new Promise((r) => amazonWaiting.push(r));
    amazonRunning++;
    try { return await task(); } finally { amazonRunning--; amazonWaiting.shift()?.(); }
  }

  const detailsPromises = new Map(); // asin → Promise (jeder Artikel wird nur einmal geholt)

  /** EAN/Modell/Bündel-Teile: zuerst aus storage.local (7 Tage), sonst von Amazon (parallel begrenzt) */
  function getDetails(asin) {
    if (detailsPromises.has(asin)) return detailsPromises.get(asin);
    const p = (async () => {
      const key = `amzd:${asin}`;
      try {
        const { [key]: hit } = await chrome.storage.local.get(key);
        if (hit && Date.now() - hit.time < DETAILS_TTL_MS) return hit.data;
      } catch { /* Speicher nicht verfügbar → einfach neu holen */ }
      const data = await limited(() => fetchAmazonDetails(asin)).catch(() => null);
      if (data) chrome.storage.local.set({ [key]: { time: Date.now(), data } }).catch(() => {});
      // Bündel: Details der Teile gleich mit vorladen
      data?.components?.forEach((c) => getDetails(c.asin));
      return data;
    })();
    detailsPromises.set(asin, p);
    return p;
  }

  // ---------- 2. Arbeiter: ein Artikel nach dem anderen (Idealo) ----------

  function enqueue(asin, front = false) {
    if (queue.includes(asin)) return;
    front ? queue.unshift(asin) : queue.push(asin);
    getDetails(asin); // Amazon-Details schon jetzt parallel holen, während Idealo noch andere prüft
    work();
  }

  function enqueueRefresh(asin) {
    if (refreshQueue.includes(asin) || queue.includes(asin)) return;
    refreshQueue.push(asin);
    work();
  }

  async function work() {
    if (working || !settings.cartCheck) return;
    working = true;
    try {
      while ((queue.length || refreshQueue.length) && settings.cartCheck) {
        if (Date.now() < pausedUntil) {
          render();
          await sleep(Math.min(pausedUntil - Date.now(), 5000));
          continue;
        }
        // Erst alles ohne Ergebnis, dann veraltete Ergebnisse auffrischen
        const isRefresh = !queue.length;
        const asin = isRefresh ? refreshQueue.shift() : queue.shift();
        const item = items.get(asin);
        if (!item) continue;                                // inzwischen gelöscht
        if (!isRefresh && item.status === 'done') continue; // schon fertig
        if (isRefresh) item.refreshing = true;              // altes Ergebnis bleibt sichtbar
        else item.status = 'scanning';
        render();
        try {
          item.result = await checkItem(item, isRefresh);
          item.status = 'done';
          item.stale = false;
          schedulePrime(item);
        } catch (err) {
          if (/bremst/.test(err.message)) {
            // Idealo bremst: Artikel zurück an den Anfang, Pause, dann weiter
            if (isRefresh) refreshQueue.unshift(asin);
            else { item.status = 'pending'; queue.unshift(asin); }
            pausedUntil = Date.now() + THROTTLE_PAUSE_MS;
          } else if (!isRefresh) {
            console.warn('[Idealo-Preischeck] Warenkorb:', asin, err);
            item.status = 'error';
            item.error = err.message;
          } // Auffrischen fehlgeschlagen → altes Ergebnis behalten
        } finally {
          item.refreshing = false;
        }
        render();
      }
    } finally {
      working = false;
      render();
    }
  }

  /** Brauchbares Ergebnis? (Titel-only "nicht gefunden" aus der Suche prüfen wir genauer) */
  const usable = (r) => r && (r.state === 'found' || r.state === 'bundle' || r.quality === 'details');

  async function checkItem(item, skipCache = false) {
    if (!skipCache && !item.force) {
      const cached = await asinCache.get(item.asin);
      if (usable(cached)) return cached;
    }

    const details = await getDetails(item.asin);
    const data = details
      ? { ...details, title: item.title || details.title }
      : { title: item.title, brand: '', model: '', ean: '' };

    // Bündel: jedes Teil einzeln prüfen und später die Summe vergleichen
    if (details?.components?.length >= 2) {
      const components = [];
      for (const c of details.components) {
        components.push({ ...c, res: await checkComponent(c, skipCache || item.force) });
        item.bundleProgress = `${components.length}/${details.components.length}`;
        render();
      }
      const res = { state: 'bundle', components, quality: 'details' };
      item.force = false;
      asinCache.set(item.asin, res);
      return res;
    }

    const res = { ...(await checkAmazonItem(data, 'low')), quality: data.ean || data.model ? 'details' : 'title' };
    item.force = false;
    asinCache.set(item.asin, res);
    return res;
  }

  /** Ein Bündel-Bestandteil: Details (meist schon vorgeladen), dann Idealo (mit Cache) */
  async function checkComponent(c, skipCache) {
    if (!skipCache) {
      const cached = await asinCache.get(c.asin);
      if (usable(cached)) return cached;
    }
    const d = await getDetails(c.asin);
    const data = d ? { ...d, title: c.title || d.title } : { title: c.title, brand: '', model: '', ean: '' };
    const res = { ...(await checkAmazonItem(data, 'low')), quality: data.ean || data.model ? 'details' : 'title' };
    asinCache.set(c.asin, res);
    return res;
  }

  /**
   * Neuer Artikel im Warenkorb: Gibt es ein Ergebnis von heute? Dann sofort anzeigen
   * (und, falls älter als 30 Min., im Hintergrund auffrischen). Sonst normal prüfen.
   */
  async function initItem(item) {
    const hit = await asinCache.getEntry(item.asin, STALE_MS);
    if (!items.has(item.asin) || item.status !== 'pending') return;
    if (hit && usable(hit.data)) {
      item.result = hit.data;
      item.status = 'done';
      schedulePrime(item);
      item.stale = hit.age > FRESH_MS;
      if (item.stale) enqueueRefresh(item.asin);
      render();
    } else {
      enqueue(item.asin);
    }
  }

  // ---------- 3. Änderungen im Warenkorb erkennen ----------

  function reconcile() {
    if (!settings.cartCheck) return;
    const current = readCart();
    const present = new Set(current.map((c) => c.asin));

    // Ausgewählte Artikel zuerst prüfen – nur die landen an der Kasse
    const ordered = [...current].sort((a, b) => Number(b.selected) - Number(a.selected));
    for (const c of ordered) {
      const item = items.get(c.asin);
      if (!item) {
        const fresh = { ...c, status: 'pending', result: null };
        items.set(c.asin, fresh);
        initItem(fresh);
      } else {
        // Menge, Preis, Auswahl oder neu aufgebaute Zeile übernehmen – kein neuer Abruf nötig
        Object.assign(item, { row: c.row, title: c.title, price: c.price, qty: c.qty, selected: c.selected });
      }
    }
    for (const asin of [...items.keys()]) {
      if (!present.has(asin)) {
        items.delete(asin);
        for (const q of [queue, refreshQueue]) {
          const i = q.indexOf(asin);
          if (i >= 0) q.splice(i, 1);
        }
      }
    }
    render();
  }

  let reconcileTimer = null;
  const scheduleReconcile = () => {
    // Amazon ändert oft viele Knoten auf einmal → bündeln. Spätestens 400 ms nach der ersten Änderung
    // wird abgeglichen, auch wenn die Seite (Werbung, Karussells) sich ständig weiter ändert.
    if (reconcileTimer) return;
    reconcileTimer = setTimeout(() => { reconcileTimer = null; reconcile(); }, 400);
  };
  const ownNode = (n) => n && (n === bannerHost || n.classList?.contains('idealo-cart-badge'));
  const observer = new MutationObserver((mutations) => {
    // Eigene Änderungen (Banner, Etiketten) ignorieren
    if (mutations.every((m) => ownNode(m.target) || [...m.addedNodes, ...m.removedNodes].every(ownNode))) return;
    scheduleReconcile();
  });

  // ---------- Prime-Check: Preisverläufe holen ----------

  /** Idealo-IDs eines Artikels (bei Bündeln die der Teile) */
  function idealoIdsOf(item) {
    const r = item.result;
    if (!r) return [];
    if (r.state === 'bundle') return r.components.map((c) => productIdFromUrl(c.res?.productUrl)).filter(Boolean);
    return r.state === 'found' ? [productIdFromUrl(r.productUrl)].filter(Boolean) : [];
  }

  function schedulePrime(item) {
    if (!settings.primeCheck) return;
    for (const id of idealoIdsOf(item)) {
      if (primeData.has(id)) continue;
      primeData.set(id, { status: 'pending' });
      primeQueue.push(id);
    }
    primeWork();
  }

  async function primeWork() {
    if (primeWorking) return;
    primeWorking = true;
    try {
      while (primeQueue.length && settings.primeCheck) {
        const id = primeQueue.shift();
        const entry = primeData.get(id);
        entry.status = 'loading';
        render();
        try {
          entry.analysis = await loadPrimeAnalysis(id);
          entry.status = 'done';
        } catch (err) {
          console.warn('[Idealo-Preischeck] Prime-Check:', id, err);
          entry.status = 'error';
          if (/bremst/.test(err.message)) { primeData.delete(id); primeQueue.push(id); await sleep(THROTTLE_PAUSE_MS); }
        }
        render();
      }
    } finally {
      primeWorking = false;
    }
  }

  /** Prime-Rabatte eines Produkts – 12 h in storage.local gemerkt (der Verlauf ändert sich nur täglich) */
  async function loadPrimeAnalysis(id) {
    const key = `prime:${id}`;
    try {
      const { [key]: hit } = await chrome.storage.local.get(key);
      if (hit && Date.now() - hit.time < PRIME_TTL_MS) return hit.analysis;
    } catch { /* ohne Speicher weiter */ }
    let points = [];
    try {
      const res = await fetchIdealo(`${IDEALO}/price-chart/sites/1/products/${id}/history?period=2Y`, 'low');
      if (res.ok) {
        const json = JSON.parse(res.html);
        points = (json.data || []).filter((d) => d && typeof d.y === 'number' && d.x).map((d) => ({ date: d.x, price: d.y / 100 }));
      } else if (res.status !== 404) {
        throw new Error(`Idealo antwortet mit ${res.status}`);
      }
    } catch (err) {
      if (/bremst/.test(err.message)) throw err;
      throw new Error(err.message);
    }
    const analysis = analyzePrimeHistory(points);
    chrome.storage.local.set({ [key]: { time: Date.now(), analysis } }).catch(() => {});
    return analysis;
  }

  /**
   * Prime-Schätzung für einen Artikel: { state: 'pending'|'nodata'|'ok', saving, expected, ref, discount }
   * saving gilt für die ganze Menge im Warenkorb.
   */
  function evaluatePrime(item, next) {
    const r = item.result;
    if (item.status !== 'done' || !r) return { state: 'pending' };
    const ids = idealoIdsOf(item);
    if (!ids.length) return { state: 'nodata' };
    const entries = ids.map((id) => primeData.get(id));
    if (entries.some((e) => !e || e.status === 'pending' || e.status === 'loading')) return { state: 'pending' };

    const nextType = next?.event.type;
    let parts;
    if (r.state === 'bundle') {
      parts = r.components.map((c) => {
        const best = c.res?.state === 'found' ? computeBest(c.res.offers || [], c.res.ld, settings, null) : null;
        return { id: productIdFromUrl(c.res?.productUrl), count: c.count, bestNow: best?.state === 'ok' ? best.value : null };
      });
    } else {
      const ev = evaluate(item);
      const candidates = [item.price, ev && !ev.missing ? ev.idealoUnit : null].filter((v) => v > 0);
      parts = [{ id: ids[0], count: 1, bestNow: candidates.length ? Math.min(...candidates) : null }];
    }

    let saving = 0, expected = 0, ref = null, discount = 0;
    for (const p of parts) {
      const entry = primeData.get(p.id);
      const est = p.bestNow && entry?.status === 'done' ? estimatePrimeSaving(p.bestNow, entry.analysis, nextType) : null;
      if (!est) return { state: 'nodata' };
      saving += est.saving * p.count;
      expected += est.expected * p.count;
      ref = ref || est.ref;
      discount = Math.max(discount, est.ref.discount);
    }
    return { state: 'ok', saving: round2(saving * item.qty), expected: round2(expected), ref, discount, bundle: parts.length > 1 };
  }

  // ---------- Berechnung ----------

  function evaluate(item) {
    const r = item.result;
    if (!r) return null;
    let idealoUnit, shop, parts = null;

    if (r.state === 'bundle') {
      // Bündel: Summe aus (Anzahl × Idealo-Bestpreis) aller Teile. Fehlt ein Teil, ist kein fairer Vergleich möglich.
      parts = [];
      let missingCount = 0;
      for (const c of r.components) {
        const best = c.res?.state === 'found' ? computeBest(c.res.offers || [], c.res.ld, settings, null) : null;
        if (!best || best.state !== 'ok') { missingCount++; continue; }
        parts.push({ title: c.title, count: c.count, value: best.value, shop: best.shop, url: c.res.productUrl });
      }
      if (missingCount) return { missing: true, missingCount };
      idealoUnit = round2(parts.reduce((sum, p) => sum + p.value * p.count, 0));
      shop = 'Einzelteile';
    } else {
      if (r.state !== 'found') return null;
      const best = computeBest(r.offers || [], r.ld, settings, item.price);
      if (best.state !== 'ok') return null;
      idealoUnit = best.value;
      shop = best.shop;
    }

    const unitDiff = item.price != null ? round2(item.price - idealoUnit) : null; // > 0: Idealo günstiger
    return {
      idealoUnit,
      shop,
      parts,
      unitDiff,
      // Spar-Betrag für die ganze Menge: (Amazon-Preis − Idealo-Preis) × Menge
      saving: unitDiff != null && unitDiff > 0.009 ? round2(unitDiff * item.qty) : 0,
    };
  }

  function totals() {
    const list = [...items.values()];
    const selected = list.filter((i) => i.selected);
    const done = selected.filter((i) => i.status === 'done' || i.status === 'error');
    const evals = selected.map((i) => ({ item: i, ev: i.status === 'done' ? evaluate(i) : null }));
    const cheaper = evals.filter((e) => e.ev && !e.ev.missing && e.ev.saving > 0);
    return {
      total: selected.length,
      done: done.length,
      unselected: list.length - selected.length,
      cheaper,
      notFound: evals.filter((e) => e.item.status === 'done' && (!e.ev || e.ev.missing)).length,
      errors: selected.filter((i) => i.status === 'error').length,
      saving: round2(cheaper.reduce((s, e) => s + e.ev.saving, 0)),
      scanningIndex: selected.findIndex((i) => i.status === 'scanning'),
    };
  }

  // ---------- 4. Darstellung ----------

  const BANNER_CSS = `
    :host { display: block; margin: 0 0 12px; }
    .box {
      font: 13px/1.4 "Amazon Ember", Arial, sans-serif; color: #0f1111;
      border: 1px solid #d3deeb; border-radius: 10px; overflow: hidden; background: #fff;
      box-shadow: 0 1px 3px rgba(15, 17, 17, .08);
    }
    .head {
      display: flex; align-items: center; gap: 8px; padding: 8px 12px;
      background: #0a3761; color: #fff; font-weight: 700; font-size: 12px; letter-spacing: .2px;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #ff6600; flex: none; }
    .head .spacer { flex: 1; }
    .head button { all: unset; cursor: pointer; font-weight: 600; opacity: .85; font-size: 12px; }
    .head button:hover { opacity: 1; text-decoration: underline; }
    .body { padding: 10px 12px 12px; }
    .status { font-weight: 700; font-size: 15px; }
    .status.good { color: #128a3e; }
    .status.neutral { color: #0f1111; }
    .big { font-size: 22px; font-weight: 800; color: #128a3e; display: block; margin-top: 2px; }
    .sub { color: #565959; font-size: 12px; margin-top: 4px; }
    .bar { height: 6px; border-radius: 99px; background: #e6e8ee; margin-top: 8px; overflow: hidden; }
    .bar > i { display: block; height: 100%; background: #ff6600; border-radius: 99px; transition: width .3s ease; }
    .toggle { all: unset; cursor: pointer; color: #007185; font-size: 12px; margin-top: 8px; display: inline-block; }
    .toggle:hover { text-decoration: underline; color: #c7511f; }
    ul { list-style: none; margin: 8px 0 0; padding: 0; border-top: 1px solid #e6e8ee; }
    li { padding: 7px 0; border-bottom: 1px solid #f0f2f2; display: grid; grid-template-columns: 1fr auto; gap: 1px 8px; }
    li:last-child { border-bottom: 0; }
    .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    .t a { color: #0f1111; text-decoration: none; }
    .t a:hover { color: #c7511f; text-decoration: underline; }
    .s { font-weight: 700; color: #128a3e; font-size: 12px; text-align: right; white-space: nowrap; }
    .p { color: #565959; font-size: 11px; grid-column: 1 / -1; }
    .prime { margin-top: 12px; padding-top: 10px; border-top: 1px dashed #d5d9d9; }
    .ptitle { font-size: 11px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: #00a8e1; }
    .pnext { font-size: 12px; margin-top: 3px; }
    .pnext b { font-weight: 700; }
    .pres { font-weight: 700; font-size: 14px; margin-top: 4px; }
    .pres.good { color: #128a3e; }
    .pres.flat { color: #565959; font-weight: 600; font-size: 13px; }
    .pbasis { color: #6b7385; font-size: 11px; margin-top: 4px; }
    .s.none { color: #6b7385; font-weight: 500; }
  `;

  const BADGE_CSS = `
    a {
      display: inline-flex; align-items: center; gap: 6px; text-decoration: none; margin-top: 4px;
      padding: 1px 8px 1px 6px; border-radius: 999px; font: 500 12px/18px "Amazon Ember", Arial, sans-serif;
      color: #0a3761; background: #eef3f9; border: 1px solid #d3deeb; white-space: nowrap;
    }
    a[href]:hover { background: #e2ebf6; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #ff6600; flex: none; }
    b { font-weight: 700; }
    .good { color: #fff; background: #1f9d55; border-radius: 999px; padding: 0 6px; font-weight: 700; font-size: 11px; }
    .muted { color: #6b7385; }
    .spin { width: 8px; height: 8px; border-radius: 50%; border: 2px solid #c9d6e6; border-top-color: #0a3761; animation: s .8s linear infinite; }
    @keyframes s { to { transform: rotate(360deg); } }
  `;

  function ensureBanner() {
    if (bannerHost?.isConnected) return true;
    const buyBox = document.querySelector('#sc-buy-box');
    const anchor = buyBox || document.querySelector('[data-name="Active Cart"]');
    if (!anchor) return false;
    if (!bannerHost) {
      bannerHost = document.createElement('div');
      bannerHost.id = 'idealo-cart-banner';
      const root = bannerHost.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${BANNER_CSS}</style>
        <div class="box">
          <div class="head"><span class="dot"></span>Idealo-Check<span class="spacer"></span>
            <button type="button" class="rescan" title="Alle Artikel neu bei Idealo prüfen">Neu prüfen</button></div>
          <div class="body">
            <div class="status"></div>
            <div class="sub"></div>
            <div class="bar"><i></i></div>
            <button type="button" class="toggle"></button>
            <ul class="list" hidden></ul>
            <div class="prime" hidden>
              <div class="ptitle">Prime-Check</div>
              <div class="pnext"></div>
              <div class="pres"></div>
              <div class="pbasis"></div>
              <button type="button" class="toggle ptoggle"></button>
              <ul class="plist" hidden></ul>
            </div>
          </div>
        </div>`;
      ui = {
        status: root.querySelector('.status'), sub: root.querySelector('.sub'),
        bar: root.querySelector('.bar'), fill: root.querySelector('.bar > i'),
        toggle: root.querySelector('.toggle'), list: root.querySelector('ul.list'),
        prime: root.querySelector('.prime'), pnext: root.querySelector('.pnext'), pres: root.querySelector('.pres'),
        pbasis: root.querySelector('.pbasis'), ptoggle: root.querySelector('.ptoggle'), plist: root.querySelector('.plist'),
      };
      ui.toggle.addEventListener('click', () => { detailsOpen = !detailsOpen; render(); });
      ui.ptoggle.addEventListener('click', () => { primeOpen = !primeOpen; render(); });
      root.querySelector('.rescan').addEventListener('click', rescan);
    }
    if (buyBox) buyBox.parentElement.insertBefore(bannerHost, buyBox); // direkt über der Kasse
    else anchor.prepend(bannerHost);
    return true;
  }

  let renderQueued = false;
  function render() {
    // Mehrere Änderungen kurz hintereinander → nur einmal pro Frame zeichnen
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; draw(); });
  }

  function draw() {
    if (!settings.cartCheck || !items.size) { bannerHost?.remove(); removeBadges(); return; }
    if (!ensureBanner()) return;
    const t = totals();
    const finished = t.done >= t.total;
    const paused = Date.now() < pausedUntil;

    if (!t.total) {
      ui.status.className = 'status neutral';
      ui.status.textContent = 'Keine Artikel ausgewählt';
      ui.sub.textContent = '';
    } else if (paused) {
      ui.status.className = 'status neutral';
      ui.status.textContent = 'Idealo bremst kurz – geht gleich weiter …';
      ui.sub.textContent = `${t.done} von ${t.total} Artikeln geprüft`;
    } else if (!finished) {
      const n = Math.min(t.total, (t.scanningIndex >= 0 ? t.scanningIndex : t.done) + 1);
      ui.status.className = 'status neutral';
      ui.status.textContent = `Scanne Artikel ${n} von ${t.total} …`;
      ui.sub.textContent = t.saving > 0 ? `Bisher ${fmt(t.saving)} Ersparnis gefunden` : 'Vergleiche mit Idealo';
    } else if (t.saving > 0) {
      ui.status.className = 'status good';
      ui.status.innerHTML = `Fertig! Du könntest sparen:<span class="big">${fmt(t.saving)}</span>`;
      ui.sub.textContent = `${t.cheaper.length} von ${t.total} Artikeln ${t.cheaper.length === 1 ? 'ist' : 'sind'} woanders günstiger`;
    } else {
      ui.status.className = 'status neutral';
      ui.status.textContent = 'Fertig! Amazon ist hier am günstigsten.';
      ui.sub.textContent = `${t.total} Artikel geprüft`;
    }

    const extras = [];
    if (t.notFound) extras.push(`${t.notFound} nicht auf Idealo`);
    if (t.errors) extras.push(`${t.errors} mit Fehler`);
    if (t.unselected) extras.push(`${t.unselected} nicht ausgewählt`);
    if (finished && extras.length) ui.sub.textContent += ` · ${extras.join(' · ')}`;
    const refreshing = [...items.values()].filter((i) => i.stale || i.refreshing).length;
    if (finished && refreshing) ui.sub.textContent += ` · aktualisiere ${refreshing} ältere${refreshing === 1 ? 'n Wert' : ' Werte'} …`;

    ui.bar.hidden = finished && !paused;
    ui.fill.style.width = `${t.total ? Math.round((t.done / t.total) * 100) : 0}%`;

    ui.toggle.hidden = !t.cheaper.length;
    ui.toggle.textContent = detailsOpen ? 'Details ausblenden ▴' : `Wo ist es günstiger? ▾`;
    ui.list.hidden = !detailsOpen || !t.cheaper.length;
    if (!ui.list.hidden) {
      ui.list.innerHTML = t.cheaper
        .sort((a, b) => b.ev.saving - a.ev.saving)
        .map(({ item, ev }) => `
          <li>
            <span class="t"><a href="${esc(item.result.productUrl || ev.parts?.[0]?.url || '#')}" target="_blank" rel="noopener" title="${esc(item.title)}">${esc(item.title)}</a></span>
            <span class="s">−${fmt(ev.saving)}</span>
            <span class="p">${ev.parts
              ? `Bündel einzeln: ${ev.parts.map((p) => `${p.count > 1 ? `${p.count} × ` : ''}${fmt(p.value)}${p.shop ? ` (${esc(p.shop)})` : ''}`).join(' + ')} = ${fmt(ev.idealoUnit)}`
              : `${fmt(ev.idealoUnit)}${ev.shop ? ` bei ${esc(ev.shop)}` : ''}`}${item.qty > 1 ? ` · ${item.qty} Stück` : ''} statt ${fmt(item.price)} auf Amazon</span>
          </li>`).join('');
    }

    drawPrime();
    drawBadges();
  }

  function drawPrime() {
    if (!settings.primeCheck) { ui.prime.hidden = true; return; }
    const next = nextPrimeEvent();
    if (!next) { ui.prime.hidden = true; return; }
    ui.prime.hidden = false;
    const { event, status, inDays } = next;
    const range = formatEventRange(event);

    if (status === 'ongoing') {
      ui.pnext.innerHTML = `<b>${esc(event.name)}</b> laufen gerade (${esc(range)})`;
    } else if (status === 'estimated') {
      const month = new Date(`${event.start}T12:00:00`).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
      ui.pnext.innerHTML = `Nächstes Event: <b>${esc(event.name)}</b>, voraussichtlich ${esc(month)} (noch nicht angekündigt)`;
    } else {
      const when = inDays === 1 ? 'morgen' : inDays === 2 ? 'übermorgen' : `in ${inDays} Tagen`;
      ui.pnext.innerHTML = `Nächstes Event: <b>${esc(event.name)}</b>, ${esc(range)} – <b>${when}</b>`;
    }

    const selected = [...items.values()].filter((i) => i.selected);
    const evals = selected.map((item) => ({ item, pe: evaluatePrime(item, next) }));
    const pending = evals.filter((e) => e.pe.state === 'pending').length;
    const withData = evals.filter((e) => e.pe.state === 'ok');
    const worth = withData.filter((e) => e.pe.saving >= Math.max(1, e.item.price * e.item.qty * 0.03));
    const total = round2(worth.reduce((sum, e) => sum + e.pe.saving, 0));

    if (status === 'ongoing') {
      ui.pres.className = 'pres flat';
      ui.pres.textContent = 'Die Preise sind gerade Prime-Preise – Warten bringt jetzt nichts mehr.';
    } else if (pending) {
      ui.pres.className = 'pres flat';
      ui.pres.textContent = `Prüfe Prime-Preise … (${selected.length - pending} von ${selected.length})`;
    } else if (!withData.length) {
      ui.pres.className = 'pres flat';
      ui.pres.textContent = 'Für diese Artikel gibt es keine Preisdaten vom letzten Prime-Event.';
    } else if (total > 0) {
      ui.pres.className = 'pres good';
      ui.pres.textContent = `Warten lohnt sich: ca. −${fmt(total)} bei ${worth.length} von ${selected.length} Artikeln`;
    } else {
      ui.pres.className = 'pres flat';
      ui.pres.textContent = 'Warten lohnt sich kaum – beim letzten Mal gab es für diese Artikel keine nennenswerten Prime-Rabatte.';
    }

    const refs = [...new Set(withData.map((e) => `${e.pe.ref.event.name} ${formatEventRange(e.pe.ref.event)}`))];
    ui.pbasis.textContent = withData.length
      ? `Schätzung aus den Prime-Rabatten bei den ${refs.length === 1 ? refs[0] : 'letzten Prime-Events'} (Idealo-Preisverlauf, alle Shops). Keine Garantie.`
      : '';

    ui.ptoggle.hidden = !withData.length || status === 'ongoing';
    ui.ptoggle.textContent = primeOpen ? 'Details ausblenden ▴' : 'Je Artikel ▾';
    ui.plist.hidden = !primeOpen || ui.ptoggle.hidden;
    if (!ui.plist.hidden) {
      ui.plist.innerHTML = evals
        .filter((e) => e.pe.state === 'ok' || e.pe.state === 'nodata')
        .sort((a, b) => (b.pe.saving || 0) - (a.pe.saving || 0))
        .map(({ item, pe }) => {
          if (pe.state === 'nodata') {
            return `<li><span class="t" title="${esc(item.title)}">${esc(item.title)}</span><span class="s none">keine Daten</span></li>`;
          }
          const r = pe.ref;
          const pct = Math.round(r.discount * 100);
          const detail = pct > 0
            ? `${esc(r.event.name)} ${esc(formatEventRange(r.event))}: −${pct} % (${fmt(r.primePrice)} statt ${fmt(r.base)}) · erwartet ca. ${fmt(pe.expected)}${pe.bundle ? ' (Bündel-Teile)' : ''}`
            : `${esc(r.event.name)} ${esc(formatEventRange(r.event))}: kein Prime-Rabatt (${fmt(r.primePrice)})`;
          const right = pe.saving >= 0.5 ? `<span class="s">−${fmt(pe.saving)}</span>` : '<span class="s none">kaum Ersparnis</span>';
          return `<li><span class="t" title="${esc(item.title)}">${esc(item.title)}</span>${right}<span class="p">${detail}</span></li>`;
        }).join('');
    }
  }


  /** Kleines Etikett direkt am Artikel im Warenkorb */
  function drawBadges() {
    for (const item of items.values()) {
      if (!item.row?.isConnected) continue;
      let host = item.row.querySelector(':scope .idealo-cart-badge');
      if (!host) {
        host = document.createElement('div');
        host.className = 'idealo-cart-badge';
        host.attachShadow({ mode: 'open' }).innerHTML = `<style>${BADGE_CSS}</style><a target="_blank" rel="noopener"></a>`;
        const anchor = item.row.querySelector('.sc-item-price-block, .sc-apex-cart-price') ||
                       item.row.querySelector('.sc-product-title')?.parentElement;
        if (!anchor) continue;
        anchor.after(host);
      }
      const a = host.shadowRoot.querySelector('a');
      let html = '<span class="dot"></span>';
      let href = '';
      if (item.status === 'pending') html += '<span class="muted">idealo: wartet</span>';
      else if (item.status === 'scanning') {
        html = `<span class="spin"></span><span class="muted">idealo …${item.bundleProgress ? ` Bündel-Teil ${item.bundleProgress}` : ''}</span>`;
      }
      else if (item.status === 'error') html += '<span class="muted">idealo: Fehler</span>';
      else {
        const ev = evaluate(item);
        if (ev?.missing) {
          html += `<span class="muted">Bündel: ${ev.missingCount} von ${item.result.components.length} Teilen nicht auf idealo</span>`;
        } else if (!ev) { html += '<span class="muted">nicht auf idealo</span>'; href = item.result?.searchUrl || ''; }
        else {
          html += `idealo${ev.parts ? ` Einzelteile (${ev.parts.length})` : ''} <b>${fmt(ev.idealoUnit)}</b>`;
          if (ev.saving > 0) html += ` <span class="good">−${fmt(ev.saving)}</span>`;
          else html += ' <span class="muted">· Amazon günstiger</span>';
          href = item.result.productUrl || ev.parts?.[0]?.url || '';
        }
      }
      if (a.innerHTML !== html) a.innerHTML = html; // nur ändern, wenn nötig (spart Mutationen)
      href ? a.setAttribute('href', href) : a.removeAttribute('href');
    }
  }

  function removeBadges() {
    document.querySelectorAll('.idealo-cart-badge').forEach((n) => n.remove());
  }

  function rescan() {
    refreshQueue.length = 0;
    primeData.clear();
    primeQueue.length = 0;
    for (const item of items.values()) {
      if (item.status === 'scanning') continue;
      item.status = 'pending';
      item.result = null;
      item.force = true;
      enqueue(item.asin);
    }
    render();
  }

  // ---------- Start ----------

  function start() {
    // Port zum Hintergrund: wird die Seite verlassen, verwirft er unsere wartenden Anfragen
    port = chrome.runtime.connect({ name: 'cart' });
    reconcile();
    // Ganze Seite beobachten: Amazon baut bei Mengenänderungen auch die Kasse neu auf.
    // Der Callback ist billig (nur Timer neu setzen), die eigentliche Arbeit läuft gebündelt in reconcile().
    observer.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['data-quantity', 'data-isselected', 'data-price', 'data-asin'],
    });
  }

  chrome.storage.sync.get(DEFAULTS).then((s) => {
    settings = { ...DEFAULTS, ...s };
    if (settings.cartCheck) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const k of Object.keys(DEFAULTS)) if (changes[k]) settings[k] = changes[k].newValue;
    if (changes.cartCheck) {
      if (settings.cartCheck && !port) start();
      else if (settings.cartCheck) { reconcile(); work(); }
    }
    if (changes.primeCheck && settings.primeCheck) for (const item of items.values()) if (item.status === 'done') schedulePrime(item);
    render(); // Sortierung/Versandfilter → nur neu rechnen, keine neuen Anfragen
  });
})();
