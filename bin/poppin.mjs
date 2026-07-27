#!/usr/bin/env node
// Must come first: modules are evaluated in import order, so this reports an
// unsupported Node version before the database layer tries to load node:sqlite.
import '../src/preflight.mjs';
import { Command } from 'commander';
import path from 'node:path';
import { open, stats, reindexAll, DATA_DIR } from '../src/db.mjs';
import { laddered, SCREEN_WEIGHTS } from '../src/search.mjs';
import { parseCookies, readSource, summarize } from '../src/cookies.mjs';
import { saveSession, hasSession, fetchCatalogDirect } from '../src/session.mjs';
import { normaliseApp, storeCatalog, cachePending } from '../src/harvest-api.mjs';

const program = new Command();
program.name('poppin')
  .description('Local design reference library built from your own Mobbin session')
  .version('0.2.0');

const out = (obj, json) => { if (json) console.log(JSON.stringify(obj, null, 2)); };
const table = (rows, cols) => {
  if (!rows.length) return console.log('(no results)');
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ');
  console.log(line(cols));
  console.log(w.map(n => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(cols.map(c => r[c])));
};

// ---------------------------------------------------------------- session
program.command('import-cookies')
  .description('Sign in with the Mobbin session cookie from any browser')
  .option('-c, --cookies <string>', 'cookie string inline (prefer stdin or env for secrets)')
  .option('-f, --cookie-file <path>', 'read the cookie string or JSON from a file')
  .option('--show-help', 'print how to grab the cookie and exit')
  .action(async (o) => {
    if (o.showHelp) {
      console.log(`\nLog into mobbin.com in any browser, open DevTools -> Console, run:\n`);
      console.log(`  copy(document.cookie.split('; ').filter(c => c.startsWith('sb-')).join('\\n'))\n`);
      console.log(`Then feed it to poppin any of these ways:`);
      console.log(`  poppin import-cookies                 # paste, then Ctrl+Z Enter on Windows, Ctrl+D`);
      console.log(`  poppin import-cookies < cookies.txt   # from a file via stdin`);
      console.log(`  POPPIN_COOKIES="..." poppin import-cookies         # env var, good for agents`);
      console.log(`\nA Cookie-Editor JSON export is also accepted.`);
      return;
    }

    const interactive = process.stdin.isTTY && !o.cookies && !o.cookieFile && !process.env.POPPIN_COOKIES;
    if (interactive) {
      console.log('Paste the cookie string, then press Ctrl+Z then Enter on Windows, or Ctrl+D elsewhere.');
      console.log('Run `poppin import-cookies --show-help` for how to grab it.\n');
    }

    let parsed;
    try { parsed = parseCookies(await readSource(o)); }
    catch (e) { console.log(`could not read cookies: ${e.message}`); process.exitCode = 2; return; }

    const info = summarize(parsed);
    if (!info.hasAuth) {
      console.log('No session cookie found in the input. Expected one whose name starts with "sb-".');
      console.log(`Got: ${info.names.join(', ') || '(nothing)'}`);
      process.exitCode = 2;
      return;
    }
    console.log(`parsed ${info.total} cookie(s), session token in ${info.authChunks} chunk(s)`);

    saveSession(parsed);
    const apps = await fetchCatalogDirect('ios');
    if (apps) {
      console.log(`\nSession accepted. The catalog returned ${apps.length} apps.`);
    } else {
      console.log('\nCookie did not authenticate. It may have expired or been pasted partially.');
      process.exitCode = 1;
    }
  });

program.command('whoami')
  .description('Check whether the stored session is still valid')
  .action(async () => {
    if (!hasSession()) {
      console.log('no session stored, run `poppin import-cookies`');
      process.exitCode = 1;
      return;
    }
    const apps = await fetchCatalogDirect('ios');
    console.log(apps ? `signed in, catalog returns ${apps.length} apps` : 'session expired, run `poppin import-cookies`');
    if (!apps) process.exitCode = 1;
  });

// ---------------------------------------------------------------- catalog
program.command('catalog')
  .description('Pull the searchable app catalog into the library')
  .option('-p, --platform <list>', 'comma separated: ios,web', 'ios')
  .option('--no-previews', 'skip preview screens, apps only')
  .option('--images', 'download preview screenshots afterwards')
  .action(async (o) => {
    const db = open();
    const platforms = o.platform.split(',').map(s => s.trim()).filter(Boolean);

    console.log('\ncatalog sync:');
    for (const p of platforms) {
      const raw = await fetchCatalogDirect(p);
      if (!raw) {
        console.log(`  ${p}: no data. The session may have expired, re-run \`poppin import-cookies\`.`);
        process.exitCode = 1;
        continue;
      }
      storeCatalog(db, raw.map(a => normaliseApp(a, p)), { platform: p, withPreviews: o.previews });
    }

    if (o.images) await cachePending(db, { limit: 5000 });
    console.log('\n' + JSON.stringify(stats(db), null, 2));
  });

program.command('find <query...>')
  .description('Search the app catalog by name, tagline, or keywords, with preview screens')
  .option('-n, --limit <n>', 'max apps', '12')
  .option('-p, --platform <name>', 'filter by platform')
  .option('--images', 'download preview images for the matches first')
  .option('--json', 'machine-readable output')
  .action(async (q, o) => {
    const db = open();
    let sql = `SELECT c.id, c.app_name, c.tagline, c.platform, c.keywords,
                      bm25(catalog_fts, 0.0, 10.0, 4.0, 6.0) AS rank
               FROM catalog_fts f JOIN catalog_apps c ON c.id = f.id
               WHERE catalog_fts MATCH ?`;
    const args = [];
    if (o.platform) { sql += ' AND c.platform = ?'; args.push(o.platform); }
    sql += ' ORDER BY rank LIMIT ?';
    const { rows } = laddered(db, sql, q.join(' '), [...args, +o.limit]);

    const previewsFor = db.prepare(`SELECT id, local_path, image_url FROM screens
                                    WHERE app_name = ? AND image_url IS NOT NULL LIMIT 4`);
    const enriched = rows.map(r => ({
      ...r,
      keywords: r.keywords ? JSON.parse(r.keywords) : [],
      previews: previewsFor.all(r.app_name),
    }));

    if (o.images) {
      const missing = enriched.flatMap(a => a.previews.filter(p => !p.local_path));
      if (missing.length) {
        // Under --json, progress must not touch stdout or it corrupts the output.
        const log = o.json ? (m) => console.error(m) : console.log;
        log(`caching ${missing.length} preview image(s)...`);
        await cachePending(db, { ids: missing.map(p => p.id), limit: missing.length + 5, log });
        for (const a of enriched) a.previews = previewsFor.all(a.app_name);
      }
    }

    if (o.json) return out(enriched, true);
    if (!enriched.length) return console.log('no matching apps, run `poppin catalog` first');
    for (const a of enriched) {
      console.log(`\n${a.app_name}  [${a.platform}]  ${a.id.slice(0, 8)}`);
      if (a.tagline) console.log(`  ${a.tagline}`);
      if (a.keywords.length) console.log(`  keywords: ${a.keywords.join(', ')}`);
      const imgs = a.previews.map(p => p.local_path || '(uncached)');
      if (imgs.length) console.log(`  previews: ${imgs.join('  ')}`);
    }
    console.log(`\n${enriched.length} app(s).`);
  });

// ---------------------------------------------------------------- read
program.command('search <query...>')
  .description('Search cached screens')
  .option('-n, --limit <n>', 'max results', '15')
  .option('--platform <name>', 'filter by platform')
  .option('--app <name>', 'filter by app name')
  .option('--images', 'only screens with a cached image')
  .option('--json', 'machine-readable output')
  .action((q, o) => {
    const db = open();
    let sql = `SELECT s.id, s.name, s.app_name, s.platform, s.description, s.local_path,
                      bm25(screens_fts, ${SCREEN_WEIGHTS}) AS rank
               FROM screens_fts f JOIN screens s ON s.id = f.id
               WHERE screens_fts MATCH ?`;
    const args = [];
    if (o.platform) { sql += ' AND s.platform = ?'; args.push(o.platform); }
    if (o.app) { sql += ' AND s.app_name LIKE ?'; args.push(`%${o.app}%`); }
    if (o.images) sql += ' AND s.local_path IS NOT NULL';
    sql += ' ORDER BY rank LIMIT ?';
    const rows = laddered(db, sql, q.join(' '), [...args, +o.limit]).rows;

    if (o.json) return out(rows, true);
    table(rows.map(r => ({
      id: r.id.slice(0, 8), app: r.app_name, screen: r.name, platform: r.platform,
      image: r.local_path ? path.relative(process.cwd(), r.local_path) : '-',
    })), ['id', 'app', 'screen', 'platform', 'image']);
    console.log(`\n${rows.length} result(s). Full ids via --json.`);
  });

program.command('screen <id>')
  .description('Show one screen by id or id prefix')
  .option('--json', 'machine-readable output')
  .action((id, o) => {
    const db = open();
    const s = db.prepare('SELECT * FROM screens WHERE id = ? OR id LIKE ?').get(id, `${id}%`);
    if (!s) return console.log('not found');
    if (o.json) return out(s, true);
    console.log(`\n${s.app_name || '?'} / ${s.name || '?'}  [${s.platform || '?'}]`);
    if (s.description) console.log(s.description);
    console.log(`image: ${s.local_path || 'not cached'}`);
  });

program.command('app <name>')
  .description('Show cached screens for an app')
  .option('--json', 'machine-readable output')
  .action((name, o) => {
    const db = open();
    const rows = db.prepare('SELECT * FROM screens WHERE app_name LIKE ? ORDER BY name').all(`%${name}%`);
    if (o.json) return out(rows, true);
    table(rows.map(r => ({ id: r.id.slice(0, 8), screen: r.name, platform: r.platform, image: r.local_path || '-' })),
      ['id', 'screen', 'platform', 'image']);
  });

// ---------------------------------------------------------------- misc
program.command('images')
  .description('Download screenshots that are not cached yet')
  .option('-n, --limit <n>', 'max downloads', '500')
  .action(async (o) => {
    await cachePending(open(), { limit: +o.limit });
  });

program.command('stats').description('Library contents').action(() => {
  console.log(JSON.stringify(stats(open()), null, 2));
  console.log(`data dir: ${DATA_DIR}`);
});

program.command('reindex').description('Rebuild the full-text index').action(() => {
  reindexAll(open());
  console.log('reindexed');
});

program.parseAsync();
