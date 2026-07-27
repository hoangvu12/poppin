import sharp from 'sharp';

const hex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

const luminance = (r, g, b) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const [l1, l2] = [luminance(...a), luminance(...b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

/** Bucket pixels into a coarse grid, then merge nearby buckets into a palette. */
function palette(data, channels, topN = 6) {
  const buckets = new Map();
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (channels === 4 && data[i + 3] < 128) continue;
    const key = `${r >> 4}.${g >> 4}.${b >> 4}`;
    const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b;
    buckets.set(key, e);
  }
  const total = [...buckets.values()].reduce((a, e) => a + e.n, 0) || 1;
  const cands = [...buckets.values()]
    .map(e => ({ n: e.n, rgb: [e.r / e.n, e.g / e.n, e.b / e.n] }))
    .sort((a, b) => b.n - a.n);

  const out = [];
  for (const c of cands) {
    if (out.length >= topN) break;
    // skip colours too close to one we already took
    const near = out.some(o => Math.hypot(o.rgb[0] - c.rgb[0], o.rgb[1] - c.rgb[1], o.rgb[2] - c.rgb[2]) < 40);
    if (near) continue;
    const [h, s, l] = rgbToHsl(...c.rgb);
    out.push({ ...c, hex: hex(...c.rgb), share: +(c.n / total).toFixed(4), h: Math.round(h), s: +s.toFixed(2), l: +l.toFixed(2) });
  }
  return out;
}

/** Row-wise mean/variance profile → rough layout regions (nav bars, content, tab bar). */
function layoutBands(data, w, h, channels) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let sum = 0, sq = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * channels;
      const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
      sum += v; sq += v * v;
    }
    const mean = sum / w;
    rows.push({ y, mean, sd: Math.sqrt(Math.max(0, sq / w - mean * mean)) });
  }
  // A midpoint threshold collapses on screens dominated by one flat colour, so
  // key off the distribution instead: a row is "content" if its horizontal
  // variance clears the 40th percentile of all rows by a clear margin.
  const busy = rows.map(r => r.sd);
  const sorted = [...busy].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const thresh = Math.max(pct(0.4) * 1.35, pct(0.95) * 0.08, 1.5);

  const bands = [];
  let cur = null;
  const GAP = Math.max(2, Math.round(h * 0.012)); // bridge thin gutters between rows of one block
  rows.forEach((r, i) => {
    if (busy[i] > thresh) {
      if (cur && i - cur.end <= GAP) cur.end = i;
      else { if (cur) bands.push(cur); cur = { start: i, end: i }; }
    }
  });
  if (cur) bands.push(cur);

  return bands
    .filter(b => b.end - b.start >= Math.max(2, h * 0.015))
    .map(b => ({ from: +(b.start / h).toFixed(3), to: +(b.end / h).toFixed(3) }))
    .slice(0, 14);
}

export async function analyzeImage(file) {
  const img = sharp(file);
  const meta = await img.metadata();
  const W = 120;
  const { data, info } = await img.resize({ width: W }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;

  const pal = palette(data, ch);
  const bg = pal[0];
  const fg = pal.slice(1).sort((a, b) => contrast(b.rgb, bg.rgb) - contrast(a.rgb, bg.rgb))[0] || pal[0];
  const accent = pal.slice(1).filter(c => c.s > 0.35).sort((a, b) => b.s - a.s)[0] || null;

  const bands = layoutBands(data, info.width, info.height, ch);
  const avgL = pal.reduce((a, c) => a + c.l * c.share, 0) / (pal.reduce((a, c) => a + c.share, 0) || 1);

  return {
    dimensions: { width: meta.width, height: meta.height, aspect: +(meta.width / meta.height).toFixed(3) },
    theme: bg.l < 0.35 ? 'dark' : bg.l > 0.75 ? 'light' : 'mid',
    avgLightness: +avgL.toFixed(3),
    palette: pal.map(({ hex, share, h, s, l }) => ({ hex, share, hue: h, sat: s, light: l })),
    background: bg.hex,
    foreground: fg.hex,
    accent: accent ? accent.hex : null,
    textContrast: +contrast(fg.rgb, bg.rgb).toFixed(2),
    contrastPasses: { aa: contrast(fg.rgb, bg.rgb) >= 4.5, aaLarge: contrast(fg.rgb, bg.rgb) >= 3 },
    contentBands: bands,
    density: +(bands.reduce((a, b) => a + (b.to - b.from), 0)).toFixed(3),
  };
}
