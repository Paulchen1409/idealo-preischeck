// Amazon → Idealo Preischeck – Popup-Logik
'use strict';

const DEFAULTS = {
  sort: 'total', count: 5, freeShipOnly: false, autoload: true,
  showButton: true, autoCheck: true, searchLabels: true, cartCheck: true,
};

// Eingebettet als Panel auf der Amazon-Seite (statt als Erweiterungs-Popup)?
const PARAMS = new URLSearchParams(location.search);
const EMBED = PARAMS.has('embed');
const PARENT_ORIGIN = PARAMS.get('origin') || '*';
function postToPage(msg) {
  if (EMBED) parent.postMessage({ source: 'idealo-preischeck', ...msg }, PARENT_ORIGIN);
}

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };
let amazon = null;        // Daten der Amazon-Seite
let currentOffers = [];   // Angebote des gewählten Idealo-Produkts
let currentProduct = null;
let lastMatches = [];

// ---------- Hilfsfunktionen ----------

const fmt = (n) => n == null ? '–' : n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text || '';
  el.classList.toggle('error', isError);
}
function show(id, on = true) { $(id).classList.toggle('hidden', !on); }

// ---------- Einstellungen ----------

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  settings = { ...DEFAULTS, ...stored };
  $('set-sort').value = settings.sort;
  $('sort-inline').value = settings.sort;
  $('set-count').value = String(settings.count);
  $('set-freeship').checked = settings.freeShipOnly;
  $('set-autoload').checked = settings.autoload;
  $('set-showbutton').checked = settings.showButton;
  $('set-autocheck').checked = settings.autoCheck;
  $('set-searchlabels').checked = settings.searchLabels;
  $('set-cartcheck').checked = settings.cartCheck;
}
async function saveSettings() {
  settings = {
    sort: $('set-sort').value,
    count: parseInt($('set-count').value, 10),
    freeShipOnly: $('set-freeship').checked,
    autoload: $('set-autoload').checked,
    showButton: $('set-showbutton').checked,
    autoCheck: $('set-autocheck').checked,
    searchLabels: $('set-searchlabels').checked,
    cartCheck: $('set-cartcheck').checked,
  };
  $('sort-inline').value = settings.sort;
  await chrome.storage.sync.set(settings);
  if (currentOffers.length || currentProduct) renderOffers();
}

// ---------- Amazon-Seite auslesen (scrapeAmazon kommt aus scrape.js) ----------

async function readAmazonTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https:\/\/(www\.)?amazon\.(de|com|co\.uk|fr|it|es|nl|at)\//.test(tab.url)) return null;
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapeAmazon });
  return res?.result || null;
}

async function loadProduct(url, preDoc = null, fallbackTitle = '') {
  setStatus('Lade Angebote von Idealo …');
  show('history', false);
  show('matches', false);
  show('result', false);
  const doc = preDoc || (await fetchHtml(url)).doc;
  const ld = parseJsonLd(doc);
  const title = clean(doc.querySelector('h1')?.textContent) || ld?.name || fallbackTitle || 'Idealo-Produkt';

  currentProduct = { url, title, ld };
  currentOffers = parseOffers(doc);
  setStatus('');
  renderOffers();
  loadHistory(); // läuft nebenher, die Angebote sind schon sichtbar
}

// ---------- Preisverlauf ----------

let historyPeriod = '3M';
let historyToken = 0; // verhindert, dass eine ältere, langsamere Antwort eine neuere überschreibt
const PERIOD_TEXT = { '3M': '3 Monate', '6M': '6 Monate', '1Y': '12 Monate' };

