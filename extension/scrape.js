// Liest Produktdaten von einer Amazon-Produktseite.
// Wird als Content-Script geladen und vom Popup per chrome.scripting im Tab ausgeführt.
// doc/pageUrl erlauben auch eine im Hintergrund geladene Seite (Warenkorb-Check).
// Die Funktion muss eigenständig bleiben (keine Verweise nach außen), weil chrome.scripting sie serialisiert.
function scrapeAmazon(doc = document, pageUrl = location.href) {
  const txt = (sel) => doc.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
  // Gültige EAN/GTIN (8, 12, 13 oder 14 Ziffern mit korrekter Prüfziffer)?
  const isGtin = (v) => {
    if (!/^(\d{8}|\d{12,14})$/.test(v)) return false;
    const d = v.split('').map(Number);
    const check = d.pop();
    const sum = d.reverse().reduce((acc, n, i) => acc + n * (i % 2 === 0 ? 3 : 1), 0);
    return (10 - (sum % 10)) % 10 === check;
  };
  const title = txt('#productTitle') || txt('#title') || doc.title;

  // Preis: Amazon lässt das versteckte .a-offscreen-Feld teils leer,
  // daher zuerst Euro- und Cent-Teil der sichtbaren Anzeige, dann versteckte Formularwerte.
  let priceText = '';
  const PRICE_BOXES = ['#corePriceDisplay_desktop_feature_div', '#corePrice_desktop', '#corePrice_feature_div', '#apex_desktop'];
  for (const box of PRICE_BOXES) {
    const p = doc.querySelector(`${box} .a-price.priceToPay, ${box} .a-price`);
    if (!p) continue;
    const off = p.querySelector('.a-offscreen')?.textContent?.trim();
    if (off && /\d/.test(off)) { priceText = off; break; }
    const whole = p.querySelector('.a-price-whole')?.textContent.replace(/[^\d.]/g, '');
    const frac = p.querySelector('.a-price-fraction')?.textContent.replace(/\D/g, '') || '00';
    if (whole) { priceText = `${whole},${frac} €`; break; }
  }
  if (!priceText) {
    const raw = doc.querySelector('#twister-plus-price-data-price, #attach-base-product-price')?.value;
    if (raw && !isNaN(parseFloat(raw))) {
      priceText = parseFloat(raw).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    }
  }
  if (!priceText) priceText = txt('#priceblock_ourprice') || txt('#priceblock_dealprice');

  // Detailtabellen durchsuchen (EAN, Modellnummer, Marke)
  const details = {};
  const rows = doc.querySelectorAll(
    '#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, ' +
    '#prodDetails tr, #detailBullets_feature_div li, #productOverview_feature_div tr, ' +
    '.prodDetTable tr'
  );
  rows.forEach((r) => {
    let k, v;
    if (r.tagName === 'LI') {
      const spans = r.querySelectorAll('span > span');
      if (spans.length >= 2) { k = spans[0].textContent; v = spans[1].textContent; }
    } else {
      k = r.querySelector('th, td:first-child')?.textContent;
      v = r.querySelector('td:last-child')?.textContent;
    }
    if (k && v) {
      k = k.replace(/[‎‏:‏‎]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      details[k] = v.replace(/[‎‏]/g, '').replace(/\s+/g, ' ').trim();
    }
  });
  const pick = (...keys) => {
    for (const key of keys) for (const k in details) if (k.includes(key)) return details[k];
    return '';
  };

  let brand = pick('marke', 'hersteller', 'brand');
  if (!brand) brand = txt('#bylineInfo').replace(/^(Marke|Besuche den|Visit the)\s*:?\s*/i, '').replace(/-?Store$/i, '').trim();

  const asinMatch = new URL(pageUrl, 'https://www.amazon.de').pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
  return {
    title,
    priceText,
    brand,
    model: (() => { const m = pick('modellnummer', 'herstellerreferenz', 'modell', 'model number', 'item model'); return isGtin(m.replace(/\s+/g, '')) ? '' : m; })(),
    ean: (() => {
      // EAN steht bei Amazon.de mal als "EAN", mal als "Global Trade Identification Number" oder "UPC" –
      // und manchmal gar nicht, aber versteckt in einem anderen Feld (z. B. "Modellnummer" = 6922621507062).
      for (const key of ['ean', 'gtin', 'global trade identification number', 'upc']) {
        for (const k in details) {
          if (k === key || k.startsWith(key + ' ') || k.endsWith(' ' + key)) {
            const m = details[k].match(/\d{8,14}/);
            if (m) return m[0];
          }
        }
      }
      for (const k in details) {
        const v = details[k].replace(/\s+/g, '');
        if (isGtin(v)) return v;
      }
      return '';
    })(),
    asin: asinMatch ? asinMatch[1].toUpperCase() : (pick('asin') || ''),
    url: pageUrl,
  };
}
