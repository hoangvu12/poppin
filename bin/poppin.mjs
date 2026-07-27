#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { open, stats, reindexAll, DATA_DIR } from '../src/db.mjs';
import { laddered, SCREEN_WEIGHTS, FLOW_WEIGHTS } from '../src/search.mjs';
import { parseCookies, readSource, summarize } from '../src/cookies.mjs';
import { BASE, KINDS } from '../src/config.mjs';

// Browser-backed modules pull in playwright, so they are imported on demand.
// Commands that only read the local library stay fast and dependency-free.
const browser = () => import('../src/browser.mjs');
const api = () => import('../src/api.mjs');
const harvestApi = () => import('../src/harvest-api.mjs');
const harvest = () => import('../src/harvest.mjs');

const program = new Command();
program.name('poppin').description('Local design-reference library built from your own Mobbin session').version('0.1.0');

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
  .description('Sign in with the Mobbin session cookie from any browser (paste, pipe, env, or file)')
  .option('-c, --cookies <string>', 'cookie string inline (prefer stdin or env for secrets)')
  .option('-f, --cookie-file <path>', 'read the cookie string or JSON from a file')
  .option('--show-help', 'print how to grab the cookie and exit')
  .action(async (o) => {
    if (o.showHelp) {
      console.log(`\nLog into mobbin.com in any browser, open DevTools -> Console, run:\n`);
      console.log(`  copy(document.cookie.split('; ').filter(c => c.startsWith('sb-')).join('\\n'))\n`);
      console.log(`Then feed it to poppin any of these ways:`);
      console.log(`  poppin import-cookies                 # paste, then Ctrl+Z Enter (Windows) or Ctrl+D`);
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

    const { launch, isLoggedIn } = await browser();
    const { ctx, page } = await launch({ headless: true });
    try {
      await ctx.addCookies(parsed);
      if (await isLoggedIn(page)) {
        console.log('\nSession accepted. You are signed in.');
      } else {
        console.log('\nCookie did not authenticate. It may have expired or been pasted partially.');
        process.exitCode = 1;
      }
    } finally { await ctx.close(); }
  });

program.command('whoami')
  .description('Check whether the stored session is still signed in')
  .action(async () => {
    const { launch, isLoggedIn } = await browser();
    const { ctx, page } = await launch({ headless: true });
    const ok = await isLoggedIn(page);
    console.log(ok ? 'signed in' : 'signed out, run `poppin import-cookies`');
    if (!ok) process.exitCode = 1;
    await ctx.close();
  });

// ---------------------------------------------------------------- catalog
program.command('catalog')
  .description('Pull the searchable app catalog into the library')
  .option('-p, --platform <list>', 'comma separated: ios,web', 'ios')
  .option('--no-previews', 'skip preview screens, apps only')
  .option('--images', 'download preview screenshots afterwards')
  .option('--headed', 'show the browser')
  .action(async (o) => {
    const db = open();
    const platforms = o.platform.split(',').map(s => s.trim()).filter(Boolean);
    const { withSession } = await api();
    const { syncCatalog, cachePending } = await harvestApi();
    await withSession(async ({ page }) => {
      console.log('\ncatalog sync:');
      for (const p of platforms) await syncCatalog(db, page, { platform: p, withPreviews: o.previews });
      if (o.images) await cachePending(db, { limit: 5000 });
    }, { headless: !o.headed }).catch(e => { console.log('error:', e.message); process.exitCode = 1; });
    console.log('\n' + JSON.stringify(stats(db), null, 2));
  });

program.command('app-screens <catalogId>')
  .description('Deep-fetch the screens for one catalog app (id or prefix)')
  .option('--images', 'download the screenshots afterwards')
  .option('--headed', 'show the browser')
  .action(async (id, o) => {
    const db = open();
    const { withSession } = await api();
    const { syncAppScreens, cachePending } = await harvestApi();
    await withSession(async ({ page }) => {
      const { app } = await syncAppScreens(db, page, id);
      if (o.images) await cachePending(db, { limit: 2000, appName: app.app_name });
    }, { headless: !o.headed }).catch(e => { console.log('error:', e.message); process.exitCode = 1; });
  });

program.command('find <query...>')
  .description('Search the app catalog by name, tagline, or keywords, with preview screens')
  .option('-n, --limit <n>', 'max apps', '12')
  .option('-p, --platform <name>', 'filter by platform')
  .option('--images', 'download preview images for the matches first')
  .option('--json', 'machine-readable output')
  .action(async (q, o) => {
    const db = open();
    let sql = `SELECT c.id, c.app_name, c.tagline, c.platform, c.keywords, c.app_url,
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
        const { cachePending } = await harvestApi();
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
      const imgs = a.previews.map(p => p.local_path || '(uncached)').slice(0, 4);
      if (imgs.length) console.log(`  previews: ${imgs.join('  ')}`);
    }
    console.log(`\n${enriched.length} app(s). Deep-fetch one with \`poppin app-screens <id>\`.`);
  });

