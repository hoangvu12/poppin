import { sleep } from './browser.mjs';

/** Alt text looks like "Cash App iOS Home screen" or "Orb Social iOS Wallet Overview containing Card UI element". */
export function parseAlt(alt) {
  if (!alt) return {};
  const m = /^(.*?)\s+(iOS|Android|Web)\s+(.*?)(?:\s+screen)?(?:\s+containing\s+.*)?$/i.exec(alt.trim());
  if (!m) return {};
  return { appName: m[1].trim(), platform: m[2], patternLabel: m[3].trim() || null };
}

/** h1 looks like "Orb Social iOS Wallet Overview". */
export function parseH1(h1, appName, platform) {
  if (!h1) return {};
  let rest = h1.trim();
  if (appName && rest.toLowerCase().startsWith(appName.toLowerCase())) rest = rest.slice(appName.length).trim();
  const pm = /^(iOS|Android|Web)\s+/i.exec(rest);
  const plat = platform || pm?.[1];
  if (pm) rest = rest.slice(pm[0].length).trim();
  return { name: rest || null, platform: plat || null };
}

// NOTE: the functions below run inside the page, so they cannot close over
// anything in this module — each declares its own `pick` helper.

const IN_PAGE_LISTING = () => {
  // Bytescale bakes the resize into a signed `enc=` token, so `&w=` is rejected
  // with a 400. The widest srcset candidate is the only way to a bigger render.
  const pick = (img) => {
    if (!img) return null;
    const set = img.getAttribute('srcset');
    if (set) {
      const best = set.split(',')
        .map(p => p.trim().split(/\s+/))
        .map(([u, d]) => ({ u, w: d && d.endsWith('w') ? parseInt(d) : 0 }))
        .filter(c => c.u)
        .sort((a, b) => b.w - a.w)[0];
      if (best) return best.u;
    }
    return img.currentSrc || img.src || null;
  };

  const seen = new Set();
  const out = [];
  for (const a of document.querySelectorAll('a[href^="/explore/screens/"]')) {
    const id = a.getAttribute('href').split('/')[3];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const img = a.querySelector('img');
    out.push({
      id,
      name: a.getAttribute('aria-label') || null,
      alt: img?.getAttribute('alt') || null,
      imageUrl: pick(img),
    });
  }
  return out;
};

/**
 * Scroll a listing page until it stops producing new cards (or we hit `limit`).
 * Mobbin's grid is not virtualised, so cards accumulate in the DOM.
 */
export async function collectListing(page, { limit = 200, maxScrolls = 60, delay = 1200 } = {}) {
  let last = 0, stagnant = 0;
  for (let i = 0; i < maxScrolls; i++) {
    const items = await page.evaluate(IN_PAGE_LISTING);
    if (items.length >= limit) break;
    if (items.length === last) { if (++stagnant >= 3) break; } else stagnant = 0;
    last = items.length;
    await page.mouse.wheel(0, 6000);
    await sleep(delay);
  }
  const items = await page.evaluate(IN_PAGE_LISTING);
  return items.slice(0, limit).map(it => ({ ...it, ...parseAlt(it.alt) }));
}