async function loadHistory() {
  const id = productIdFromUrl(currentProduct?.url);
  if (!id) { show('history', false); return; }
  show('history', true);
  document.querySelectorAll('.periods button').forEach((b) =>
    b.classList.toggle('active', b.dataset.period === historyPeriod));

  const token = ++historyToken;
  const chart = $('history-chart');
  const verdict = $('history-verdict');
  chart.className = 'history-chart';
  chart.innerHTML = '<div class="msg">Lade Preisverlauf …</div>';
  $('history-readout').textContent = '';
  $('history-stats').innerHTML = '';
  verdict.textContent = '';
  verdict.className = 'history-verdict';

  try {
    const h = await fetchPriceHistory(id, historyPeriod);
    if (token !== historyToken) return;
    if (!h) throw new Error('zu wenige Datenpunkte');

    const amzPrice = amazon ? parseEuro(amazon.priceText) : null;
    renderSparkline(chart, $('history-readout'), h.points, { amazonPrice: amzPrice, fmt });

    const { avg, low, high } = h.stats;
    $('history-stats').innerHTML =
      `<div>Ø Preis<b>${fmt(avg)}</b></div><div>Tiefstpreis<b>${fmt(low)}</b></div><div>Höchstpreis<b>${fmt(high)}</b></div>`;

    // Einordnung des heutigen Idealo-Preises
    const cur = h.points[h.points.length - 1].price;
    const span = PERIOD_TEXT[historyPeriod];
    let text, cls;
    if (cur <= low * 1.02) { text = `Sehr guter Preis – nahe am Tiefstpreis der letzten ${span}`; cls = 'good'; }
    else if (cur < avg * 0.97) { text = `Unter dem Durchschnitt der letzten ${span}`; cls = 'good'; }
    else if (cur > avg * 1.03) { text = `Über dem Durchschnitt der letzten ${span} – Abwarten könnte sich lohnen`; cls = 'bad'; }
    else { text = `Durchschnittlicher Preis für die letzten ${span}`; cls = 'neutral'; }
    verdict.textContent = text;
    verdict.classList.add(cls);
  } catch (err) {
    console.warn('[Idealo-Preischeck] Preisverlauf:', err);
    if (token === historyToken) {
      // Grund klein mit anzeigen – hilft bei der Fehlersuche
      chart.innerHTML = '<div class="msg">Verlauf derzeit nicht verfügbar<small></small></div>';
      chart.querySelector('small').textContent = err.message || '';
    }
  }
}

// ---------- Darstellung ----------