// ---------------------------------------------------------------- scraper
program.command('sync')
  .description('Crawl the public browse pages into the library')
  .option('-p, --platform <name>', 'platform hub: mobile or web', 'mobile')
  .option('-k, --kind <kind>', `${KINDS.join(', ')}, or all`, 'screens')
  .option('-s, --slug <slug>', 'sync only this slug, such as onboarding')
  .option('-n, --limit <n>', 'screens per listing', '40')
  .option('-t, --taxonomy-limit <n>', 'listings to crawl per kind', '12')
  .option('--details', 'open each screen page for descriptions and tags')
  .option('--images', 'download screenshots into the local cache')
  .option('--delay <ms>', 'pause between page loads', '1500')
  .option('--headed', 'show the browser')
  .action(async (o) => {
    const db = open();
    const { launch } = await browser();
    const { syncTaxonomy, syncListing, syncFlows, syncDetail, downloadPending, downloadFlowFrames } = await harvest();
    const { ctx, page } = await launch({ headless: !o.headed });
    const delay = +o.delay;
    try {
      console.log(`\nsync: platform=${o.platform} kind=${o.kind}`);
      const tax = await syncTaxonomy(db, page, { platform: o.platform, delay });

      const kinds = o.kind === 'all' ? KINDS : [o.kind];
      // Apply the limit per kind, otherwise `--kind all` spends the whole budget
      // on whichever kind sorts first and never reaches flows.
      const targets = kinds.flatMap(k => {
        let ofKind = tax.filter(t => t.kind === k && t.platform === o.platform);
        if (o.slug) ofKind = ofKind.filter(t => t.slug === o.slug);
        return ofKind.slice(0, +o.taxonomyLimit);
      });

      if (!targets.length) console.log('  no listings matched, try --kind all or a different --platform or --slug');

      for (const t of targets) {
        try {
          // Flow pages render whole ordered flows, not individual screen cards.
          if (t.kind === 'flows') {
            await syncFlows(db, page, { platform: t.platform, slug: t.slug, limit: +o.limit, delay });
          } else {
            await syncListing(db, page, { platform: t.platform, kind: t.kind, slug: t.slug, limit: +o.limit, delay });
          }
        } catch (e) { console.log(`  ! ${t.kind}/${t.slug}: ${e.message}`); }
      }

      if (o.details) {
        const pending = db.prepare('SELECT id FROM screens WHERE detail_done = 0 LIMIT ?').all(+o.limit * 3);
        console.log(`  details: ${pending.length} screens`);
        let i = 0;
        for (const { id } of pending) {
          try { await syncDetail(db, page, id, { delay }); } catch (e) { console.log(`  ! detail ${id}: ${e.message}`); }
          if (++i % 10 === 0) console.log(`    ${i}/${pending.length}`);
        }
      }

      if (o.images) {
        await downloadPending(db, { limit: 1000 });
        await downloadFlowFrames(db, { limit: 2000 });
      }

      console.log('\n' + JSON.stringify(stats(db), null, 2));
    } finally { await ctx.close(); }
  });

