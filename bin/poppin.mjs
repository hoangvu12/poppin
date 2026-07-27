#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { open, stats, reindexAll, DATA_DIR } from '../src/db.mjs';
import { launch, isLoggedIn, BASE, PROFILE_DIR, sleep } from '../src/browser.mjs';
import { syncTaxonomy, syncListing, syncFlows, syncDetail, downloadPending, downloadFlowFrames, KINDS } from '../src/harvest.mjs';
import { analyzeImage } from '../src/analyze.mjs';
import { laddered, SCREEN_WEIGHTS, FLOW_WEIGHTS } from '../src/search.mjs';
import { parseCookies, readSource, summarize } from '../src/cookies.mjs';
import { withSession } from '../src/api.mjs';
import { syncCatalog, syncAppScreens, cachePending } from '../src/harvest-api.mjs';
import { imagePath } from '../src/images.mjs';

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

// ---------------------------------------------------------------- login
program.command('login')
  .description('Open Chrome so you can sign in to Mobbin; the session is reused by every later command')
  .action(async () => {
    const { ctx, page } = await launch({ headless: false });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    console.log('\nSign in to Mobbin in the Chrome window that just opened.');
    console.log('Waiting for you to land back on the app (up to 5 minutes)...\n');
    const deadline = Date.now() + 5 * 60_000;
    let done = false;
    while (Date.now() < deadline) {
      await sleep(3000);
      const u = page.url();
      if (!/\/login|\/signup|accounts\.google|appleid/.test(u)) { done = true; break; }
    }
    console.log(done ? '✓ Session captured.' : '⚠ Timed out — run `poppin login` again if sync fails.');
    console.log(`  profile: ${PROFILE_DIR}`);
    await ctx.close();
  });

program.command('import-cookies')
  .description('Sign in with the Mobbin session cookie from ANY browser (paste, pipe, env, or file)')
  .option('-c, --cookies <string>', 'cookie string inline (avoid for secrets — prefer stdin/env)')
  .option('-f, --cookie-file <path>', 'read the cookie string/JSON from a file')
  .option('--show-help', 'print how to grab the cookie and exit')
  .action(async (o) => {
    if (o.showHelp) {
      console.log(`\nLog into mobbin.com in ANY browser, open DevTools -> Console, run:\n`);
      console.log(`  copy(document.cookie.split('; ').filter(c => c.startsWith('sb-')).join('\\n'))\n`);
      console.log(`Then feed it to poppin any of these ways:`);
      console.log(`  poppin import-cookies                 # paste, then Ctrl+Z Enter (Windows) / Ctrl+D (mac/linux)`);
      console.log(`  poppin import-cookies < cookies.txt   # from a file via stdin`);
      console.log(`  $env:POPPIN_COOKIES="..."; poppin import-cookies   # env var (good for agents)`);
      console.log(`\n(Cookie-Editor JSON export is also accepted.)`);
      return;
    }

    const interactive = process.stdin.isTTY && !o.cookies && !o.cookieFile && !process.env.POPPIN_COOKIES;
    if (interactive) {
      console.log('Paste the cookie string, then press Ctrl+Z then Enter (Windows) / Ctrl+D (mac/linux).');
      console.log('(Run `poppin import-cookies --show-help` for how to grab it.)\n');
    }

    let parsed;
    try { parsed = parseCookies(await readSource(o)); }
    catch (e) { return console.log(`could not read cookies: ${e.message}`); }

    const info = summarize(parsed);
    if (!info.hasAuth) {
      console.log(`No Supabase auth cookie found. Expected one starting with`);
      console.log(`  sb-ujasntkfphywizsdaapi-auth-token`);
      console.log(`Got: ${info.names.join(', ') || '(nothing)'}`);
      process.exitCode = 2;
      return;
    }
    console.log(`parsed ${info.total} cookie(s), auth token in ${info.authChunks} chunk(s)`);

    const { ctx, page } = await launch({ headless: true });
    try {
      await ctx.addCookies(parsed);
      const ok = await isLoggedIn(page);
      if (ok) {
        console.log('\n✓ Session accepted — you are signed in.');
      } else {
        console.log('\n✗ Cookie did not authenticate (expired? partial paste?). Re-copy and retry.');
        process.exitCode = 1;
      }
    } finally { await ctx.close(); }
  });

program.command('whoami')
  .description('Check whether the stored session is still signed in')
  .action(async () => {
    const { ctx, page } = await launch({ headless: true });
    console.log(await isLoggedIn(page) ? '✓ signed in' : '✗ signed out — run `poppin login`');
    await ctx.close();
  });

