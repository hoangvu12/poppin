import { launch, BASE, sleep } from './browser.mjs';

/**
 * Authenticated data access for the logged-in Mobbin app. Unlike the anonymous
 * /explore surface (DOM-only, capped at 60), the signed-in app is backed by
 * JSON endpoints and RSC payloads we can read directly with the session cookie.
 *
 * A page context is used (not bare fetch) so the Supabase session cookie, the
 * mobbin.com origin, and any CSRF/referer checks are satisfied automatically.
 */
export async function withSession(fn, { headless = true } = {}) {
  const { ctx, page } = await launch({ headless });
  try {
    // Land on a real app page so cookies/origin apply to subsequent requests.
    await page.goto(`${BASE}/discover/apps/ios/latest`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1500);
    const loggedIn = await page.evaluate(() => !document.querySelector('a[href="/login"]'));
    if (!loggedIn) throw new Error('not signed in — run `poppin import-cookies` or `poppin login`');
    return await fn({ ctx, page });
  } finally {
    await ctx.close();
  }
}

async function postJson(page, path, body) {
  const r = await page.request.post(`${BASE}${path}`, {
    data: body, headers: { 'content-type': 'application/json' },
  });
  if (!r.ok()) throw new Error(`${path} -> ${r.status()}`);
  return r.json();
}

/**
 * The full searchable catalog for a platform: every app with its tagline,
 * curated search keywords, preview screens (raw Supabase URLs) and logo.
 * This is the same index Mobbin's own search bar downloads.
 */
export async function fetchCatalog(page, platform = 'ios') {
  const data = await postJson(page, '/api/search-bar/fetch-searchable-apps', { platform });
  const arr = Array.isArray(data) ? data : (data?.data || data?.apps || Object.values(data || {})[0]);
  if (!Array.isArray(arr)) throw new Error('unexpected catalog shape');
  return arr.map(a => ({
    id: a.id,
    platform: a.platform || platform,
    appName: a.appName,
    tagline: a.appTagline || null,
    financePlus: !!a.is_finance_plus,
    keywords: Array.isArray(a.keywords) ? a.keywords : [],
    logoUrl: pickLogo(a.appLogoCdnImgSources),
    previewScreens: (a.previewScreens || [])
      .map(s => ({ id: s.id, url: s.screenUrl }))
      .filter(s => s.id && s.url),
  }));
}

function pickLogo(sources) {
  if (!sources) return null;
  if (typeof sources === 'string') return sources;
  if (Array.isArray(sources)) return sources[0]?.url || sources[0] || null;
  return sources.src || sources.url || sources.png || sources.webp || null;
}

// Next streams data in RSC flight rows via self.__next_f.push([1,"<chunk>"]).
function reassembleFlight(html) {
  const parts = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g)) {
    try { parts.push(JSON.parse(m[1])); } catch {}
  }
  return parts.join('');
}

/** Balanced-brace scan for JSON objects anchored on a given key. */
function grabObjects(src, keyRe, cap = 20000) {
  const out = [];
  for (const m of src.matchAll(keyRe)) {
    let i = m.index;
    while (i >= 0 && src[i] !== '{') i--;
    if (i < 0) continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < src.length && j < i + cap; j++) {
      const ch = src[j];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { end = j; break; }
    }
    if (end > 0) { try { out.push(JSON.parse(src.slice(i, end + 1))); } catch {} }
  }
  return out;
}

// In-page collector: logged-in screen cards are <a href="/screens/<id>"> with
// a bytescale image and the screen name in alt. The grid lazy-loads, so the
// caller scrolls between reads. Take the widest srcset candidate for each.
const IN_PAGE_APP_SCREENS = () => {
  const pick = (img) => {
    const set = img?.getAttribute('srcset');
    if (set) {
      const best = set.split(',').map(p => p.trim().split(/\s+/))
        .map(([u, d]) => ({ u, w: d && d.endsWith('w') ? parseInt(d) : 0 }))
        .filter(c => c.u).sort((a, b) => b.w - a.w)[0];
      if (best) return best.u;
    }
    return img?.currentSrc || img?.src || null;
  };
  const seen = new Set();
  const out = [];
  for (const a of document.querySelectorAll('a[href^="/screens/"]')) {
    const id = a.getAttribute('href').split('/')[2]?.split(/[?#]/)[0];
    if (!id || seen.has(id)) continue;
    const img = a.querySelector('img');
    const url = pick(img);
    if (!url) continue;                 // skip the hidden search-bar prefetch (no card img)
    seen.add(id);
    out.push({ id, url, name: img.getAttribute('alt') || null });
  }
  return out;
};

/**
 * Full screen list for one app version. The grid lazy-loads, so we render the
 * page and scroll until the screen count stops growing. Returns servable
 * (bytescale) URLs, which the image cache rewrites to the clean CDN form.
 */
export async function fetchAppScreens(page, appUrlBase, { maxScrolls = 60, delay = 1100 } = {}) {
  const url = `${BASE}${appUrlBase.replace(/\/$/, '')}/screens`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3500);
  // The grid virtualizes: only on-screen cards exist in the DOM, so accumulate
  // across scrolls here rather than trusting the final snapshot.
  const acc = new Map();
  let stagnant = 0;
  for (let i = 0; i < maxScrolls; i++) {
    const items = await page.evaluate(IN_PAGE_APP_SCREENS);
    const before = acc.size;
    for (const it of items) if (!acc.has(it.id)) acc.set(it.id, it);
    if (acc.size === before) { if (++stagnant >= 4) break; } else stagnant = 0;
    await page.mouse.wheel(0, 6000);
    await sleep(delay);
  }
  return [...acc.values()];
}

/**
 * Resolve an app's canonical URL (slug + latest version) from its catalog id.
 * `/apps/<anything>-<platform>-<appId>` 307-redirects to the canonical
 * `/apps/<slug>-<platform>-<appId>/<versionId>/screens` — the server keys off
 * the appId alone, so the slug we send does not even need to be correct.
 * Returns the base path (without the trailing /screens).
 */
export async function resolveAppUrl(page, appId, appName = '', platform = 'ios') {
  const res = await page.request.get(`${BASE}/apps/app-${platform}-${appId}`, { maxRedirects: 0 });
  const loc = res.headers()['location'];
  if (!loc) return null;
  const m = loc.match(new RegExp(`/apps/[^/]+-${appId}/[0-9a-f-]{36}`, 'i'));
  return m ? m[0] : null;
}
