import { fetchCatalog, fetchAppScreens, resolveAppUrl } from './api.mjs';
import { upsertCatalogApp, upsertScreen, upsertApp, setAppUrl, reindex } from './db.mjs';
import { cacheImage } from './images.mjs';

/**
 * Pull the full searchable catalog for a platform into the DB, plus each app's
 * preview screens (stored as regular screens so search + images work on them).
 */
export async function syncCatalog(db, page, { platform = 'ios', withPreviews = true, log = console.log } = {}) {
  const apps = await fetchCatalog(page, platform);
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

/** Deep-fetch every screen for one catalog app (not just previews). */
export async function syncAppScreens(db, page, catalogId, { log = console.log } = {}) {
  const app = db.prepare('SELECT * FROM catalog_apps WHERE id = ? OR id LIKE ?').get(catalogId, `${catalogId}%`);
  if (!app) throw new Error(`no catalog app ${catalogId} — run \`poppin catalog\` first`);

  let appUrl = app.app_url;
  if (!appUrl) {
    appUrl = await resolveAppUrl(page, app.id, app.app_name, app.platform);
    if (!appUrl) throw new Error(`could not resolve app URL for ${app.app_name}`);
    setAppUrl(db, app.id, appUrl);
  }

  const screens = await fetchAppScreens(page, appUrl);
  for (const s of screens) {
    upsertScreen(db, { id: s.id, name: s.name, appName: app.app_name, platform: app.platform, imageUrl: s.url });
    reindex(db, s.id);
  }
  log(`  ${app.app_name}: ${screens.length} screens`);
  return { app, screens };
}

/**
 * Cache raw images for screens missing a local copy. Scope with `ids` (specific
 * screens) or `appName` (one app); otherwise it caches any pending screen.
 */
export async function cachePending(db, { limit = 1000, appName = null, ids = null, log = console.log } = {}) {
  let rows;
  if (ids && ids.length) {
    const ph = ids.map(() => '?').join(',');
    rows = db.prepare(`SELECT id, image_url FROM screens
                       WHERE image_url IS NOT NULL AND local_path IS NULL AND id IN (${ph}) LIMIT ?`)
      .all(...ids, limit);
  } else if (appName) {
    rows = db.prepare('SELECT id, image_url FROM screens WHERE image_url IS NOT NULL AND local_path IS NULL AND app_name = ? LIMIT ?').all(appName, limit);
  } else {
    rows = db.prepare('SELECT id, image_url FROM screens WHERE image_url IS NOT NULL AND local_path IS NULL LIMIT ?').all(limit);
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
