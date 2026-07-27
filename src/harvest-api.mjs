import { upsertCatalogApp, upsertScreen, upsertApp, reindex } from './db.mjs';
import { cacheImage } from './images.mjs';

/** Normalise one raw catalog record into the shape the database stores. */
export function normaliseApp(a, platform) {
  return {
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
  };
}

function pickLogo(sources) {
  if (!sources) return null;
  if (typeof sources === 'string') return sources;
  if (Array.isArray(sources)) return sources[0]?.url || sources[0] || null;
  return sources.src || sources.url || sources.png || sources.webp || null;
}

/** Write a normalised catalog into the database. */
export function storeCatalog(db, apps, { platform, withPreviews = true, log = console.log } = {}) {
  log(`  ${platform}: ${apps.length} apps in catalog`);
  let previews = 0;
  for (const a of apps) {
    upsertCatalogApp(db, a);
    if (a.appName) upsertApp(db, a.appName, a.logoUrl, a.platform);
    if (withPreviews) {
      for (const s of a.previewScreens) {
        upsertScreen(db, { id: s.id, appName: a.appName, platform: a.platform, imageUrl: s.url });
        reindex(db, s.id);
        previews++;
      }
    }
  }
  log(`  ${platform}: ${previews} preview screens`);
  return { apps: apps.length, previews };
}

/**
 * Cache images for screens missing a local copy. Scope with `ids` for specific
 * screens or `appName` for one app, otherwise it takes any pending screen.
 */
export async function cachePending(db, { limit = 1000, appName = null, ids = null, log = console.log } = {}) {
  let rows;
  if (ids && ids.length) {
    const ph = ids.map(() => '?').join(',');
    rows = db.prepare(`SELECT id, image_url FROM screens
                       WHERE image_url IS NOT NULL AND local_path IS NULL AND id IN (${ph}) LIMIT ?`)
      .all(...ids, limit);
  } else if (appName) {
    rows = db.prepare(`SELECT id, image_url FROM screens
                       WHERE image_url IS NOT NULL AND local_path IS NULL AND app_name = ? LIMIT ?`)
      .all(appName, limit);
  } else {
    rows = db.prepare(`SELECT id, image_url FROM screens
                       WHERE image_url IS NOT NULL AND local_path IS NULL LIMIT ?`).all(limit);
  }

  let ok = 0, fail = 0;
  for (const r of rows) {
    try {
      const p = await cacheImage(r.id, r.image_url);
      db.prepare('UPDATE screens SET local_path = ? WHERE id = ?').run(p, r.id);
      ok++;
    } catch (e) { fail++; if (fail <= 3) log(`  ! ${r.id}: ${e.message}`); }
  }
  log(`  images: ${ok} cached${fail ? `, ${fail} failed` : ''}`);
  return { ok, fail };
}
