// Mini-Preiskurve (Sparkline) als natives SVG – ohne Bibliothek.
// Grün, wenn der Preis im Zeitraum gefallen ist, rot, wenn er gestiegen ist.
// Optional eine gestrichelte Linie für den Amazon-Preis; mit der Maus lässt sich jeder Tag ablesen.
'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * @param {HTMLElement} container  Ziel für das SVG
 * @param {HTMLElement} readout    Zeile über der Kurve für Datum/Preis beim Überfahren
 * @param {{t:number,date:string,price:number}[]} points  nach Zeit sortiert
 * @param {{amazonPrice?:number|null, fmt:(n:number)=>string}} opts
 * @returns {'down'|'up'|'flat'} Trend im Zeitraum
 */
function renderSparkline(container, readout, points, opts) {
  const { amazonPrice = null, fmt } = opts;
  container.innerHTML = '';

  const W = 320, H = 84, PAD_T = 8, PAD_B = 8, PAD_R = 6;
  const first = points[0], last = points[points.length - 1];
  const prices = points.map((p) => p.price);
  let lo = Math.min(...prices), hi = Math.max(...prices);

  // Amazon-Preis nur einbeziehen, wenn er die Kurve nicht platt drückt
  const span = Math.max(hi - lo, hi * 0.05);
  const showAmazon = amazonPrice != null && amazonPrice > lo - span && amazonPrice < hi + span;
  if (showAmazon) { lo = Math.min(lo, amazonPrice); hi = Math.max(hi, amazonPrice); }
  if (hi - lo < 0.01) { hi += 1; lo -= 1; } // flache Linie mittig

  const t0 = first.t, t1 = last.t;
  const x = (t) => (t1 === t0 ? W / 2 : ((t - t0) / (t1 - t0)) * (W - PAD_R));
  const y = (p) => PAD_T + (1 - (p - lo) / (hi - lo)) * (H - PAD_T - PAD_B);

  const change = (last.price - first.price) / first.price;
  const trend = change < -0.005 ? 'down' : change > 0.005 ? 'up' : 'flat';

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: `trend-${trend}`, role: 'img' });
  svg.setAttribute('aria-label', `Preisverlauf von ${fmt(first.price)} auf ${fmt(last.price)}`);

  // Verlauf unter der Linie
  const gradId = `spark-grad-${Math.random().toString(36).slice(2, 8)}`;
  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(
    // CSS-Variablen wirken nur über style, nicht als SVG-Attribut
    svgEl('stop', { offset: '0%', style: 'stop-color: var(--trend); stop-opacity: .22' }),
    svgEl('stop', { offset: '100%', style: 'stop-color: var(--trend); stop-opacity: 0' }),
  );
  defs.append(grad);
  svg.append(defs);

  // Preise ändern sich sprunghaft → Stufenlinie (Wert gilt bis zum nächsten Tag)
  let d = `M${x(first.t).toFixed(1)},${y(first.price).toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    d += ` H${x(p.t).toFixed(1)} V${y(p.price).toFixed(1)}`;
  }
  const area = `${d} V${H} H${x(first.t).toFixed(1)} Z`;
  svg.append(svgEl('path', { d: area, class: 'spark-area', fill: `url(#${gradId})` }));

  if (showAmazon) {
    const ay = y(amazonPrice).toFixed(1);
    svg.append(svgEl('line', { x1: 0, x2: W, y1: ay, y2: ay, class: 'spark-amazon' }));
    const label = svgEl('text', { x: 2, y: Number(ay) - 3, class: 'spark-amazon-label' });
    label.textContent = 'Amazon';
    svg.append(label);
  }

  svg.append(svgEl('path', { d, class: 'spark-line', 'vector-effect': 'non-scaling-stroke' }));

  const cursor = svgEl('line', { y1: 0, y2: H, class: 'spark-cursor', visibility: 'hidden', 'vector-effect': 'non-scaling-stroke' });
  svg.append(cursor);

  // Punkt am Ende (aktueller Preis) – als HTML-Element, damit er bei gestrecktem SVG rund bleibt
  container.append(svg);
  const dot = document.createElement('span');
  dot.className = 'spark-dot-html';
  container.append(dot);
  const placeDot = (p) => {
    dot.style.left = `${(x(p.t) / W) * 100}%`;
    dot.style.top = `${y(p.price)}px`;
  };
  placeDot(last);

  const dateFmt = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const defaultReadout = () => {
    readout.innerHTML = `Heute <b>${fmt(last.price)}</b> · seit ${dateFmt(first.date)} ` +
      `<b>${change > 0 ? '+' : ''}${(change * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %</b>`;
  };
  defaultReadout();

  // Ablesen per Maus
  const nearest = (clientX) => {
    const r = svg.getBoundingClientRect();
    const tx = t0 + ((clientX - r.left) / r.width) * W / (W - PAD_R) * (t1 - t0);
    let best = points[0];
    for (const p of points) if (Math.abs(p.t - tx) < Math.abs(best.t - tx)) best = p;
    return best;
  };
  svg.addEventListener('mousemove', (e) => {
    const p = nearest(e.clientX);
    const px = x(p.t).toFixed(1);
    cursor.setAttribute('x1', px);
    cursor.setAttribute('x2', px);
    cursor.setAttribute('visibility', 'visible');
    placeDot(p);
    readout.innerHTML = `${dateFmt(p.date)}: <b>${fmt(p.price)}</b>`;
  });
  svg.addEventListener('mouseleave', () => {
    cursor.setAttribute('visibility', 'hidden');
    placeDot(last);
    defaultReadout();
  });

  container.className = `history-chart trend-${trend}`;
  return trend;
}
