// Gemeinsame Idealo-Logik für Popup, Panel und Amazon-Button:
// Seiten laden (über den Hintergrund-Worker), Suche, Treffer-Prüfung, Angebote auslesen.
'use strict';

const IDEALO = 'https://www.idealo.de';

/** "1.234,56 €" → 1234.56 */
function parseEuro(text) {
  if (!text) return null;
  const m = String(text).replace(/ /g, ' ').match(/(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?\s*€/);
  if (!m) return null;
  return parseFloat(m[1].replace(/\./g, '') + '.' + (m[2] || '0'));
}
const abs = (href) => { try { return new URL(href, IDEALO).href; } catch { return null; } };
const clean = (s) => (s || '').replace(/­/g, '').replace(/\s+/g, ' ').trim();

// Idealo wird über den Hintergrund-Worker geladen – so klappt es im Popup und im Panel auf Amazon gleich.
// priority: 'high' (jemand wartet, Standard) oder 'low' (Stapelarbeit wie der Warenkorb-Check)
async function fetchIdealo(url, priority = 'high') {
  const res = await chrome.runtime.sendMessage({ type: 'fetch-idealo', url, priority });
  if (!res || res.error) throw new Error(res?.error || 'Keine Antwort vom Hintergrunddienst');
  return res; // { ok, status, url, html }
}

async function fetchHtml(url, priority = 'high') {
  const res = await fetchIdealo(url, priority);
  if (!res.ok) throw new Error(`Idealo antwortet mit Status ${res.status}`);
  return { doc: new DOMParser().parseFromString(res.html, 'text/html'), url: res.url };
}

// ---------- Preisverlauf ----------

/** Idealo-Produkt-ID aus einer Produkt-URL (…/OffersOfProduct/201731668_-xt35-polk-audio.html) */
const productIdFromUrl = (url) => (String(url || '').match(/OffersOfProduct\/(\d+)/) || [])[1] || null;

/**
 * Preisverlauf von Idealo (dieselbe Schnittstelle, die Idealo für seine eigene Kurve nutzt).
 * period: '3M' | '6M' | '1Y'. Liefert { points: [{ t, date, price }], stats } oder null,
 * wenn es keinen Verlauf gibt. Preise in Euro.
 */
async function fetchPriceHistory(productId, period = '3M') {
  if (!productId) return null;
  const res = await fetchIdealo(`${IDEALO}/price-chart/sites/1/products/${productId}/history?period=${period}`);
  if (res.status === 404) return null; // dieses Produkt hat keinen Verlauf
  if (!res.ok) throw new Error(`Idealo antwortet mit ${res.status}`);
  let json;
  try { json = JSON.parse(res.html); } catch { throw new Error('Preisverlauf hat ein unerwartetes Format'); }
  const points = (json.data || [])
    .filter((d) => d && typeof d.y === 'number' && d.x)
    .map((d) => ({ t: new Date(`${d.x}T12:00:00`).getTime(), date: d.x, price: d.y / 100 }))
    .sort((a, b) => a.t - b.t);
  if (points.length < 2) return null;
  const s = json.statistics || {};
  const eur = (c) => (typeof c === 'number' ? c / 100 : null);
  return {
    points,
    stats: {
      avg: eur(s.avgPrice) ?? points.reduce((sum, p) => sum + p.price, 0) / points.length,
      low: eur(s.lowestPrice) ?? Math.min(...points.map((p) => p.price)),
      high: eur(s.highestPrice) ?? Math.max(...points.map((p) => p.price)),
    },
  };
}

/** Marke ohne Firmenzusätze ("Audyssey Laboratories, Inc." → "Audyssey Laboratories") */
function cleanBrand(b) {
  return (b || '').replace(/(?:,\s*|\s+)(inc|gmbh|ltd|llc|co|corp|ag|se|s\.?a)\.?$/i, '').replace(/[,.]/g, ' ').trim();
}

/** Kurzer Suchbegriff aus dem Amazon-Titel */
function shortTitle(a) {
  let t = a.title.split(/\s[|–—]\s|,\s|\s-\s|\s\(/)[0];
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 8) t = words.slice(0, 8).join(' ');
  // Generation steht oft in Klammern ("SoundLink Flex (2. Gen.)") und fiele sonst weg
  const gen = generationOf(a.title);
  if (gen && generationOf(t) !== gen) t += ` ${gen}. Generation`;
  return t.trim();
}

/** Suchbegriffe in sinnvoller Reihenfolge: EAN → Marke + Modell → Titel */
function buildQueries(a) {
  const list = [];
  if (a.ean) list.push(a.ean);
  const brand = cleanBrand(a.brand);
  if (brand && a.model) list.push(`${brand} ${a.model}`);
  list.push(shortTitle(a));
  return [...new Set(list.filter(Boolean))];
}

// ---------- Passt ein Idealo-Treffer zum Amazon-Produkt? ----------

const STOPWORDS = new Set(['und', 'mit', 'für', 'fur', 'der', 'die', 'das', 'von', 'zur', 'zum', 'the', 'and', 'for', 'with', 'of', 'in', 'cm', 'mm']);
const tokens = (s) => clean(s).toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').split(' ')
  .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
const compact = (s) => clean(s).toLowerCase().replace(/[^a-z0-9äöüß]/g, '');

// Generationsangaben: "2. Gen.", "2. Generation", "2nd Gen", "Gen 2", "Generation 2"
const GEN_PATTERNS = [
  /\b(\d{1,2})\s*(?:\.|st|nd|rd|th)?\s*gen(?:eration)?\b\.?/gi,
  /\bgen(?:eration)?\.?\s*(\d{1,2})\b/gi,
];
/** Generation als Zahl (oder null), z. B. "Bose SoundLink Flex (2. Gen.)" → 2 */
function generationOf(text) {
  for (const re of GEN_PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(String(text || ''));
    if (m) return Number(m[1]);
  }
  return null;
}
const stripGeneration = (text) => GEN_PATTERNS.reduce((t, re) => t.replace(re, ' '), String(text || ''));

/**
 * Bewertet, wie gut ein Idealo-Titel zur Referenz (Amazon-Daten oder eigener Suchbegriff) passt.
 * - Modellnummern (Wörter mit Ziffern) müssen übereinstimmen: "XT90" ist kein Treffer für "XT35",
 *   "XT35" aber für "MXT35".
 * - Die Generation muss übereinstimmen: "SoundLink Flex (2. Generation)" ist nicht "SoundLink Flex".
 */
function relevance(matchTitle, refText) {
  const genRef = generationOf(refText);
  const genMatch = generationOf(matchTitle);
  const refClean = stripGeneration(refText);
  const ref = compact(refClean);
  const refWords = new Set(tokens(refClean));
  const words = tokens(stripGeneration(matchTitle));
  if (!words.length) return { score: 0, confident: false };
  const found = words.filter((w) => refWords.has(w) || (w.length >= 4 && ref.includes(w)));
  let score = found.length / words.length;
  const codes = words.filter((w) => /\d/.test(w) && w.length >= 2);
  const codeOk = codes.length === 0 || codes.some((c) => ref.includes(c));
  if (!codeOk) return { score: 0, confident: false };
  // Beide nennen eine Generation, aber verschiedene → anderes Produkt
  if (genRef && genMatch && genRef !== genMatch) return { score: 0, confident: false };
  // Nur eine Seite nennt eine Generation → möglich, aber nicht sicher
  const genUnclear = (genRef || null) !== (genMatch || null);
  if (genUnclear) score *= 0.5;
  return { score, confident: !genUnclear && score >= 0.6 };
}

// ---------- Idealo: Suche ----------

async function searchIdealo(query, priority = 'high') {
  const url = `${IDEALO}/preisvergleich/MainSearchProductCategory.html?q=${encodeURIComponent(query)}`;
  const { doc, url: finalUrl } = await fetchHtml(url, priority);

  // Idealo leitet bei eindeutigen Treffern (z. B. EAN) direkt auf die Produktseite weiter
  if (/OffersOfProduct\/\d+/.test(finalUrl)) {
    return { direct: { url: finalUrl, doc }, matches: [], searchUrl: url };
  }

  const byId = new Map();
  // Nur Links aus der echten Ergebnisliste – Idealo zeigt sonst (auch bei 0 Treffern) "Beliebte Produkte"
  // wie Switch 2 oder iPhone an, die nichts mit der Suche zu tun haben.
  const resultLinks = doc.querySelectorAll(
    '[class*="sr-resultList"] a[href*="OffersOfProduct/"], [class*="resultList__item"] a[href*="OffersOfProduct/"]'
  );
  resultLinks.forEach((a) => {
    if (a.closest('[class*="popular"], .swiper, [class*="recommend"], [class*="Recommend"]')) return;
    const href = a.getAttribute('href');
    const id = (href.match(/OffersOfProduct\/(\d+)/) || [])[1];
    if (!id) return;
    const box = a.closest('[class*="resultList__item"]') || a.closest('[class*="sr-resultItem"]') || a.parentElement;
    const entry = byId.get(id) || { id, url: abs(href.split('#')[0]), title: '', price: null, offerCount: '' };
    const titleCand = clean(
      box?.querySelector('[class*="productSummary__title"], [class*="title"], [class*="Title"], h2, h3')?.textContent ||
      a.getAttribute('title') || a.querySelector('img')?.alt || a.textContent
    );
    if (titleCand.length > entry.title.length && titleCand.length < 200) entry.title = titleCand;
    const priceEl = box?.querySelector('[class*="detailedPriceInfo__price"], [class*="price"], [class*="Price"]');
    const p = parseEuro(priceEl?.textContent) ?? parseEuro(box?.textContent);
    if (p != null && (entry.price == null || p < entry.price)) entry.price = p;
    const cnt = (box?.textContent || '').match(/(\d+)\s+Angebot/);
    if (cnt) entry.offerCount = cnt[1];
    byId.set(id, entry);
  });

  return { direct: null, matches: [...byId.values()].filter((m) => m.title).slice(0, 8), searchUrl: url };
}

// ---------- Idealo: Produktseite / Angebote ----------

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Versandinfo von Idealo auswerten. Idealo schreibt hier z. B.:
 *   "237,81 € inkl. Versand"          → Gesamtpreis (nicht die Versandkosten!)
 *   "zzgl. 4,99 € Versand"            → Versandkosten
 *   "Zzgl. Versandkosten, siehe Shop" → unbekannt
 *   "versandkostenfrei"               → 0
 * Gibt { shipping, total } zurück (jeweils Zahl oder null).
 */
function parseShippingInfo(text, price) {
  const t = clean(text).replace(/ /g, ' ');
  if (!t) return { shipping: null, total: null };
  const num = (s) => parseFloat(s.replace(/\./g, '').replace(',', '.'));

  const incl = t.match(/(\d{1,3}(?:\.\d{3})*,\d{2})\s*€\s*inkl\.?\s*Versand/i);
  if (incl) {
    const total = num(incl[1]);
    return { total, shipping: round2(Math.max(0, total - price)) };
  }
  if (/versandkostenfrei|kostenloser versand|versand kostenlos|gratis versand/i.test(t)) {
    return { shipping: 0, total: price };
  }
  const zzgl = t.match(/(\d{1,3}(?:\.\d{3})*,\d{2})\s*€\s*Versand/i) ||
               t.match(/Versand(?:kosten)?:?\s*(\d{1,3}(?:\.\d{3})*,\d{2})\s*€/i);
  if (zzgl) {
    const shipping = num(zzgl[1]);
    return { shipping, total: round2(price + shipping) };
  }
  return { shipping: null, total: null }; // z. B. "siehe Shop"
}

function parseOffers(doc) {
  const items = doc.querySelectorAll('li.productOffers-listItem');
  const offers = [];
  items.forEach((li) => {
    const priceEl = li.querySelector('.productOffers-listItemOfferPrice') ||
                    li.querySelector('[class*="OfferPrice"]');
    const price = parseEuro(priceEl?.textContent);
    if (price == null) return;

    // Erstes nicht-leeres Versand-Element
    const shipText = [...li.querySelectorAll('[class*="ShippingDetails"]')]
      .map((e) => clean(e.textContent))
      .find((s) => /versand|€/i.test(s)) || '';
    const { shipping, total } = parseShippingInfo(shipText, price);

    // Shopname: Logo-Alttext "… bei <Shop>" ist am genauesten (z. B. Händler auf dem Amazon Marketplace),
    // sonst das Tracking-Attribut von Idealo.
    let shop = '';
    for (const img of li.querySelectorAll('img[alt]')) {
      const m = img.getAttribute('alt').match(/\sbei\s+(.+)$/i);
      if (m) { shop = m[1].trim(); break; }
    }
    if (!shop) {
      try { shop = JSON.parse(li.getAttribute('data-mtrx-click') || '{}').shop_name || ''; } catch { /* egal */ }
    }
    shop = shop || 'Unbekannter Shop';

    const stars = clean(li.querySelector('[class*="ShopV2Stars"]')?.textContent);
    const ratingNum = (stars.match(/(\d[,.]\d)/) || [])[1];
    const reviews = clean(li.querySelector('[class*="ShopV2NORatings"]')?.textContent).replace(/\D/g, '');

    const delivery = clean(li.querySelector('.productOffers-listItemOfferDeliveryStatus')?.textContent);
    const link = li.querySelector('a.productOffers-listItemOfferPrice[href]') ||
                 li.querySelector('a.productOffers-listItemTitle[href]') || li.querySelector('a[href]');

    offers.push({
      shop,
      price,
      shipping,                         // null = unbekannt ("siehe Shop")
      total: total ?? price,            // bei unbekanntem Versand: Artikelpreis
      totalKnown: total != null,
      rating: ratingNum ? parseFloat(ratingNum.replace(',', '.')) : null,
      reviews: reviews ? Number(reviews).toLocaleString('de-DE') : '',
      delivery: delivery.slice(0, 60),
      url: link ? abs(link.getAttribute('href')) : null,
    });
  });
  return offers;
}

/** Fallback: strukturierte Daten (JSON-LD) der Produktseite */
function parseJsonLd(doc) {
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent);
      const list = Array.isArray(data) ? data : [data, ...(data['@graph'] || [])];
      for (const d of list) {
        if (d && d['@type'] === 'Product') {
          const o = d.offers || {};
          return {
            name: d.name,
            low: o.lowPrice != null ? parseFloat(o.lowPrice) : (o.price != null ? parseFloat(o.price) : null),
            high: o.highPrice != null ? parseFloat(o.highPrice) : null,
            count: o.offerCount || null,
          };
        }
      }
    } catch { /* ignorieren */ }
  }
  return null;
}