const IN_PAGE_DETAIL = () => {
  const pick = (img) => {
    if (!img) return null;
    const set = img.getAttribute('srcset');
    if (set) {
      const best = set.split(',')
        .map(p => p.trim().split(/\s+/))
        .map(([u, d]) => ({ u, w: d && d.endsWith('w') ? parseInt(d) : 0 }))
        .filter(c => c.u)
        .sort((a, b) => b.w - a.w)[0];
      if (best) return best.u;
    }
    return img.currentSrc || img.src || null;
  };

  const txt = (el) => el?.textContent?.trim() || null;
  const headings = [...document.querySelectorAll('h1,h2,h3')];
  const h1 = headings.find(h => h.tagName === 'H1');
  const similar = headings.find(h => /explore similar|similar screens/i.test(h.textContent || ''));
  const desc = headings.find(h => h.tagName === 'H2' && h !== similar);

  // Everything at or after "Explore similar screens" describes OTHER screens —
  // their tags and full-size screenshots must not be attributed to this one.
  const before = (el) => !similar || !!(similar.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);

  const tags = [];
  for (const a of document.querySelectorAll('a[href^="/explore/"]')) {
    const parts = a.getAttribute('href').split('/').filter(Boolean); // explore, platform, kind, slug
    if (parts.length !== 4 || !before(a)) continue;
    const [, platform, kind, slug] = parts;
    if (!['screens', 'ui-elements', 'flows'].includes(kind)) continue;
    tags.push({ kind, platform, slug, label: txt(a) });
  }

  const imgs = [...document.querySelectorAll('img')].filter(before);
  const logo = imgs.find(i => /logo/i.test(i.alt || '') || /app_logos|products/.test(i.src));
  const hero = imgs
    .filter(i => i !== logo && !/logo/i.test(i.alt || ''))
    .map(i => ({ el: i, area: (i.naturalWidth || 0) * (i.naturalHeight || 0) }))
    .filter(i => i.area > 40000)
    .sort((a, b) => b.area - a.area)[0];

  return {
    url: location.href,
    h1: txt(h1),
    description: txt(desc),
    appLogoUrl: logo ? pick(logo) : null,
    appNameFromLogo: (logo?.alt || '').replace(/\s*logo\s*$/i, '').trim() || null,
    heroUrl: hero ? pick(hero.el) : null,
    heroAlt: hero?.el.alt || null,
    tags,
  };
};