function renderOffers() {
  if (!currentProduct) return;
  const mode = settings.sort;
  let list = currentOffers;
  if (settings.freeShipOnly) list = list.filter((o) => o.shipping === 0);
  const sorted = sortOffers(list, mode);

  $('ide-title').textContent = currentProduct.title;
  $('open-idealo').href = currentProduct.url;
  show('btn-back', lastMatches.length > 1);

  const labels = { total: 'Günstigster Gesamtpreis', price: 'Günstigster Artikelpreis', rating: 'Bestbewerteter Shop' };
  $('best-label').textContent = labels[mode];

  // Beim Gesamtpreis nur Angebote mit bekanntem Versand als "günstigster" werten
  const best = mode === 'total' ? (sorted.find((o) => o.totalKnown) || sorted[0]) : sorted[0];
  const ld = currentProduct.ld;
  let bestValue = null;
  if (best) {
    bestValue = mode === 'price' ? best.price : best.total;
    $('best-price').textContent = fmt(bestValue);
    const shipInfo = best.shipping === 0 ? 'versandkostenfrei'
      : best.shipping != null ? `+ ${fmt(best.shipping)} Versand` : 'Versand siehe Shop';
    $('best-shop').textContent = `bei ${best.shop} · ${shipInfo}`;
  } else if (ld?.low != null) {
    bestValue = ld.low;
    $('best-label').textContent = 'Günstigster Preis (laut Idealo)';
    $('best-price').textContent = fmt(ld.low);
    $('best-shop').textContent = 'Einzelangebote konnten nicht gelesen werden';
  } else {
    $('best-price').textContent = '–';
    $('best-shop').textContent = settings.freeShipOnly
      ? 'Kein Angebot mit kostenlosem Versand gefunden'
      : 'Keine Angebote gefunden – öffne Idealo direkt';
  }

  // Ersparnis gegenüber Amazon
  const sav = $('savings');
  sav.className = 'savings';
  sav.textContent = '';
  const amzPrice = amazon ? parseEuro(amazon.priceText) : null;
  if (amzPrice != null && bestValue != null && mode !== 'rating') {
    const diff = Math.round((amzPrice - bestValue) * 100) / 100;
    if (diff > 0.009) { sav.textContent = `${fmt(diff)} günstiger\nals Amazon`; sav.classList.add('good'); }
    else if (diff < -0.009) { sav.textContent = `Amazon ist\n${fmt(-diff)} günstiger`; sav.classList.add('bad'); }
    else sav.textContent = 'Gleicher Preis\nwie Amazon';
    sav.style.whiteSpace = 'pre-line';
  }

  // Dem Button auf der Amazon-Seite den Preis melden (gleiche Regeln wie die automatische Prüfung)
  postToPage({ type: 'best', ...computeBest(currentOffers, ld, settings, amzPrice) });

  // Preisspanne / Anzahl
  const totals = currentOffers.filter((o) => o.totalKnown).map((o) => o.total);
  const parts = [];
  const count = currentOffers.length || ld?.count;
  if (count) parts.push(`${count} Angebote`);
  if (totals.length > 1) parts.push(`Gesamtpreise ${fmt(Math.min(...totals))} – ${fmt(Math.max(...totals))}`);
  else if (ld?.low != null && ld?.high != null) parts.push(`Preise ${fmt(ld.low)} – ${fmt(ld.high)}`);
  $('range').textContent = parts.join(' · ');

  // Liste
  const ul = $('offers');
  ul.innerHTML = '';
  sorted.slice(0, settings.count).forEach((o) => {
    const li = document.createElement('li');
    const ship = o.shipping === 0 ? '<span class="free">versandkostenfrei</span>'
      : o.shipping != null ? `${fmt(o.price)} + ${fmt(o.shipping)} Versand` : 'zzgl. Versand (siehe Shop)';
    const rating = o.rating != null ? `★ ${o.rating.toLocaleString('de-DE')}${o.reviews ? ` (${o.reviews})` : ''}` : '';
    const main = mode === 'price' ? o.price : o.total;
    li.innerHTML = `
      <a class="o-shop"></a>
      <div class="o-total">${fmt(main)}</div>
      <div class="o-sub"></div>
      <div class="o-sub right">${ship}</div>`;
    const a = li.querySelector('.o-shop');
    a.textContent = o.shop;
    if (o.url) { a.href = o.url; a.target = '_blank'; a.rel = 'noopener'; }
    li.querySelector('.o-sub').textContent = [rating, o.delivery].filter(Boolean).join(' · ');
    ul.appendChild(li);
  });

  show('result', true);
}

function renderMatches(matches) {
  lastMatches = matches;
  const ul = $('match-list');
  ul.innerHTML = '';
  matches.forEach((m) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="m-title"></span><span class="m-price"></span>';
    li.querySelector('.m-title').textContent = m.title;
    li.querySelector('.m-price').textContent = m.price != null ? `ab ${fmt(m.price)}` : '';
    li.addEventListener('click', () => loadProduct(m.url, null, m.title).catch(handleError));
    ul.appendChild(li);
  });
  show('result', false);
  show('matches', true);
  postToPage({ type: 'best', value: null, state: 'choose' });
}

function handleError(err) {
  console.error(err);
  postToPage({ type: 'best', value: null, state: 'error' });
  setStatus(`Fehler: ${err.message}. Du kannst die Suche unten direkt auf Idealo öffnen.`, true);
  const q = $('query').value;
  $('open-idealo').href = `${IDEALO}/preisvergleich/MainSearchProductCategory.html?q=${encodeURIComponent(q)}`;
  show('result', true);
  show('offers', false);
  document.querySelector('#result .card').classList.add('hidden');
}

/**
 * Probiert die Suchbegriffe nacheinander (z. B. EAN → Marke + Modell → Titel).
 * Ein Treffer wird nur automatisch geladen, wenn er sicher zum Produkt passt (refText);
 * sonst darf man aus den gefundenen Kandidaten selbst wählen.
 */