function sortOffers(list, mode) {
  const arr = [...list];
  if (mode === 'price') arr.sort((a, b) => a.price - b.price);
  else if (mode === 'rating') arr.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || a.total - b.total);
  else arr.sort((a, b) => a.total - b.total);
  return arr;
}


// ---------- Automatische Prüfung (ohne Bedienoberfläche) ----------

/** Text, gegen den Idealo-Treffer geprüft werden */
function referenceText(a) {
  return [a.title, cleanBrand(a.brand), a.model].filter(Boolean).join(' ');
}

/** Treffer bewerten, unpassende (z. B. falsche Modellnummer) entfernen, beste zuerst */
function scoreMatches(matches, refText) {
  return matches
    .map((m) => ({ ...m, ...relevance(m.title, refText) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * Sucht das passende Idealo-Produkt zu den Amazon-Daten:
 * EAN → Marke + Modell → Titel. Liefert { url, doc?, title?, matches }.
 * url ist null, wenn es keinen sicheren Treffer gibt (matches enthält dann ggf. Kandidaten).
 */
async function findProduct(amazon, onQuery, priority = 'high') {
  const refText = referenceText(amazon);
  let candidates = [];
  let firstSearchUrl = null;
  for (const query of buildQueries(amazon)) {
    onQuery?.(query);
    const { direct, matches, searchUrl } = await searchIdealo(query, priority);
    firstSearchUrl ??= searchUrl;
    if (direct) return { url: direct.url, doc: direct.doc, matches: [], searchUrl };
    const scored = scoreMatches(matches, refText);
    const best = scored.find((m) => m.confident);
    if (best) return { url: best.url, title: best.title, matches: scored, searchUrl };
    if (!candidates.length && scored.length) candidates = scored;
  }
  return { url: null, matches: candidates, searchUrl: firstSearchUrl };
}

/**
 * Bestpreis nach den Einstellungen (Sortierung, nur versandkostenfrei) – gleiche Regeln
 * wie im Popup. Bei "Shop-Bewertung" zählt für den Button der günstigste Gesamtpreis.
 */
function computeBest(offers, ld, settings, amzPrice) {
  const mode = settings.sort === 'price' ? 'price' : 'total';
  let list = offers;
  if (settings.freeShipOnly) list = list.filter((o) => o.shipping === 0);
  const sorted = sortOffers(list, mode);
  const pick = mode === 'price' ? sorted[0] : (sorted.find((o) => o.totalKnown) || sorted[0]);
  let value = pick ? (mode === 'price' ? pick.price : pick.total) : null;
  if (value == null && !offers.length && ld?.low != null) value = ld.low;
  return {
    value,
    kind: mode,
    shop: pick?.shop || '',
    diff: amzPrice != null && value != null ? round2(amzPrice - value) : null,
    state: value != null ? 'ok' : 'none',
  };
}

// ---------- Ein Amazon-Artikel komplett prüfen (Suche + Warenkorb) ----------

/** Ergebnis pro ASIN beim Hintergrund-Worker zwischenspeichern (30 Min., über Seiten hinweg) */
const asinCache = {
  /** Aktuelles Ergebnis (höchstens 30 Min. alt) oder null */
  get: (asin) => chrome.runtime.sendMessage({ type: 'asin-get', asin })
    .then((hit) => hit?.data ?? null).catch(() => null),
  /** Ergebnis bis maxAge alt, mit Alter: { data, age } oder null */
  getEntry: (asin, maxAge) => chrome.runtime.sendMessage({ type: 'asin-get', asin, maxAge }).catch(() => null),
  set: (asin, data) => chrome.runtime.sendMessage({ type: 'asin-set', asin, data }).catch(() => false),
};

/**
 * Sucht das Produkt auf Idealo und liest die Angebote. Liefert ein speicherbares Ergebnis
 * (ohne DOM): { state: 'found'|'choose'|'none', productUrl, searchUrl, offers, ld }.
 * Der Bestpreis wird erst beim Anzeigen mit computeBest() nach den aktuellen Einstellungen berechnet.
 */
async function checkAmazonItem(data, priority = 'high') {
  const found = await findProduct(data, null, priority);
  if (!found.url) {
    return { state: found.matches.length ? 'choose' : 'none', searchUrl: found.searchUrl, offers: [], ld: null };
  }
  const doc = found.doc || (await fetchHtml(found.url, priority)).doc;
  const offers = parseOffers(doc).map(({ shop, price, shipping, total, totalKnown }) =>
    ({ shop, price, shipping, total, totalKnown }));
  return { state: 'found', productUrl: found.url, searchUrl: found.searchUrl, offers, ld: parseJsonLd(doc) };
}