// ---------------------------------------------------------------- catalog (authenticated)
program.command('catalog')
  .description('Pull the full searchable app catalog (authenticated JSON API) into the library')
  .option('-p, --platform <list>', 'comma-separated: ios,web', 'ios')
  .option('--no-previews', 'skip preview screens (apps only)')
  .option('--images', 'download preview screenshots after')
  .option('--headed', 'show the browser')
  .action(async (o) => {
    const db = open();
    const platforms = o.platform.split(',').map(s => s.trim()).filter(Boolean);
    await withSession(async ({ page }) => {
      console.log('\ncatalog sync:');
      for (const p of platforms) await syncCatalog(db, page, { platform: p, withPreviews: o.previews });
      if (o.images) await cachePending(db, { limit: 5000 });
    }, { headless: !o.headed }).catch(e => console.log('error:', e.message));
    console.log('\n' + JSON.stringify(stats(db), null, 2));
  });

program.command('app-screens <catalogId>')
  .description('Deep-fetch every screen for one catalog app (id or prefix)')
  .option('--images', 'download the screenshots after')
  .option('--headed', 'show the browser')
  .action(async (id, o) => {
    const db = open();
    await withSession(async ({ page }) => {
      const { app } = await syncAppScreens(db, page, id);
      if (o.images) await cachePending(db, { limit: 2000, appName: app.app_name });
    }, { headless: !o.headed }).catch(e => console.log('error:', e.message));
  });

program.command('find <query...>')
  .description('Search the app catalog by name / tagline / keywords, with preview screens')
  .option('-n, --limit <n>', 'max apps', '12')
  .option('-p, --platform <name>', 'filter by platform')
  .option('--images', 'download preview images for the matches first')
  .option('--json', 'machine-readable output')
  .action(async (q, o) => {
    const db = open();
    const query = q.join(' ');
    let sql = `SELECT c.id, c.app_name, c.tagline, c.platform, c.keywords, c.app_url,
                      bm25(catalog_fts, 0.0, 10.0, 4.0, 6.0) AS rank
               FROM catalog_fts f JOIN catalog_apps c ON c.id = f.id
               WHERE catalog_fts MATCH ?`;
    const args = [];
    if (o.platform) { sql += ' AND c.platform = ?'; args.push(o.platform); }
    sql += ' ORDER BY rank LIMIT ?';
    const { rows } = laddered(db, sql, query, [...args, +o.limit]);

    // attach a few preview screens per app
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
        // In --json mode, progress must not touch stdout or it corrupts the JSON.
        const log = o.json ? (m) => console.error(m) : console.log;
        log(`caching ${missing.length} preview image(s)...`);
        await cachePending(db, { ids: missing.map(p => p.id), limit: missing.length + 5, log });
        for (const a of enriched) a.previews = previewsFor.all(a.app_name);
      }
    }

    if (o.json) return out(enriched, true);
    if (!enriched.length) return console.log('(no matching apps — run `poppin catalog` first)');
    for (const a of enriched) {
      console.log(`\n${a.app_name}  [${a.platform}]  ${a.id.slice(0, 8)}`);
      if (a.tagline) console.log(`  ${a.tagline}`);
      if (a.keywords.length) console.log(`  keywords: ${a.keywords.join(', ')}`);
      const imgs = a.previews.map(p => p.local_path || '(uncached)').slice(0, 4);
      if (imgs.length) console.log(`  previews: ${imgs.join('  ')}`);
    }
    console.log(`\n${enriched.length} app(s). Deep-fetch one with \`poppin app-screens <id>\`.`);
  });

