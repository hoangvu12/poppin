#!/usr/bin/env node
import { Command } from 'commander';
import { BASE, PLATFORMS } from '../src/config.mjs';
import { fetchCatalog, fetchCatalogs, toScreens } from '../src/catalog.mjs';
import { matchAppName, rankApps } from '../src/search.mjs';
import { IMG_DIR, imagePath, saveImages } from '../src/images.mjs';

const program = new Command();
program.name('poppin')
  .description('Search real app UI screens from the command line, served by nibbom')
  .version('0.3.0');

const out = (obj) => console.log(JSON.stringify(obj, null, 2));

const table = (rows, cols) => {
  if (!rows.length) return console.log('(no results)');
  const widths = cols.map(col => Math.max(col.length, ...rows.map(row => String(row[col] ?? '').length)));
  const line = (values) => values.map((value, index) => String(value ?? '').padEnd(widths[index])).join('  ');
  console.log(line(cols));
  console.log(widths.map(width => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(cols.map(col => row[col])));
};

function platformsFrom(option) {
  if (!option) return ['ios'];
  const list = [...new Set(option.split(',').map(value => value.trim()).filter(Boolean))];
  const unknown = list.find(value => !PLATFORMS.includes(value));
  if (unknown) throw new Error(`platform must be one of ${PLATFORMS.join(', ')}`);
  return list;
}

/**
 * Attach whatever image each screen already has on disk, then download the rest
 * when the caller asked for images. Progress goes to stderr so `--json` output
 * stays machine-readable.
 */
async function withImages(screens, { download, json }) {
  for (const screen of screens) screen.path = imagePath(screen.id);
  if (!download) return screens;

  const missing = screens.filter(screen => !screen.path);
  if (!missing.length) return screens;

  const log = json ? console.error : console.log;
  log(`downloading ${missing.length} screenshot(s)...`);
  const saved = await saveImages(missing, {
    onError: (screen, error) => console.error(`  ! ${screen.id}: ${error.message}`),
  });
  for (const screen of screens) screen.path ||= saved.get(screen.id) || null;
  return screens;
}

const appView = (app) => ({
  id: app.id,
  appName: app.appName,
  tagline: app.tagline,
  platform: app.platform,
  keywords: app.keywords,
});

// ---------------------------------------------------------------- commands
program.command('find <query...>')
  .description('Search apps by name, tagline, or curated keywords, with their preview screens')
  .option('-n, --limit <n>', 'max apps', '12')
  .option('-p, --platform <list>', 'comma separated: ios,web', 'ios')
  .option('--images', 'download the preview screenshots')
  .option('--json', 'machine-readable output')
  .action(async (query, options) => {
    const platforms = platformsFrom(options.platform);
    const catalog = await fetchCatalogs(platforms);
    const matches = rankApps(catalog, query.join(' '), { limit: Number(options.limit) });

    const screens = await withImages(toScreens(matches), { download: options.images, json: options.json });
    const byApp = new Map();
    for (const screen of screens) {
      if (!byApp.has(screen.appName)) byApp.set(screen.appName, []);
      byApp.get(screen.appName).push({ id: screen.id, path: screen.path });
    }
    const results = matches.map(app => ({ ...appView(app), previews: byApp.get(app.appName) || [] }));

    if (options.json) return out(results);
    if (!results.length) return console.log('no matching apps');
    for (const app of results) {
      console.log(`\n${app.appName}  [${app.platform}]  ${app.id.slice(0, 8)}`);
      if (app.tagline) console.log(`  ${app.tagline}`);
      if (app.keywords.length) console.log(`  keywords: ${app.keywords.join(', ')}`);
      const files = app.previews.map(preview => preview.path || '(not downloaded)');
      if (files.length) console.log(`  previews: ${files.join('  ')}`);
    }
    console.log(`\n${results.length} app(s).`);
  });

program.command('search <query...>')
  .description('Search preview screens across the catalog')
  .option('-n, --limit <n>', 'max screens', '15')
  .option('-p, --platform <list>', 'comma separated: ios,web', 'ios')
  .option('--app <name>', 'restrict to apps whose name contains this')
  .option('--images', 'download the screenshots')
  .option('--json', 'machine-readable output')
  .action(async (query, options) => {
    const catalog = await fetchCatalogs(platformsFrom(options.platform));
    const pool = options.app ? matchAppName(catalog, options.app) : catalog;
    // Naming an app is the stronger intent: if the query matches nothing inside
    // it, show that app's screens rather than nothing at all.
    const ranked = rankApps(pool, query.join(' '), { limit: Number(options.limit) });
    const matches = ranked.length || !options.app ? ranked : pool;
    const screens = (await withImages(toScreens(matches), { download: options.images, json: options.json }))
      .slice(0, Number(options.limit));

    if (options.json) return out(screens);
    table(screens.map(screen => ({
      id: screen.id.slice(0, 8),
      app: screen.appName,
      platform: screen.platform,
      image: screen.path || '-',
    })), ['id', 'app', 'platform', 'image']);
    console.log(`\n${screens.length} screen(s). Full ids via --json.`);
  });

program.command('app <name>')
  .description('Show the preview screens for one app')
  .option('-p, --platform <list>', 'comma separated: ios,web', 'ios')
  .option('--images', 'download the screenshots')
  .option('--json', 'machine-readable output')
  .action(async (name, options) => {
    const catalog = await fetchCatalogs(platformsFrom(options.platform));
    const matches = matchAppName(catalog, name);
    const screens = await withImages(toScreens(matches), { download: options.images, json: options.json });

    if (options.json) return out(screens);
    if (!screens.length) return console.log('no matching app');
    table(screens.map(screen => ({
      id: screen.id.slice(0, 8),
      app: screen.appName,
      platform: screen.platform,
      image: screen.path || '-',
    })), ['id', 'app', 'platform', 'image']);
  });

program.command('screen <id>')
  .description('Show one screen by id or id prefix and download it')
  .option('-p, --platform <list>', 'comma separated: ios,web', 'ios,web')
  .option('--no-images', 'do not download the screenshot')
  .option('--json', 'machine-readable output')
  .action(async (id, options) => {
    const wanted = id.toLowerCase();
    const catalog = await fetchCatalogs(platformsFrom(options.platform));
    const screen = toScreens(catalog).find(candidate => candidate.id.toLowerCase().startsWith(wanted));
    if (!screen) {
      console.log('not found');
      process.exitCode = 1;
      return;
    }
    const [resolved] = await withImages([screen], { download: options.images, json: options.json });

    if (options.json) return out(resolved);
    console.log(`\n${resolved.appName}  [${resolved.platform}]`);
    console.log(`id: ${resolved.id}`);
    console.log(`image: ${resolved.path || 'not downloaded'}`);
  });

program.command('stats')
  .description('What the upstream catalog currently holds')
  .option('-p, --platform <list>', 'comma separated: ios,web', 'ios,web')
  .action(async (options) => {
    const platforms = platformsFrom(options.platform);
    const byPlatform = [];
    let screens = 0;
    for (const platform of platforms) {
      const apps = await fetchCatalog(platform);
      const count = apps.reduce((total, app) => total + app.previews.length, 0);
      byPlatform.push({ platform, apps: apps.length, screens: count });
      screens += count;
    }
    out({
      source: BASE,
      apps: byPlatform.reduce((total, entry) => total + entry.apps, 0),
      screens,
      byPlatform,
      imageDir: IMG_DIR,
    });
  });

try {
  await program.parseAsync();
} catch (error) {
  const messages = {
    RATE_LIMITED: `${BASE} rate-limited the request; try again later`,
    UPSTREAM_ERROR: `${BASE} returned an error; try again later`,
    UPSTREAM_INVALID: `${BASE} returned an unexpected response`,
    UPSTREAM_UNAVAILABLE: `${BASE} could not be reached`,
  };
  const message = messages[error.code]
    || (['TimeoutError', 'AbortError'].includes(error.name) ? `${BASE} did not respond in time` : error.message);
  console.error(message);
  process.exitCode = 1;
}
