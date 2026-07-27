import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import os from 'node:os';

/**
 * Where the library lives. An explicit POPPIN_DATA wins. Otherwise a ./data
 * directory in the current folder is used when it already exists, so running
 * inside the repo keeps its own library. A global install with no local data
 * falls back to the home directory rather than dropping a data folder into
 * whatever directory the command happened to run in.
 */
function resolveDataDir() {
  if (process.env.POPPIN_DATA) return path.resolve(process.env.POPPIN_DATA);
  const local = path.resolve('data');
  if (fs.existsSync(local)) return local;
  return path.join(os.homedir(), '.poppin');
}

export const DATA_DIR = resolveDataDir();
export const IMG_DIR = path.join(DATA_DIR, 'images');

export function open() {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, 'poppin.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS screens (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    app_name    TEXT,
    platform    TEXT,
    description TEXT,
    image_url   TEXT,
    local_path  TEXT,
    detail_done INTEGER NOT NULL DEFAULT 0,
    first_seen  TEXT NOT NULL,
    updated     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS apps (
    name     TEXT PRIMARY KEY,
    logo_url TEXT,
    platform TEXT
  );

  -- The authenticated catalog (from fetch-searchable-apps): one row per app,
  -- keyed by Mobbin's app id, carrying the curated search keywords.
  CREATE TABLE IF NOT EXISTS catalog_apps (
    id           TEXT PRIMARY KEY,
    platform     TEXT,
    app_name     TEXT,
    tagline      TEXT,
    finance_plus INTEGER NOT NULL DEFAULT 0,
    keywords     TEXT,
    logo_url     TEXT,
    app_url      TEXT,
    updated      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_catalog_platform ON catalog_apps(platform);

  CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(
    id UNINDEXED, app_name, tagline, keywords,
    tokenize = 'porter unicode61'
  );

  -- kind: 'screens' (pattern) | 'ui-elements' | 'flows'
  CREATE TABLE IF NOT EXISTS taxonomy (
    kind     TEXT NOT NULL,
    platform TEXT NOT NULL,
    slug     TEXT NOT NULL,
    label    TEXT,
    PRIMARY KEY (kind, platform, slug)
  );

  CREATE TABLE IF NOT EXISTS screen_tags (
    screen_id TEXT NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
    kind      TEXT NOT NULL,
    slug      TEXT NOT NULL,
    label     TEXT,
    ord       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (screen_id, kind, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_tags_kind_slug ON screen_tags(kind, slug);

  -- A flow is an ordered run of screens (e.g. one app's whole signup journey).
  -- Flow listing pages render these inline, so flow frames are stored separately
  -- from the individually-addressable screens above.
  CREATE TABLE IF NOT EXISTS flows (
    id          TEXT PRIMARY KEY,
    slug        TEXT,
    platform    TEXT,
    app_name    TEXT,
    title       TEXT,
    description TEXT,
    tags        TEXT,
    n_screens   INTEGER NOT NULL DEFAULT 0,
    updated     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS flow_screens (
    flow_id    TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    ord        INTEGER NOT NULL,
    image_url  TEXT,
    local_path TEXT,
    alt        TEXT,
    PRIMARY KEY (flow_id, ord)
  );

  -- analysis output (palette etc.), one row per screen
  CREATE TABLE IF NOT EXISTS analysis (
    screen_id TEXT PRIMARY KEY REFERENCES screens(id) ON DELETE CASCADE,
    json      TEXT NOT NULL,
    updated   TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS screens_fts USING fts5(
    id UNINDEXED, name, app_name, description, tags,
    tokenize = 'porter unicode61'
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS flows_fts USING fts5(
    id UNINDEXED, title, app_name, description, tags,
    tokenize = 'porter unicode61'
  );
  `);
}

const now = () => new Date().toISOString();

export function upsertScreen(db, s) {
  db.prepare(`
    INSERT INTO screens (id, name, app_name, platform, description, image_url, local_path, detail_done, first_seen, updated)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name        = COALESCE(excluded.name, screens.name),
      app_name    = COALESCE(excluded.app_name, screens.app_name),
      platform    = COALESCE(excluded.platform, screens.platform),
      description = COALESCE(excluded.description, screens.description),
      image_url   = COALESCE(excluded.image_url, screens.image_url),
      local_path  = COALESCE(excluded.local_path, screens.local_path),
      detail_done = MAX(excluded.detail_done, screens.detail_done),
      updated     = excluded.updated
  `).run(
    s.id, s.name ?? null, s.appName ?? null, s.platform ?? null,
    s.description ?? null, s.imageUrl ?? null, s.localPath ?? null,
    s.detailDone ? 1 : 0, now(), now()
  );
}

export function upsertCatalogApp(db, a) {
  db.prepare(`INSERT INTO catalog_apps (id, platform, app_name, tagline, finance_plus, keywords, logo_url, app_url, updated)
              VALUES (?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                platform     = excluded.platform,
                app_name     = excluded.app_name,
                tagline      = COALESCE(excluded.tagline, catalog_apps.tagline),
                finance_plus = excluded.finance_plus,
                keywords     = COALESCE(excluded.keywords, catalog_apps.keywords),
                logo_url     = COALESCE(excluded.logo_url, catalog_apps.logo_url),
                app_url      = COALESCE(excluded.app_url, catalog_apps.app_url),
                updated      = excluded.updated`)
    .run(a.id, a.platform ?? null, a.appName ?? null, a.tagline ?? null,
         a.financePlus ? 1 : 0, a.keywords?.length ? JSON.stringify(a.keywords) : null,
         a.logoUrl ?? null, a.appUrl ?? null, now());

  const kw = (a.keywords || []).join(' ');
  db.prepare('DELETE FROM catalog_fts WHERE id = ?').run(a.id);
  db.prepare('INSERT INTO catalog_fts (id, app_name, tagline, keywords) VALUES (?,?,?,?)')
    .run(a.id, a.appName || '', a.tagline || '', kw);
}

export function setAppUrl(db, id, url) {
  db.prepare('UPDATE catalog_apps SET app_url = ? WHERE id = ?').run(url, id);
}

export function upsertApp(db, name, logoUrl, platform) {
  if (!name) return;
  db.prepare(`INSERT INTO apps (name, logo_url, platform) VALUES (?,?,?)
              ON CONFLICT(name) DO UPDATE SET
                logo_url = COALESCE(excluded.logo_url, apps.logo_url),
                platform = COALESCE(excluded.platform, apps.platform)`)
    .run(name, logoUrl ?? null, platform ?? null);
}

export function upsertTaxonomy(db, kind, platform, slug, label) {
  db.prepare(`INSERT INTO taxonomy (kind, platform, slug, label) VALUES (?,?,?,?)
              ON CONFLICT(kind, platform, slug) DO UPDATE SET label = COALESCE(excluded.label, taxonomy.label)`)
    .run(kind, platform, slug, label ?? null);
}

export function setTags(db, screenId, tags) {
  const ins = db.prepare(`INSERT INTO screen_tags (screen_id, kind, slug, label, ord) VALUES (?,?,?,?,?)
                          ON CONFLICT(screen_id, kind, slug) DO UPDATE SET label = COALESCE(excluded.label, screen_tags.label)`);
  tags.forEach((t, i) => ins.run(screenId, t.kind, t.slug, t.label ?? null, i));
}

export function reindex(db, screenId) {
  const s = db.prepare('SELECT * FROM screens WHERE id = ?').get(screenId);
  if (!s) return;
  const tags = db.prepare('SELECT label, slug FROM screen_tags WHERE screen_id = ?').all(screenId)
    .map(t => `${t.label || ''} ${t.slug.replace(/-/g, ' ')}`).join(' ');
  db.prepare('DELETE FROM screens_fts WHERE id = ?').run(screenId);
  db.prepare('INSERT INTO screens_fts (id, name, app_name, description, tags) VALUES (?,?,?,?,?)')
    .run(s.id, s.name || '', s.app_name || '', s.description || '', tags);
}

export function reindexFlow(db, flowId) {
  const f = db.prepare('SELECT * FROM flows WHERE id = ?').get(flowId);
  if (!f) return;
  const tags = f.tags ? JSON.parse(f.tags).map(t => `${t.label || ''} ${t.slug.replace(/-/g, ' ')}`).join(' ') : '';
  db.prepare('DELETE FROM flows_fts WHERE id = ?').run(flowId);
  db.prepare('INSERT INTO flows_fts (id, title, app_name, description, tags) VALUES (?,?,?,?,?)')
    .run(f.id, f.title || '', f.app_name || '', f.description || '', `${tags} ${f.slug || ''}`.trim());
}

export function reindexAll(db) {
  db.exec('DELETE FROM screens_fts');
  for (const { id } of db.prepare('SELECT id FROM screens').all()) reindex(db, id);
  db.exec('DELETE FROM flows_fts');
  for (const { id } of db.prepare('SELECT id FROM flows').all()) reindexFlow(db, id);
  db.exec('DELETE FROM catalog_fts');
  for (const a of db.prepare('SELECT * FROM catalog_apps').all()) {
    db.prepare('INSERT INTO catalog_fts (id, app_name, tagline, keywords) VALUES (?,?,?,?)')
      .run(a.id, a.app_name || '', a.tagline || '', a.keywords ? JSON.parse(a.keywords).join(' ') : '');
  }
}

export function upsertFlow(db, f) {
  db.prepare(`INSERT INTO flows (id, slug, platform, app_name, title, description, tags, n_screens, updated)
              VALUES (?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                slug        = COALESCE(excluded.slug, flows.slug),
                platform    = COALESCE(excluded.platform, flows.platform),
                app_name    = COALESCE(excluded.app_name, flows.app_name),
                title       = COALESCE(excluded.title, flows.title),
                description = COALESCE(excluded.description, flows.description),
                tags        = COALESCE(excluded.tags, flows.tags),
                n_screens   = MAX(excluded.n_screens, flows.n_screens),
                updated     = excluded.updated`)
    .run(f.id, f.slug ?? null, f.platform ?? null, f.appName ?? null, f.title ?? null,
         f.description ?? null, f.tags?.length ? JSON.stringify(f.tags) : null,
         f.screens?.length ?? 0, now());

  const ins = db.prepare(`INSERT INTO flow_screens (flow_id, ord, image_url, alt) VALUES (?,?,?,?)
                          ON CONFLICT(flow_id, ord) DO UPDATE SET
                            image_url = COALESCE(excluded.image_url, flow_screens.image_url),
                            alt       = COALESCE(excluded.alt, flow_screens.alt)`);
  (f.screens || []).forEach((s, i) => ins.run(f.id, i, s.imageUrl ?? null, s.alt ?? null));
}

export function stats(db) {
  const one = (q) => db.prepare(q).get();
  return {
    screens: one('SELECT COUNT(*) c FROM screens').c,
    withImages: one('SELECT COUNT(*) c FROM screens WHERE local_path IS NOT NULL').c,
    detailed: one('SELECT COUNT(*) c FROM screens WHERE detail_done = 1').c,
    apps: one('SELECT COUNT(*) c FROM apps').c,
    catalogApps: one('SELECT COUNT(*) c FROM catalog_apps').c,
    catalogByPlatform: db.prepare('SELECT platform, COUNT(*) c FROM catalog_apps GROUP BY platform').all(),
    flows: one('SELECT COUNT(*) c FROM flows').c,
    flowFrames: one('SELECT COUNT(*) c FROM flow_screens').c,
    flowFramesCached: one('SELECT COUNT(*) c FROM flow_screens WHERE local_path IS NOT NULL').c,
    analyzed: one('SELECT COUNT(*) c FROM analysis').c,
    taxonomy: db.prepare('SELECT kind, COUNT(*) c FROM taxonomy GROUP BY kind').all(),
  };
}