// ---------------------------------------------------------------- read
program.command('search <query...>')
  .description('Search the local library, screens by default and flows with --flows')
  .option('-n, --limit <n>', 'max results', '15')
  .option('--platform <name>', 'filter by platform')
  .option('--app <name>', 'filter by app name')
  .option('--images', 'only screens with a cached image')
  .option('--flows', 'search flows instead of screens')
  .option('--all', 'search screens and flows')
  .option('--json', 'machine-readable output')
  .action((q, o) => {
    const db = open();
    const query = q.join(' ');
    const lim = +o.limit;

    const screenHits = () => {
      let sql = `SELECT s.id, s.name, s.app_name, s.platform, s.description, s.local_path,
                        bm25(screens_fts, ${SCREEN_WEIGHTS}) AS rank
                 FROM screens_fts f JOIN screens s ON s.id = f.id
                 WHERE screens_fts MATCH ?`;
      const args = [];
      if (o.platform) { sql += ' AND s.platform = ?'; args.push(o.platform); }
      if (o.app) { sql += ' AND s.app_name LIKE ?'; args.push(`%${o.app}%`); }
      if (o.images) sql += ' AND s.local_path IS NOT NULL';
      sql += ' ORDER BY rank LIMIT ?';
      return laddered(db, sql, query, [...args, lim]).rows;
    };

    const flowHits = () => {
      let sql = `SELECT fl.id, fl.title, fl.app_name, fl.slug, fl.description, fl.n_screens,
                        bm25(flows_fts, ${FLOW_WEIGHTS}) AS rank
                 FROM flows_fts f JOIN flows fl ON fl.id = f.id
                 WHERE flows_fts MATCH ?`;
      const args = [];
      if (o.app) { sql += ' AND fl.app_name LIKE ?'; args.push(`%${o.app}%`); }
      sql += ' ORDER BY rank LIMIT ?';
      return laddered(db, sql, query, [...args, lim]).rows;
    };

    const wantFlows = o.flows || o.all;
    const wantScreens = !o.flows || o.all;
    const screens = wantScreens ? screenHits() : [];
    const flows = wantFlows ? flowHits() : [];

    if (o.json) return out(o.all ? { screens, flows } : (o.flows ? flows : screens), true);

    if (wantScreens) {
      if (o.all) console.log('SCREENS');
      table(screens.map(r => ({
        id: r.id.slice(0, 8), app: r.app_name, screen: r.name, platform: r.platform,
        image: r.local_path ? path.relative(process.cwd(), r.local_path) : '-',
      })), ['id', 'app', 'screen', 'platform', 'image']);
    }
    if (wantFlows) {
      if (o.all) console.log('\nFLOWS');
      table(flows.map(r => ({
        id: r.id.slice(0, 8), app: r.app_name, title: r.title, slug: r.slug, frames: r.n_screens,
      })), ['id', 'app', 'title', 'slug', 'frames']);
    }
    console.log(`\n${screens.length + flows.length} result(s). Full ids via --json.`);
  });

program.command('screen <id>')
  .description('Show one screen by id or id prefix')
  .option('--json', 'machine-readable output')
  .action((id, o) => {
    const db = open();
    const s = db.prepare('SELECT * FROM screens WHERE id = ? OR id LIKE ?').get(id, `${id}%`);
    if (!s) return console.log('not found');
    const tags = db.prepare('SELECT kind, slug, label FROM screen_tags WHERE screen_id = ? ORDER BY kind, ord').all(s.id);
    const rec = { ...s, tags, url: `${BASE}/explore/screens/${s.id}` };
    if (o.json) return out(rec, true);
    console.log(`\n${s.app_name || '?'} / ${s.name || '?'}  [${s.platform || '?'}]`);
    console.log(s.description || 'no description, run sync --details');
    console.log(`\nurl:   ${rec.url}`);
    console.log(`image: ${s.local_path || 'not cached'}`);
    for (const k of KINDS) {
      const t = tags.filter(x => x.kind === k);
      if (t.length) console.log(`${k.padEnd(12)} ${t.map(x => x.label || x.slug).join(', ')}`);
    }
  });

