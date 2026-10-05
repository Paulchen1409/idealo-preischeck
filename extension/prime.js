// Prime-Check: Lohnt es sich, bis zum nächsten Prime-Event zu warten?
//
// Grundlage ist Idealos täglicher Preisverlauf (bis ca. 15 Monate zurück). Für jedes vergangene
// Prime-Event wird der Prime-Rabatt des Produkts bestimmt:
//   Normalpreis = Median der 30 Tage vor der "Vorwoche" (Tag −37 … −8 vor Start)
//   Prime-Preis = günstigster Preis von 7 Tagen vor Start (frühe Angebote) bis zum letzten Event-Tag
//   Rabatt      = 1 − Prime-Preis / Normalpreis
// Die Rabatte des letzten Prime Days und der letzten Prime Deal Days werden auf den heutigen Bestpreis
// angewendet (je höchstens bis auf den damaligen Prime-Preis) und als Spanne gezeigt. So wird ein Produkt, das vor einem Jahr einfach günstiger war (ohne
// Prime-Rabatt), nicht als "Warten lohnt sich" gewertet.
'use strict';

// Termine aus Amazons Pressemitteilungen (press.aboutamazon.com/de). Neue Termine kommen per Update.
const PRIME_EVENTS = [
  { type: 'deal-days', name: 'Prime Deal Days', start: '2024-10-08', end: '2024-10-09' },
  { type: 'prime-day', name: 'Prime Day',       start: '2025-07-08', end: '2025-07-11' },
  { type: 'deal-days', name: 'Prime Deal Days', start: '2025-10-07', end: '2025-10-08' },
  { type: 'prime-day', name: 'Prime Day',       start: '2026-06-23', end: '2026-06-26' },
  { type: 'deal-days', name: 'Prime Deal Days', start: '2026-10-06', end: '2026-10-07' },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDays = (iso, n) => isoDay(new Date(new Date(`${iso}T12:00:00`).getTime() + n * DAY_MS));
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / DAY_MS);

/**
 * Nächstes Event (laufend oder kommend). Ist keins angekündigt, wird eins geschätzt: das letzte Event
 * derselben Art + 52 Wochen (gleicher Wochentag). Liefert { event, status: 'ongoing'|'upcoming'|'estimated', inDays }.
 */
function nextPrimeEvent(today = isoDay(new Date())) {
  const ongoing = PRIME_EVENTS.find((e) => e.start <= today && today <= e.end);
  if (ongoing) return { event: ongoing, status: 'ongoing', inDays: 0 };
  const upcoming = PRIME_EVENTS.filter((e) => e.start > today).sort((a, b) => a.start.localeCompare(b.start))[0];
  if (upcoming) return { event: upcoming, status: 'upcoming', inDays: daysBetween(today, upcoming.start) };
  const estimates = ['prime-day', 'deal-days'].map((type) => {
    const last = PRIME_EVENTS.filter((e) => e.type === type).sort((a, b) => b.start.localeCompare(a.start))[0];
    if (!last) return null;
    let start = last.start, end = last.end;
    while (start <= today) { start = addDays(start, 364); end = addDays(end, 364); }
    return { type, name: last.name, start, end };
  }).filter(Boolean).sort((a, b) => a.start.localeCompare(b.start));
  const est = estimates[0];
  return est ? { event: est, status: 'estimated', inDays: daysBetween(today, est.start) } : null;
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Prime-Rabatte eines Produkts für alle vergangenen Events, die im Verlauf liegen.
 * points: [{ date: 'YYYY-MM-DD', price }] (aus fetchPriceHistory). Liefert neueste zuerst:
 * [{ event, base, primePrice, discount }]
 */
function analyzePrimeHistory(points, today = isoDay(new Date())) {
  if (!points?.length) return [];
  const byDate = new Map(points.map((p) => [p.date, p.price]));
  const firstDate = points[0].date;
  const prices = (from, to) => {
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) if (byDate.has(d)) out.push(byDate.get(d));
    return out;
  };
  return PRIME_EVENTS
    .filter((e) => e.end < today)
    .map((event) => {
      const baseFrom = addDays(event.start, -37), baseTo = addDays(event.start, -8);
      if (baseFrom < firstDate) return null;                    // Verlauf reicht nicht weit genug zurück
      const basePrices = prices(baseFrom, baseTo);
      const windowPrices = prices(addDays(event.start, -7), event.end);
      if (basePrices.length < 10 || windowPrices.length < 3) return null;
      const base = median(basePrices);
      const primePrice = Math.min(...windowPrices);
      const discount = Math.max(0, 1 - primePrice / base);
      return { event, base, primePrice, discount: discount < 0.02 ? 0 : discount };
    })
    .filter(Boolean)
    .sort((a, b) => b.event.start.localeCompare(a.event.start));
}

/**
 * Vergleichs-Events: das letzte Event derselben Art wie das nächste (zuerst) und das letzte der anderen Art.
 * Prime Day und Prime Deal Days fallen oft unterschiedlich stark aus – beide zusammen ergeben eine Spanne.
 */
function pickReferences(analysis, nextType) {
  const same = analysis.find((a) => a.event.type === nextType);
  const other = analysis.find((a) => a.event.type !== nextType);
  return [same, other].filter(Boolean);
}

/**
 * Erwartete Ersparnis pro Stück, wenn man bis zum nächsten Event wartet – als Spanne über die Vergleichs-Events.
 * bestNow: günstigster Preis heute (Amazon oder Idealo).
 * Liefert { low, high, refs: [{ ref, saving, expected }] } oder null.
 */
function estimatePrimeSaving(bestNow, analysis, nextType) {
  const refs = pickReferences(analysis, nextType);
  if (!refs.length || !(bestNow > 0)) return null;
  const round = (n) => Math.round(n * 100) / 100;
  const perRef = refs.map((ref) => {
    const byDiscount = bestNow * ref.discount;
    const byLastPrice = bestNow - ref.primePrice;        // nicht günstiger rechnen als beim letzten Mal
    const saving = round(Math.max(0, Math.min(byDiscount, byLastPrice)));
    return { ref, saving, expected: round(bestNow - saving), capped: byLastPrice < byDiscount && saving > 0 };
  });
  const savings = perRef.map((r) => r.saving);
  return { low: Math.min(...savings), high: Math.max(...savings), refs: perRef };
}

/** "6.–7. Okt. 2026" */
function formatEventRange(e) {
  const a = new Date(`${e.start}T12:00:00`), b = new Date(`${e.end}T12:00:00`);
  const month = (d) => d.toLocaleDateString('de-DE', { month: 'short' });
  if (a.getMonth() === b.getMonth()) return `${a.getDate()}.–${b.getDate()}. ${month(b)} ${b.getFullYear()}`;
  return `${a.getDate()}. ${month(a)} – ${b.getDate()}. ${month(b)} ${b.getFullYear()}`;
}