async function runSearch(queries, refText) {
  document.querySelector('#result .card').classList.remove('hidden');
  show('offers', true);
  currentProduct = null;
  currentOffers = [];
  show('matches', false);
  show('result', false);

  let candidates = [];
  let firstSearchUrl = null;
  for (const query of queries) {
    setStatus(`Suche auf Idealo nach „${query}“ …`);
    const { direct, matches, searchUrl } = await searchIdealo(query);
    firstSearchUrl ??= searchUrl;
    // Direkte Weiterleitung von Idealo (z. B. per EAN) ist eindeutig
    if (direct) { lastMatches = []; return loadProduct(direct.url, direct.doc); }

    const scored = scoreMatches(matches, refText);
    const best = scored.find((m) => m.confident);
    if (best) {
      setStatus('');
      lastMatches = scored;
      if (settings.autoload) return loadProduct(best.url, null, best.title);
      return renderMatches(scored);
    }
    if (!candidates.length && scored.length) candidates = scored;
  }

  if (candidates.length) {
    renderMatches(candidates);
    setStatus('Kein eindeutiger Treffer auf Idealo – wähle das passende Produkt oder ändere den Suchbegriff.');
    return;
  }

  setStatus('Dieses Produkt gibt es auf Idealo offenbar nicht. Passe den Suchbegriff an oder öffne die Suche auf Idealo.');
  postToPage({ type: 'best', value: null, state: 'none' });
  currentProduct = null;
  $('open-idealo').href = firstSearchUrl;
  document.querySelector('#result .card').classList.add('hidden');
  show('offers', false);
  show('result', true);
}

// ---------- Start ----------

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  $('version').textContent = `Version ${chrome.runtime.getManifest().version}`;

  $('btn-settings').addEventListener('click', () => $('settings').classList.toggle('hidden'));
  ['set-sort', 'set-count', 'set-freeship', 'set-autoload', 'set-showbutton', 'set-autocheck', 'set-searchlabels', 'set-cartcheck'].forEach((id) =>
    $(id).addEventListener('change', saveSettings));

  if (EMBED) {
    document.body.classList.add('embed');
    show('btn-close', true);
    $('btn-close').addEventListener('click', () => postToPage({ type: 'close' }));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') postToPage({ type: 'close' }); });
    // Höhe an die Amazon-Seite melden, damit das Panel mitwächst
    new ResizeObserver(() => postToPage({ type: 'height', height: document.documentElement.scrollHeight }))
      .observe(document.body);
  }
  $('sort-inline').addEventListener('change', () => { $('set-sort').value = $('sort-inline').value; saveSettings(); });
  $('btn-back').addEventListener('click', () => renderMatches(lastMatches));
  document.querySelectorAll('.periods button').forEach((b) => b.addEventListener('click', () => {
    historyPeriod = b.dataset.period;
    loadHistory();
  }));
  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('query').value.trim();
    if (q) runSearch([q], q).catch(handleError);
  });

  try {
    // Im Panel liefert das Content-Script die Amazon-Daten mit; im Popup lesen wir den Tab selbst aus.
    amazon = EMBED ? JSON.parse(decodeURIComponent(location.hash.slice(1))) : await readAmazonTab();
  } catch (e) {
    console.warn(e);
  }

  show('search', true);
  if (!amazon) {
    setStatus('Öffne eine Amazon-Produktseite – oder suche hier direkt auf Idealo.');
    return;
  }

  $('amz-title').textContent = amazon.title;
  $('amz-price').textContent = amazon.priceText || 'Preis nicht gefunden';
  $('amz-meta').textContent = [amazon.ean && `EAN ${amazon.ean}`, amazon.model && `Modell ${amazon.model}`]
    .filter(Boolean).join(' · ');
  show('amazon', true);

  const queries = buildQueries(amazon);
  $('query').value = queries[0];
  runSearch(queries, referenceText(amazon)).catch(handleError);
});
