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
    first_seen  TEXT NOT NULL,
    updated     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_screens_app ON screens(app_name);

  CREATE TABLE IF NOT EXISTS apps (
    name     TEXT PRIMARY KEY,
    logo_url TEXT,
    platform TEXT
  );

  -- The searchable catalog: one row per app, carrying the curated keywords
  -- that make conceptual queries work.
  CREATE TABLE IF NOT EXISTS catalog_apps (
    id           TEXT PRIMARY KEY,
    platform     TEXT,
    app_name     TEXT,
    tagline      TEXT,
    finance_plus INTEGER NOT NULL DEFAULT 0,
    keywords     TEXT,
    logo_url     TEXT,
    updated      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_catalog_platform ON catalog_apps(platform);

  CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(
    id UNINDEXED, app_name, tagline, keywords,
    tokenize = 'porter unicode61'
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS screens_fts USING fts5(
    id UNINDEXED, name, app_name, description, tags,
    tokenize = 'porter unicode61'
  );
  `);
}

const now = () => new Date().toISOString();

export function upsertScreen(db, s) {
  db.prepare(`
    INSERT INTO screens (id, name, app_name, platform, description, image_url, local_path, first_seen, updated)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name        = COALESCE(excluded.name, screens.name),
      app_name    = COALESCE(excluded.app_name, screens.app_name),
      platform    = COALESCE(excluded.platform, screens.platform),
      description = COALESCE(excluded.description, screens.description),
      image_url   = COALESCE(excluded.image_url, screens.image_url),
      local_path  = COALESCE(excluded.local_path, screens.local_path),
      updated     = excluded.updated
  `).run(
    s.id, s.name ?? null, s.appName ?? null, s.platform ?? null,
    s.description ?? null, s.imageUrl ?? null, s.localPath ?? null, now(), now()
  );
}

export function upsertApp(db, name, logoUrl, platform) {
  if (!name) return;
  db.prepare(`INSERT INTO apps (name, logo_url, platform) VALUES (?,?,?)
              ON CONFLICT(name) DO UPDATE SET
                logo_url = COALESCE(excluded.logo_url, apps.logo_url),
                platform = COALESCE(excluded.platform, apps.platform)`)
    .run(name, logoUrl ?? null, platform ?? null);
}

export function upsertCatalogApp(db, a) {
  db.prepare(`INSERT INTO catalog_apps (id, platform, app_name, tagline, finance_plus, keywords, logo_url, updated)
              VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                platform     = excluded.platform,
                app_name     = excluded.app_name,
                tagline      = COALESCE(excluded.tagline, catalog_apps.tagline),
                finance_plus = excluded.finance_plus,
                keywords     = COALESCE(excluded.keywords, catalog_apps.keywords),
                logo_url     = COALESCE(excluded.logo_url, catalog_apps.logo_url),
                updated      = excluded.updated`)
    .run(a.id, a.platform ?? null, a.appName ?? null, a.tagline ?? null,
         a.financePlus ? 1 : 0, a.keywords?.length ? JSON.stringify(a.keywords) : null,
         a.logoUrl ?? null, now());

  db.prepare('DELETE FROM catalog_fts WHERE id = ?').run(a.id);
  db.prepare('INSERT INTO catalog_fts (id, app_name, tagline, keywords) VALUES (?,?,?,?)')
    .run(a.id, a.appName || '', a.tagline || '', (a.keywords || []).join(' '));
}

export function reindex(db, screenId) {
  const s = db.prepare('SELECT * FROM screens WHERE id = ?').get(screenId);
  if (!s) return;
  db.prepare('DELETE FROM screens_fts WHERE id = ?').run(screenId);
  db.prepare('INSERT INTO screens_fts (id, name, app_name, description, tags) VALUES (?,?,?,?,?)')
    .run(s.id, s.name || '', s.app_name || '', s.description || '', '');
}

export function reindexAll(db) {
  db.exec('DELETE FROM screens_fts');
  for (const { id } of db.prepare('SELECT id FROM screens').all()) reindex(db, id);
  db.exec('DELETE FROM catalog_fts');
  for (const a of db.prepare('SELECT * FROM catalog_apps').all()) {
    db.prepare('INSERT INTO catalog_fts (id, app_name, tagline, keywords) VALUES (?,?,?,?)')
      .run(a.id, a.app_name || '', a.tagline || '', a.keywords ? JSON.parse(a.keywords).join(' ') : '');
  }
}

export function stats(db) {
  const one = (q) => db.prepare(q).get();
  return {
    catalogApps: one('SELECT COUNT(*) c FROM catalog_apps').c,
    byPlatform: db.prepare('SELECT platform, COUNT(*) c FROM catalog_apps GROUP BY platform').all(),
    screens: one('SELECT COUNT(*) c FROM screens').c,
    screensCached: one('SELECT COUNT(*) c FROM screens WHERE local_path IS NOT NULL').c,
    apps: one('SELECT COUNT(*) c FROM apps').c,
  };
}