program.command('limits')
  .description('Measure what the current session actually grants (screens per listing)')
  .option('--headed', 'show the browser')
  .action(async (o) => {
    const { ctx, page } = await launch({ headless: !o.headed });
    try {
      const signedIn = await isLoggedIn(page);
      console.log(`session: ${signedIn ? 'signed in' : 'signed out'}`);
      for (const probe of ['ui-elements/card', 'screens/home']) {
        await page.goto(`${BASE}/explore/mobile/${probe}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(4000);
        const count = () => page.evaluate(() => document.querySelectorAll('a[href^="/explore/screens/"]').length);
        let prev = -1, stable = 0;
        for (let i = 0; i < 40; i++) {
          const c = await count();
          if (c === prev) { if (++stable >= 3) break; } else stable = 0;
          prev = c;
          await page.mouse.wheel(0, 8000);
          await sleep(1400);
        }
        console.log(`  ${probe}: ${await count()} screens before the listing stops`);
      }
      console.log('\n60 per listing is the anonymous ceiling. If you see the same number');
      console.log('while signed in, the free tier does not raise it.');
    } finally { await ctx.close(); }
  });

// ---------------------------------------------------------------- sync
program.command('sync')
  .description('Crawl Mobbin into the local library')
  .option('-p, --platform <name>', 'platform hub (mobile, web)', 'mobile')
  .option('-k, --kind <kind>', `taxonomy kind: ${KINDS.join('|')}|all`, 'screens')
  .option('-s, --slug <slug>', 'sync only this slug (e.g. onboarding)')
  .option('-n, --limit <n>', 'screens per listing', '40')
  .option('-t, --taxonomy-limit <n>', 'max listings to crawl per kind', '12')
  .option('--details', 'also open each screen page for descriptions + full tags')
  .option('--images', 'download screenshots into the local cache')
  .option('--delay <ms>', 'pause between page loads (be polite)', '1500')
  .option('--headed', 'show the browser')
  .action(async (o) => {
    const db = open();
    const { ctx, page } = await launch({ headless: !o.headed });
    const delay = +o.delay;
    try {
      console.log(`\nsync: platform=${o.platform} kind=${o.kind}`);
      const tax = await syncTaxonomy(db, page, { platform: o.platform, delay });

      const kinds = o.kind === 'all' ? KINDS : [o.kind];
      // Apply the limit per kind, otherwise `--kind all` spends the whole
      // budget on whichever kind happens to sort first and never reaches flows.
      const targets = kinds.flatMap(k => {
        let ofKind = tax.filter(t => t.kind === k && t.platform === o.platform);
        if (o.slug) ofKind = ofKind.filter(t => t.slug === o.slug);
        return ofKind.slice(0, +o.taxonomyLimit);
      });

      if (!targets.length) {
        console.log('  no listings matched — try --kind all, or a different --platform/--slug');
      }
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

// ---------------------------------------------------------------- search
program.command('search <query...>')
  .description('Search the local library (screens, and flows with --flows)')
  .option('-n, --limit <n>', 'max results', '15')
  .option('--platform <name>', 'filter by platform')
  .option('--app <name>', 'filter by app name')
  .option('--images', 'only screens with a cached image')
  .option('--flows', 'search flows instead of screens')
  .option('--all', 'search screens AND flows')
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

// ---------------------------------------------------------------- browse
program.command('screen <id>')
  .description('Show one screen (id or id prefix)')
  .option('--json', 'machine-readable output')
  .action((id, o) => {
    const db = open();
    const s = db.prepare('SELECT * FROM screens WHERE id = ? OR id LIKE ?').get(id, `${id}%`);
    if (!s) return console.log('not found');
    const tags = db.prepare('SELECT kind, slug, label FROM screen_tags WHERE screen_id = ? ORDER BY kind, ord').all(s.id);
    const a = db.prepare('SELECT json FROM analysis WHERE screen_id = ?').get(s.id);
    const rec = { ...s, tags, analysis: a ? JSON.parse(a.json) : null, url: `${BASE}/explore/screens/${s.id}` };
    if (o.json) return out(rec, true);
    console.log(`\n${s.app_name || '?'} — ${s.name || '?'}  [${s.platform || '?'}]`);
    console.log(s.description || '(no description; run sync --details)');
    console.log(`\nurl:   ${rec.url}`);
    console.log(`image: ${s.local_path || '(not cached)'}`);
    for (const k of KINDS) {
      const t = tags.filter(x => x.kind === k);
      if (t.length) console.log(`${k.padEnd(12)} ${t.map(x => x.label || x.slug).join(', ')}`);
    }
  });

program.command('flows [slug]')
  .description('List captured flows, optionally filtered by slug (e.g. onboarding)')
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
    if (!f) return console.log('not found — try `poppin flows` to list them');
    const frames = db.prepare('SELECT ord, alt, local_path, image_url FROM flow_screens WHERE flow_id = ? ORDER BY ord').all(f.id);
    if (o.json) return out({ ...f, frames, url: `${BASE}/explore/flows/${f.id}` }, true);
    console.log(`\n${f.title || f.slug} — ${f.app_name || '?'} (${frames.length} frames)`);
    if (f.description) console.log(f.description);
    if (f.tags) console.log(`tags: ${JSON.parse(f.tags).map(t => t.label || t.slug).join(', ')}`);
    console.log(`url: ${BASE}/explore/flows/${f.id}\n`);
    table(frames.map(fr => ({ '#': fr.ord, screen: fr.alt || '-', image: fr.local_path || '(not cached)' })),
      ['#', 'screen', 'image']);
  });

program.command('screens-in <slug>')
  .description('Screens tagged with a flow/pattern/element slug')
  .option('-n, --limit <n>', 'max screens', '40')
  .option('--json', 'machine-readable output')
  .action((slug, o) => {
    const db = open();
    const rows = db.prepare(`SELECT s.* FROM screens s JOIN screen_tags t ON t.screen_id = s.id
                             WHERE t.slug = ? ORDER BY s.app_name, t.ord LIMIT ?`).all(slug, +o.limit);
    if (o.json) return out(rows, true);
    table(rows.map(r => ({ id: r.id.slice(0, 8), app: r.app_name, screen: r.name, image: r.local_path ? 'yes' : '-' })),
      ['id', 'app', 'screen', 'image']);
  });

program.command('app <name>')
  .description('Show screens for an app')
  .option('--json', 'machine-readable output')
  .action((name, o) => {
    const db = open();
    const rows = db.prepare('SELECT * FROM screens WHERE app_name LIKE ? ORDER BY name').all(`%${name}%`);
    if (o.json) return out(rows, true);
    table(rows.map(r => ({ id: r.id.slice(0, 8), screen: r.name, platform: r.platform, image: r.local_path ? 'yes' : '-' })),
      ['id', 'screen', 'platform', 'image']);
  });

program.command('taxonomy')
  .description('List known patterns / ui-elements / flows')
  .option('-k, --kind <kind>', `${KINDS.join('|')}|all`, 'all')
  .option('--json', 'machine-readable output')
  .action((o) => {
    const db = open();
    const rows = o.kind === 'all'
      ? db.prepare('SELECT * FROM taxonomy ORDER BY kind, platform, slug').all()
      : db.prepare('SELECT * FROM taxonomy WHERE kind = ? ORDER BY platform, slug').all(o.kind);
    if (o.json) return out(rows, true);
    table(rows, ['kind', 'platform', 'slug', 'label']);
  });

// ---------------------------------------------------------------- analyze
program.command('analyze [id]')
  .description('Extract palette / theme / layout signals from cached screenshots')
  .option('--all', 'analyze every cached screen that has no analysis yet')
  .option('--json', 'machine-readable output')
  .action(async (id, o) => {
    if (!id && !o.all) return console.log('give a screen id, or --all');
    const db = open();
    const targets = o.all
      ? db.prepare(`SELECT id, local_path FROM screens WHERE local_path IS NOT NULL
                    AND id NOT IN (SELECT screen_id FROM analysis)`).all()
      : db.prepare('SELECT id, local_path FROM screens WHERE (id = ? OR id LIKE ?)').all(id, `${id}%`);

    if (!targets.length) return console.log('nothing to analyze (need cached images — try `sync --images`)');
    let n = 0;
    for (const t of targets) {
      const file = t.local_path && fs.existsSync(t.local_path) ? t.local_path : imagePath(t.id);
      if (!file) continue;
      try {
        const a = await analyzeImage(file);
        db.prepare(`INSERT INTO analysis (screen_id, json, updated) VALUES (?,?,?)
                    ON CONFLICT(screen_id) DO UPDATE SET json = excluded.json, updated = excluded.updated`)
          .run(t.id, JSON.stringify(a), new Date().toISOString());
        n++;
        if (!o.all) {
          if (o.json) return out(a, true);
          console.log(`\ntheme:     ${a.theme} (avg lightness ${a.avgLightness})`);
          console.log(`bg / fg:   ${a.background} / ${a.foreground}  contrast ${a.textContrast}:1 ${a.contrastPasses.aa ? '(AA pass)' : '(AA fail)'}`);
          console.log(`accent:    ${a.accent || '-'}`);
          console.log(`size:      ${a.dimensions.width}x${a.dimensions.height} (aspect ${a.dimensions.aspect})`);
          console.log(`palette:   ${a.palette.map(p => `${p.hex} ${(p.share * 100).toFixed(0)}%`).join('  ')}`);
          console.log(`bands:     ${a.contentBands.length} content regions, density ${a.density}`);
        }
      } catch (e) { console.log(`  ! ${t.id}: ${e.message}`); }
    }
    if (o.all) console.log(`analyzed ${n} screens`);
  });

// ---------------------------------------------------------------- misc
program.command('stats').description('Library contents').action(() => {
  console.log(JSON.stringify(stats(open()), null, 2));
  console.log(`data dir: ${DATA_DIR}`);
});

program.command('reindex').description('Rebuild the full-text index').action(() => {
  const db = open(); reindexAll(db); console.log('reindexed');
});

program.command('images').description('Download any screenshots that are not cached yet')
  .option('-n, --limit <n>', 'max downloads', '500')
  .option('--force', 're-download even if cached')
  .action(async (o) => { await downloadPending(open(), { limit: +o.limit, force: !!o.force }); });

program.parseAsync();