export async function extractDetail(page) {
  const d = await page.evaluate(IN_PAGE_DETAIL);
  const fromAlt = parseAlt(d.heroAlt);
  const appName = d.appNameFromLogo || fromAlt.appName || null;
  const { name, platform } = parseH1(d.h1, appName, fromAlt.platform);
  const seen = new Set();
  const tags = d.tags.filter(t => {
    const k = `${t.kind}:${t.slug}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  return {
    id: d.url.split('/explore/screens/')[1]?.split(/[?#]/)[0] || null,
    name: name || fromAlt.patternLabel || null,
    appName,
    platform,
    description: d.description,
    appLogoUrl: d.appLogoUrl,
    imageUrl: d.heroUrl,
    tags,
  };
}

/**
 * Flow listing pages are shaped differently from pattern/ui-element pages: they
 * render whole flows inline, each an ordered run of frames overlaid with a link
 * to /explore/flows/<uuid>. There are no /explore/screens/ cards to collect.
 */
const IN_PAGE_FLOWS = () => {
  const pick = (img) => {
    if (!img) return null;
    const set = img.getAttribute('srcset');
    if (set) {
      const best = set.split(',')
        .map(p => p.trim().split(/\s+/))
        .map(([u, d]) => ({ u, w: d && d.endsWith('w') ? parseInt(d) : 0 }))
        .filter(c => c.u)
        .sort((a, b) => b.w - a.w)[0];
      if (best) return best.u;
    }
    return img.currentSrc || img.src || null;
  };

  const out = [];
  for (const art of document.querySelectorAll('article')) {
    const anchors = [...art.querySelectorAll('a[href^="/explore/flows/"]')];
    if (!anchors.length) continue;
    const id = anchors[0].getAttribute('href').split('/')[3];
    if (!id) continue;

    // Each flow <article> reads: title / "on" / app / description / tag links.
    const lines = (art.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
    const onIdx = lines.findIndex(l => l.toLowerCase() === 'on');
    // Flows with a video preview prefix the title with a duration ("00:11 ...").
    const title = (onIdx > 0 ? lines.slice(0, onIdx).join(' ') : (lines[0] || ''))
      .replace(/^\d{1,2}:\d{2}\s+/, '').trim() || null;
    const appName = onIdx >= 0 ? (lines[onIdx + 1] || null) : null;
    const maybeDesc = onIdx >= 0 ? (lines[onIdx + 2] || '') : '';
    const description = maybeDesc.length > 40 ? maybeDesc : null;

    const tags = [];
    const seenTag = new Set();
    for (const a of art.querySelectorAll('a[href^="/explore/"]')) {
      const parts = a.getAttribute('href').split('/').filter(Boolean);
      if (parts.length !== 4) continue;
      const [, platform, kind, slug] = parts;
      if (!['screens', 'ui-elements', 'flows'].includes(kind)) continue;
      const k = `${kind}:${slug}`;
      if (seenTag.has(k)) continue;
      seenTag.add(k);
      tags.push({ kind, platform, slug, label: a.textContent?.trim() || null });
    }

    const screens = [];
    for (const img of art.querySelectorAll('img')) {
      if (/logo/i.test(img.getAttribute('alt') || '')) continue;
      const url = pick(img);
      if (url) screens.push({ imageUrl: url, alt: img.getAttribute('alt') || null });
    }

    out.push({ id, title, appName, description, tags, screens });
  }
  return out;
};

/**
 * Flow frames are labelled "Airbnb Onboarding screen" — app + flow label, with
 * no platform token, so parseAlt() cannot split them. Peel off the trailing
 * "screen" and the flow label (derived from the slug); what remains is the app.
 */
export function parseFlowAlt(alt, slug, knownLabels = []) {
  if (!alt) return {};
  let s = alt.trim().replace(/\s+screen$/i, '');

  // The alt carries the flow's OWN label, which is not necessarily the listing
  // slug we arrived from (an "Acorns Onboarding" flow appears under
  // creating-account too). Try every known flow label, longest first.
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const candidates = [
    ...knownLabels.filter(Boolean),
    ...(slug ? [slug.split('-').filter(Boolean).join(' ')] : []),
  ].sort((a, b) => b.length - a.length);

  for (const label of candidates) {
    const words = String(label).split(/[\s&-]+/).filter(Boolean).map(esc);
    if (!words.length) continue;
    const tail = new RegExp('\\s+' + words.join('[\\s&-]+') + '$', 'i');
    if (tail.test(s)) { s = s.replace(tail, ''); break; }
  }
  return { appName: s.trim() || null };
}

export async function collectFlows(page, { slug = null, knownLabels = [], limit = 20, maxScrolls = 40, delay = 1400 } = {}) {
  let last = 0, stagnant = 0;
  for (let i = 0; i < maxScrolls; i++) {
    const fl = await page.evaluate(IN_PAGE_FLOWS);
    if (fl.length >= limit) break;
    if (fl.length === last) { if (++stagnant >= 3) break; } else stagnant = 0;
    last = fl.length;
    await page.mouse.wheel(0, 6000);
    await sleep(delay);
  }
  const flows = await page.evaluate(IN_PAGE_FLOWS);
  return flows.slice(0, limit).map(f => {
    // The article text is authoritative; fall back to alt parsing only if the
    // "<title> on <app>" block was missing.
    const alt = f.screens.find(s => s.alt)?.alt;
    const fallback = parseFlowAlt(alt, slug, knownLabels);
    return {
      ...f,
      appName: f.appName ?? fallback.appName ?? null,
      platform: parseAlt(alt).platform ?? null,
    };
  });
}

/** Read the taxonomy (patterns / ui-elements / flows) offered for a platform. */
export async function extractTaxonomy(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href^="/explore/"]')) {
      const parts = a.getAttribute('href').split('/').filter(Boolean);
      if (parts.length !== 4) continue;
      const [, platform, kind, slug] = parts;
      if (!['screens', 'ui-elements', 'flows'].includes(kind)) continue;
      const k = `${kind}:${platform}:${slug}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ kind, platform, slug, label: a.textContent?.trim() || null });
    }
    return out;
  });
}