program.command('flows [slug]')
  .description('List captured flows, optionally filtered by slug')
  .option('--app <name>', 'filter by app')
  .option('--json', 'machine-readable output')
  .action((slug, o) => {
    const db = open();
    let sql = 'SELECT * FROM flows WHERE 1=1', args = [];
    if (slug) { sql += ' AND slug = ?'; args.push(slug); }
    if (o.app) { sql += ' AND app_name LIKE ?'; args.push(`%${o.app}%`); }
    sql += ' ORDER BY app_name, slug';
    const rows = db.prepare(sql).all(...args);
    if (o.json) return out(rows, true);
    table(rows.map(r => ({ id: r.id.slice(0, 8), app: r.app_name, title: r.title, slug: r.slug, frames: r.n_screens })),
      ['id', 'app', 'title', 'slug', 'frames']);
    console.log(`\n${rows.length} flow(s). Use \`poppin flow <id>\` for the sequence.`);
  });

program.command('flow <id>')
  .description('Show one flow as an ordered screen sequence')
  .option('--json', 'machine-readable output')
  .action((id, o) => {
    const db = open();
    const f = db.prepare('SELECT * FROM flows WHERE id = ? OR id LIKE ?').get(id, `${id}%`);
    if (!f) return console.log('not found, try `poppin flows` to list them');
    const frames = db.prepare('SELECT ord, alt, local_path, image_url FROM flow_screens WHERE flow_id = ? ORDER BY ord').all(f.id);
    if (o.json) return out({ ...f, frames, url: `${BASE}/explore/flows/${f.id}` }, true);
    console.log(`\n${f.title || f.slug} / ${f.app_name || '?'} (${frames.length} frames)`);
    if (f.description) console.log(f.description);
    if (f.tags) console.log(`tags: ${JSON.parse(f.tags).map(t => t.label || t.slug).join(', ')}`);
    console.log(`url: ${BASE}/explore/flows/${f.id}\n`);
    table(frames.map(fr => ({ '#': fr.ord, screen: fr.alt || '-', image: fr.local_path || 'not cached' })),
      ['#', 'screen', 'image']);
  });

program.command('app <name>')
  .description('Show cached screens for an app')
  .option('--json', 'machine-readable output')
  .action((name, o) => {
    const db = open();
    const rows = db.prepare('SELECT * FROM screens WHERE app_name LIKE ? ORDER BY name').all(`%${name}%`);
    if (o.json) return out(rows, true);
    table(rows.map(r => ({ id: r.id.slice(0, 8), screen: r.name, platform: r.platform, image: r.local_path ? 'yes' : '-' })),
      ['id', 'screen', 'platform', 'image']);
  });

program.command('taxonomy')
  .description('List known patterns, ui elements, and flows')
  .option('-k, --kind <kind>', `${KINDS.join(', ')}, or all`, 'all')
  .option('--json', 'machine-readable output')
  .action((o) => {
    const db = open();
    const rows = o.kind === 'all'
      ? db.prepare('SELECT * FROM taxonomy ORDER BY kind, platform, slug').all()
      : db.prepare('SELECT * FROM taxonomy WHERE kind = ? ORDER BY platform, slug').all(o.kind);
    if (o.json) return out(rows, true);
    table(rows, ['kind', 'platform', 'slug', 'label']);
  });

// ---------------------------------------------------------------- misc
program.command('stats').description('Library contents').action(() => {
  console.log(JSON.stringify(stats(open()), null, 2));
  console.log(`data dir: ${DATA_DIR}`);
});

program.command('reindex').description('Rebuild the full-text index').action(() => {
  reindexAll(open());
  console.log('reindexed');
});

program.command('images').description('Download screenshots that are not cached yet')
  .option('-n, --limit <n>', 'max downloads', '500')
  .option('--force', 're-download even if cached')
  .action(async (o) => {
    const { downloadPending } = await harvest();
    await downloadPending(open(), { limit: +o.limit, force: !!o.force });
  });

program.parseAsync();
