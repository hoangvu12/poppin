import { BASE, sleep } from './browser.mjs';
import { collectListing, collectFlows, extractDetail, extractTaxonomy } from './extract.mjs';
import { cacheImage } from './images.mjs';
import { upsertScreen, upsertApp, upsertTaxonomy, setTags, reindex, reindexFlow, upsertFlow } from './db.mjs';

import { KINDS } from './config.mjs';

async function goto(page, url, delay) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(delay);
}

/** Crawl the platform hub to learn which patterns / elements / flows exist. */
export async function syncTaxonomy(db, page, { platform = 'mobile', delay = 1500, log = console.log } = {}) {
  const seen = new Map();
  for (const seed of [`${BASE}/explore/${platform}`, `${BASE}/explore/${platform}/screens`]) {
    await goto(page, seed, delay);
    for (const t of await extractTaxonomy(page)) seen.set(`${t.kind}:${t.platform}:${t.slug}`, t);
  }
  for (const t of seen.values()) upsertTaxonomy(db, t.kind, t.platform, t.slug, t.label);
  const byKind = {};
  for (const t of seen.values()) byKind[t.kind] = (byKind[t.kind] || 0) + 1;
  log(`  taxonomy: ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(' ') || 'none found'}`);
  return [...seen.values()];
}

/** Pull one listing page (a pattern / element / flow) into the DB. */
export async function syncListing(db, page, { platform, kind, slug, limit = 60, delay = 1500, log = console.log } = {}) {
  const url = `${BASE}/explore/${platform}/${kind}/${slug}`;
  await goto(page, url, delay);
  const items = await collectListing(page, { limit });
  for (const it of items) {
    upsertScreen(db, {
      id: it.id, name: it.name, appName: it.appName,
      platform: it.platform, imageUrl: it.imageUrl,
    });
    if (it.appName) upsertApp(db, it.appName, null, it.platform);
    setTags(db, it.id, [{ kind, slug, label: null }]);
    reindex(db, it.id);
  }
  log(`  ${kind}/${slug}: ${items.length} screens`);
  return items;
}

/** Pull whole flows (ordered screen runs) from a flow listing page. */
export async function syncFlows(db, page, { platform, slug, limit = 15, delay = 1500, log = console.log } = {}) {
  await goto(page, `${BASE}/explore/${platform}/flows/${slug}`, delay);
  const knownLabels = db.prepare("SELECT label FROM taxonomy WHERE kind = 'flows' AND label IS NOT NULL")
    .all().map(r => r.label);
  const flows = await collectFlows(page, { slug, knownLabels, limit });
  for (const f of flows) {
    upsertFlow(db, { ...f, slug, platform: f.platform || platform });
    if (f.appName) upsertApp(db, f.appName, null, f.platform);
    for (const t of f.tags || []) upsertTaxonomy(db, t.kind, t.platform, t.slug, t.label);
    reindexFlow(db, f.id);
  }
  const frames = flows.reduce((a, f) => a + f.screens.length, 0);
  log(`  flows/${slug}: ${flows.length} flows, ${frames} frames`);
  return flows;
}

export async function downloadFlowFrames(db, { limit = 500, log = console.log } = {}) {
  const rows = db.prepare(`SELECT flow_id, ord, image_url FROM flow_screens
                           WHERE image_url IS NOT NULL AND local_path IS NULL LIMIT ?`).all(limit);
  let ok = 0, fail = 0;
  for (const r of rows) {
    try {
      const p = await cacheImage(`flow-${r.flow_id}-${String(r.ord).padStart(3, '0')}`, r.image_url);
      db.prepare('UPDATE flow_screens SET local_path = ? WHERE flow_id = ? AND ord = ?').run(p, r.flow_id, r.ord);
      ok++;
    } catch (e) { fail++; if (fail <= 3) log(`  ! frame ${r.flow_id}#${r.ord}: ${e.message}`); }
  }
  log(`  flow frames: ${ok} cached${fail ? `, ${fail} failed` : ''}`);
  return { ok, fail };
}

/** Visit a screen's own page for description + full tag set. */
export async function syncDetail(db, page, id, { delay = 1500 } = {}) {
  await goto(page, `${BASE}/explore/screens/${id}`, delay);
  const d = await extractDetail(page);
  if (!d.id) return null;
  upsertScreen(db, {
    id: d.id, name: d.name, appName: d.appName, platform: d.platform,
    description: d.description, imageUrl: d.imageUrl, detailDone: true,
  });
  if (d.appName) upsertApp(db, d.appName, d.appLogoUrl, d.platform);
  if (d.tags.length) setTags(db, d.id, d.tags);
  for (const t of d.tags) upsertTaxonomy(db, t.kind, t.platform, t.slug, t.label);
  reindex(db, d.id);
  return d;
}

export async function downloadPending(db, { limit = 200, log = console.log, force = false } = {}) {
  const rows = db.prepare(`SELECT id, image_url FROM screens
                           WHERE image_url IS NOT NULL AND (local_path IS NULL OR ?) LIMIT ?`)
    .all(force ? 1 : 0, limit);
  let ok = 0, fail = 0;
  for (const r of rows) {
    try {
      const p = await cacheImage(r.id, r.image_url, { force });
      db.prepare('UPDATE screens SET local_path = ? WHERE id = ?').run(p, r.id);
      ok++;
    } catch (e) { fail++; if (fail <= 3) log(`  ! image ${r.id}: ${e.message}`); }
  }
  log(`  images: ${ok} cached${fail ? `, ${fail} failed` : ''}`);
  return { ok, fail };
}

export { KINDS };
