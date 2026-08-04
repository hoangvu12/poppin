#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import {
  BASE, CONTENT_TYPES, FILTERS, FILTER_BY_KIND, PLATFORMS, SITE_CONTENT_TYPES,
  SITE_FILTERS, SITE_FILTER_BY_KIND, SORTS,
} from '../src/config.mjs';
import { fetchCatalog, fetchCatalogs, toScreens } from '../src/catalog.mjs';
import { matchAppName, rankApps } from '../src/search.mjs';
import {
  FREE_TEXT_CONTENT_TYPES, MAX_VISUAL_SEARCH_BYTES, buildFreeTextQuery, buildSearchQuery,
  buildSiteSearchQuery, buildVisualSearchQuery, fetchAppLibrary, fetchScreenInfo,
  resolveViaSearchBar, searchContent, uploadVisualSearchImage,
} from '../src/mobbin.mjs';
import { fetchTaxonomy, findTagById, resolveTagName, tagsFor } from '../src/taxonomy.mjs';
import { fetchHealth } from '../src/upstream.mjs';
import { IMG_DIR, imagePath, saveImages } from '../src/images.mjs';

const program = new Command();
program.name('poppin')
  .description('Search real app UI screens, flows, and elements from the command line, served by nibbom')
  .version('0.4.0');

const out = (obj) => console.log(JSON.stringify(obj, null, 2));

const table = (rows, cols) => {
  if (!rows.length) return console.log('(no results)');
  const widths = cols.map(col => Math.max(col.length, ...rows.map(row => String(row[col] ?? '').length)));
  const line = (values) => values.map((value, index) => String(value ?? '').padEnd(widths[index])).join('  ');
  console.log(line(cols));
  console.log(widths.map(width => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(cols.map(col => row[col])));
};

const truncate = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function platformsFrom(option) {
  if (!option) return ['ios'];
  const list = [...new Set(option.split(',').map(value => value.trim()).filter(Boolean))];
  const unknown = list.find(value => !PLATFORMS.includes(value));
  if (unknown) throw new Error(`platform must be one of ${PLATFORMS.join(', ')}`);
  return list;
}

/**
 * Attach whatever image each row already has on disk, then download the rest
 * when the caller asked for images. Progress goes to stderr so `--json` output
 * stays machine-readable.
 */
async function withImages(screens, { download, json }) {
  for (const screen of screens) screen.path = imagePath(screen.id);
  if (!download) return screens;

  const missing = screens.filter(screen => !screen.path && screen.url);
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

// ------------------------------------------------------------------ filters
/**
 * Resolve every filter option a command was given into the display names the
 * upstream honours, failing on the first unknown value. Resolving up front
 * matters because the upstream answers an unknown filter with an ordinary
 * empty result rather than an error.
 */
async function resolveFilters(options, platform, { refresh = false } = {}) {
  const taxonomy = await fetchTaxonomy({ refresh });
  const filters = {};
  for (const [option, spec] of Object.entries(FILTERS)) {
    const given = options[option];
    if (!given?.length) continue;
    const tags = tagsFor(taxonomy, platform, spec.catalog);
    filters[option] = given.map(value => resolveTagName(tags, value, { option }));
  }
  return filters;
}

/**
 * The bare query is matched against the vocabulary rather than sent as free
 * text, which is what Mobbin's own search bar does: a query names a pattern,
 * an element, or a flow action. Copy printed inside a screenshot is a separate
 * axis, reached with `--text`.
 *
 * A query is resolved across every vocabulary the command accepts at once, so
 * `search "bottom sheet"` lands on the element rather than being forced into
 * the pattern filter and quietly matching nothing.
 */
function resolveQuery(taxonomy, platform, query, candidates) {
  const tags = candidates.flatMap(({ option, catalog }) => tagsFor(taxonomy, platform, catalog)
    .map(tag => ({ ...tag, option })));
  const name = resolveTagName(tags, query, { option: candidates.map(candidate => candidate.option).join('/') });
  const matched = tags.find(tag => tag.displayName === name);
  return { option: matched.option, name };
}

/**
 * Ask Mobbin's own index what a query means, when the local vocabulary has no
 * answer for it.
 *
 * The local pass is tried first because it is instant, works from cache, and is
 * right nearly always. This is for the phrasing it does not carry: the upstream
 * index recognises far more than the synonym lists do. It answers with tag ids,
 * which only mean something once mapped back through the dictionaries.
 *
 * A second opinion is never worth failing a search over, so any error here just
 * means "no answer".
 */
async function resolveQueryUpstream(taxonomy, platform, query, candidates) {
  const catalogs = Object.fromEntries(candidates.map(candidate => [candidate.option, candidate.catalog]));
  let refs;
  try {
    refs = await resolveViaSearchBar(query, { experience: 'apps', platform });
  } catch {
    return null;
  }
  for (const id of refs.filterTags) {
    const found = findTagById(taxonomy, platform, catalogs, id);
    if (found) return found;
  }
  return null;
}

/** Collect repeatable options into a list, so `--pattern a --pattern b` works. */
const collect = (value, previous = []) => previous.concat([value]);

function addFilterOptions(command, contentType) {
  for (const [option, spec] of Object.entries(FILTERS)) {
    if (!spec.contentTypes.includes(contentType)) continue;
    command.option(`--${option} <name>`, `filter by ${option} (repeatable)`, collect);
  }
  return command
    .addOption(new Option('--sort <order>', 'result ordering').choices(SORTS).default('popularity'))
    .option('--refresh', 're-fetch the cached filter vocabulary');
}

/**
 * Run one search per requested platform and merge. The upstream takes a single
 * platform per call, but `--platform ios,web` stays meaningful everywhere else
 * in the CLI, so it is honoured here too.
 */
async function searchAcross(platforms, contentType, options, { query = null, queryCandidates = [] } = {}) {
  const limit = Number(options.limit);
  const merged = [];
  let totalCount = 0;
  let hasMore = false;

  for (const platform of platforms) {
    const filters = await resolveFilters(options, platform, { refresh: options.refresh });
    let freeText = null;
    if (query) {
      const taxonomy = await fetchTaxonomy();
      try {
        const { option, name } = resolveQuery(taxonomy, platform, query, queryCandidates);
        filters[option] = [...new Set([...(filters[option] || []), name])];
      } catch (error) {
        // A query that names nothing in the local vocabulary is not necessarily
        // a mistake. An ambiguous one has matched several real terms, and only
        // the caller can pick.
        if (error.code !== 'UNKNOWN_TAG') throw error;
        const upstream = await resolveQueryUpstream(taxonomy, platform, query, queryCandidates);
        if (upstream) {
          filters[upstream.option] = [...new Set([...(filters[upstream.option] || []), upstream.name])];
          if (!options.json) console.error(`"${query}" resolved to ${upstream.option} "${upstream.name}".`);
        } else if (FREE_TEXT_CONTENT_TYPES.includes(contentType)) {
          freeText = query;
        } else {
          throw error;
        }
      }
    }
    if (freeText && Object.keys(filters).length) {
      throw new Error(`"${query}" is not a known ${queryCandidates.map(c => c.option).join(' or ')}, so it was treated as free text — and the upstream ignores every tag filter in that mode. Drop the filters, or use a vocabulary term (\`poppin tags\`).`);
    }
    if (!query && !Object.keys(filters).length && !options.text && !options.animated) {
      throw new Error(`give a query or at least one filter. Try \`poppin tags\` to see what ${contentType} can be filtered by.`);
    }
    if (freeText && !options.json) console.error(`"${query}" matched no vocabulary term; searching free text instead.`);

    const searchQuery = freeText
      ? buildFreeTextQuery({
        contentType,
        platform,
        query: freeText,
        text: options.text || null,
        animated: options.animated ? true : null,
        sort: options.sort,
      })
      : buildSearchQuery({
        contentType,
        platform,
        filters,
        text: options.text || null,
        animated: options.animated ? true : null,
        sort: options.sort,
      });
    const page = await searchContent(searchQuery, { limit });
    totalCount += page.totalCount;
    hasMore = hasMore || page.hasMore;
    merged.push(...page.results);
  }

  // The upstream ignores an app id on these endpoints, so scoping to one app
  // has to happen here, over what the filters already returned.
  const scoped = options.app
    ? merged.filter(row => String(row.appName || '').toLowerCase().includes(options.app.toLowerCase()))
    : merged;
  return { totalCount, hasMore, results: scoped.slice(0, limit) };
}

const reportCount = (shown, totalCount, hasMore) => {
  const more = hasMore || totalCount > shown ? ` of ${totalCount} matching upstream` : '';
  console.log(`\n${shown} result(s)${more}.`);
};

// ---------------------------------------------------------------- commands
program.command('find <query...>')
  .description('Search apps by name, tagline, or curated keywords, with their preview screens')
  .option('-n, --limit <n>', 'max apps', '12')
  .option('-p, --platform <list>', 'comma separated: ios,web', 'ios')
  .option('--category <name>', 'restrict to an app category (repeatable)', collect)
  .option('--images', 'download the preview screenshots')
  .option('--refresh', 're-fetch the cached filter vocabulary')
  .option('--json', 'machine-readable output')
  .action(async (query, options) => {
    const platforms = platformsFrom(options.platform);
    const limit = Number(options.limit);
    let matches;

    if (options.category?.length) {
      // A category is Mobbin's own axis, so the upstream app search answers it;
      // the words in the query then rank what came back.
      const pool = [];
      for (const platform of platforms) {
        const filters = await resolveFilters(options, platform, { refresh: options.refresh });
        const page = await searchContent(buildSearchQuery({ contentType: 'apps', platform, filters, sort: 'popularity' }));
        pool.push(...page.results.map(app => ({ ...app, tagline: app.tagline, previews: app.previews })));
      }
      matches = rankApps(pool, query.join(' '), { limit }) ;
      if (!matches.length) matches = pool.slice(0, limit);
    } else {
      const catalog = await fetchCatalogs(platforms);
      matches = rankApps(catalog, query.join(' '), { limit });
    }

    const screens = await withImages(
      matches.flatMap(app => (app.previews || []).map(preview => ({ ...preview, appName: app.appName }))),
      { download: options.images, json: options.json },
    );
    const byId = new Map(screens.map(screen => [screen.id, screen]));
    const results = matches.map(app => ({
      ...appView(app),
      previews: (app.previews || []).map(preview => ({ id: preview.id, path: byId.get(preview.id)?.path ?? null })),
    }));

    if (options.json) return out(results);
    if (!results.length) return console.log('no matching apps');
    for (const app of results) {
      console.log(`\n${app.appName}  [${app.platform}]  ${app.id.slice(0, 8)}`);
      if (app.tagline) console.log(`  ${app.tagline}`);
      if (app.keywords?.length) console.log(`  keywords: ${app.keywords.join(', ')}`);
      const files = app.previews.map(preview => preview.path || '(not downloaded)');
      if (files.length) console.log(`  previews: ${files.join('  ')}`);
    }
    console.log(`\n${results.length} app(s).`);
  });

addFilterOptions(
  program.command('search [query...]')
    .description('Search screens by UI pattern, element, category, or the copy printed on them')
    .option('-n, --limit <n>', 'max screens', '30')
    .option('-p, --platform <list>', 'comma separated: ios,web', 'ios')
    .option('--app <name>', 'restrict to apps whose name contains this')
    .option('--text <copy>', 'match text rendered inside the screenshot')
    .option('--animated', 'only screens that have a recorded animation')
    .option('--images', 'download the screenshots')
    .option('--json', 'machine-readable output'),
  'screens',
).action(async (query, options) => {
  const platforms = platformsFrom(options.platform);
  const page = await searchAcross(platforms, 'screens', options, {
    query: query.length ? query.join(' ') : null,
    queryCandidates: [
      { option: 'pattern', catalog: 'screenPatterns' },
      { option: 'element', catalog: 'screenElements' },
    ],
  });
  const results = await withImages(page.results, { download: options.images, json: options.json });

  if (options.json) return out(results);
  table(results.map(screen => ({
    id: screen.id.slice(0, 8),
    app: truncate(screen.appName, 22),
    platform: screen.platform,
    patterns: truncate(screen.patterns.join(', '), 34),
    image: screen.path || '-',
  })), ['id', 'app', 'platform', 'patterns', 'image']);
  reportCount(results.length, page.totalCount, page.hasMore);
});

addFilterOptions(
  program.command('elements [query...]')
    .description('Search screens that contain a given UI element')
    .option('-n, --limit <n>', 'max screens', '30')
    .option('-p, --platform <list>', 'comma separated: ios,web', 'ios')
    .option('--app <name>', 'restrict to apps whose name contains this')
    .option('--text <copy>', 'match text rendered inside the screenshot')
    .option('--animated', 'only screens that have a recorded animation')
    .option('--images', 'download the screenshots')
    .option('--json', 'machine-readable output'),
  'ui-elements',
).action(async (query, options) => {
  const platforms = platformsFrom(options.platform);
  const page = await searchAcross(platforms, 'ui-elements', options, {
    query: query.length ? query.join(' ') : null,
    queryCandidates: [{ option: 'element', catalog: 'screenElements' }],
  });
  const results = await withImages(page.results, { download: options.images, json: options.json });

  if (options.json) return out(results);
  table(results.map(screen => ({
    id: screen.id.slice(0, 8),
    app: truncate(screen.appName, 22),
    platform: screen.platform,
    elements: truncate(screen.elements.join(', '), 34),
    image: screen.path || '-',
  })), ['id', 'app', 'platform', 'elements', 'image']);
  reportCount(results.length, page.totalCount, page.hasMore);
});

addFilterOptions(
  program.command('flows [query...]')
    .description('Search multi-screen user flows, in the order the screens appear')
    .option('-n, --limit <n>', 'max flows', '10')
    .option('-p, --platform <list>', 'comma separated: ios,web', 'ios')
    .option('--app <name>', 'restrict to apps whose name contains this')
    .option('--images', 'download every frame of each flow')
    .option('--json', 'machine-readable output'),
  'flows',
).action(async (query, options) => {
  const platforms = platformsFrom(options.platform);
  const page = await searchAcross(platforms, 'flows', options, {
    query: query.length ? query.join(' ') : null,
    queryCandidates: [{ option: 'action', catalog: 'flowActions' }],
  });
  const frames = page.results.flatMap(flow => flow.screens);
  await withImages(frames, { download: options.images, json: options.json });

  if (options.json) return out(page.results);
  if (!page.results.length) return console.log('(no results)');
  for (const flow of page.results) {
    console.log(`\n${flow.appName}  [${flow.platform}]  ${flow.name || flow.actions.join(', ')}  ${flow.screenCount} screens  ${flow.id.slice(0, 8)}`);
    for (const frame of flow.screens) {
      console.log(`  ${String(frame.order).padStart(2)}. ${frame.path || '(not downloaded)'}`);
    }
  }
  reportCount(page.results.length, page.totalCount, page.hasMore);
});

// ------------------------------------------------------------------- sites
/**
 * The sites experience has no platform axis, so its vocabulary is looked up
 * under a pseudo-platform of the same name and `--platform` is absent from
 * every command below.
 */
async function resolveSiteFilters(options, { refresh = false } = {}) {
  const taxonomy = await fetchTaxonomy({ refresh });
  const filters = {};
  for (const [option, spec] of Object.entries(SITE_FILTERS)) {
    const given = options[option];
    if (!given?.length) continue;
    filters[option] = given.map(value => resolveTagName(tagsFor(taxonomy, 'sites', spec.catalog), value, { option }));
  }
  return filters;
}

function addSiteFilterOptions(command, contentType) {
  for (const [option, spec] of Object.entries(SITE_FILTERS)) {
    if (!spec.contentTypes.includes(contentType)) continue;
    command.option(`--${option} <name>`, `filter by ${option} (repeatable)`, collect);
  }
  return command
    .addOption(new Option('--sort <order>', 'result ordering').choices(SORTS).default('publishedAt'))
    .option('--refresh', 're-fetch the cached filter vocabulary')
    .option('--json', 'machine-readable output');
}

async function searchSites(contentType, query, options) {
  const filters = await resolveSiteFilters(options, { refresh: options.refresh });
  if (query) {
    const taxonomy = await fetchTaxonomy();
    const candidates = Object.entries(SITE_FILTERS)
      .filter(([, spec]) => spec.contentTypes.includes(contentType))
      .map(([option, spec]) => ({ option, catalog: spec.catalog }));
    // Sites have no free-text mode, so an unrecognised query is a dead end
    // rather than a fallback — resolveTagName's suggestions are the answer.
    const { option, name } = resolveQuery(taxonomy, 'sites', query, candidates);
    filters[option] = [...new Set([...(filters[option] || []), name])];
  }
  return searchContent(
    buildSiteSearchQuery({ contentType, filters, text: options.text || null, sort: options.sort }),
    { limit: Number(options.limit) },
  );
}

addSiteFilterOptions(
  program.command('sites [query...]')
    .description('Search marketing sites by category or visual style')
    .option('-n, --limit <n>', 'max sites', '30'),
  'sites',
).action(async (query, options) => {
  const page = await searchSites('sites', query.length ? query.join(' ') : null, options);
  const results = page.results.slice(0, Number(options.limit));

  if (options.json) return out(results);
  table(results.map(site => ({
    id: site.id.slice(0, 8),
    name: truncate(site.name, 26),
    tagline: truncate(site.tagline, 40),
    url: truncate(site.url, 30),
  })), ['id', 'name', 'tagline', 'url']);
  reportCount(results.length, page.totalCount, page.hasMore);
});

addSiteFilterOptions(
  program.command('sections [query...]')
    .description('Search page sections cut out of marketing sites: heroes, pricing, footers')
    .option('-n, --limit <n>', 'max sections', '30')
    .option('--text <copy>', 'match text rendered inside the section')
    .option('--images', 'download the section images'),
  'sections',
).action(async (query, options) => {
  const page = await searchSites('sections', query.length ? query.join(' ') : null, options);
  const results = await withImages(page.results.slice(0, Number(options.limit)), {
    download: options.images, json: options.json,
  });

  if (options.json) return out(results);
  table(results.map(section => ({
    id: section.id.slice(0, 8),
    patterns: truncate(section.patterns.join(', '), 30),
    page: truncate(section.pageUrl, 38),
    image: section.path || '-',
  })), ['id', 'patterns', 'page', 'image']);
  reportCount(results.length, page.totalCount, page.hasMore);
});

// ----------------------------------------------------------- visual search
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
};

program.command('similar <image>')
  .description('Search screens that look like a screenshot you already have')
  .option('-n, --limit <n>', 'max screens', '30')
  .option('-p, --platform <list>', 'comma separated: ios,web', 'ios')
  .option('--app <name>', 'restrict to apps whose name contains this')
  .option('--images', 'download the screenshots')
  .option('--json', 'machine-readable output')
  .action(async (file, options) => {
    const resolved = path.resolve(file);
    let bytes;
    try {
      bytes = fs.readFileSync(resolved);
    } catch {
      throw new Error(`cannot read ${file}`);
    }
    if (bytes.length > MAX_VISUAL_SEARCH_BYTES) {
      throw new Error(`${file} is ${(bytes.length / 1e6).toFixed(1)} MB; the upstream accepts at most 5 MB`);
    }
    const extension = path.extname(resolved).toLowerCase();
    const type = MIME_BY_EXT[extension];
    if (!type) throw new Error(`unsupported image type "${extension || 'none'}"; use ${Object.keys(MIME_BY_EXT).join(', ')}`);

    if (!options.json) console.error(`uploading ${path.basename(resolved)}...`);
    const imageId = await uploadVisualSearchImage(bytes, { filename: path.basename(resolved), type });

    const merged = [];
    let totalCount = 0;
    let hasMore = false;
    for (const platform of platformsFrom(options.platform)) {
      const page = await searchContent(buildVisualSearchQuery({ platform, imageId }), { limit: Number(options.limit) });
      totalCount += page.totalCount;
      hasMore = hasMore || page.hasMore;
      merged.push(...page.results);
    }
    const scoped = options.app
      ? merged.filter(row => String(row.appName || '').toLowerCase().includes(options.app.toLowerCase()))
      : merged;
    const results = await withImages(scoped.slice(0, Number(options.limit)), {
      download: options.images, json: options.json,
    });

    if (options.json) return out(results);
    table(results.map(screen => ({
      id: screen.id.slice(0, 8),
      app: truncate(screen.appName, 22),
      platform: screen.platform,
      patterns: truncate(screen.patterns.join(', '), 34),
      image: screen.path || '-',
    })), ['id', 'app', 'platform', 'patterns', 'image']);
    reportCount(results.length, totalCount, hasMore);
  });

program.command('app <name>')
  .description("Every screen Mobbin holds for one app, newest version first")
  .option('-n, --limit <n>', 'max screens', '40')
  .option('-p, --platform <list>', 'comma separated: ios,web', 'ios')
  .option('--versions', 'list the app versions instead of the screens')
  .option('--version <id>', 'only screens from this version id or id prefix')
  .option('--all', 'every screen across every version, not just the newest')
  .option('--images', 'download the screenshots')
  .option('--json', 'machine-readable output')
  .action(async (name, options) => {
    const catalog = await fetchCatalogs(platformsFrom(options.platform));
    const [app] = matchAppName(catalog, name);
    if (!app) {
      console.log('no matching app');
      process.exitCode = 1;
      return;
    }

    const library = await fetchAppLibrary(app.id);
    if (options.versions) {
      const versions = library.versions.map(version => ({
        id: version.id, publishedAt: version.publishedAt, screens: version.screens.length,
      }));
      if (options.json) return out({ ...library, versions });
      console.log(`\n${library.appName}  [${library.platform}]`);
      table(versions.map(version => ({
        version: version.id.slice(0, 8),
        published: String(version.publishedAt || '').slice(0, 10),
        screens: version.screens,
      })), ['version', 'published', 'screens']);
      return;
    }

    const wanted = options.version?.toLowerCase();
    const chosen = wanted
      ? library.versions.filter(version => version.id.toLowerCase().startsWith(wanted))
      : options.all ? library.versions : library.versions.slice(0, 1);
    if (wanted && !chosen.length) {
      console.log('no matching version');
      process.exitCode = 1;
      return;
    }

    const total = chosen.reduce((count, version) => count + version.screens.length, 0);
    const screens = chosen
      .flatMap(version => version.screens.map(screen => ({
        ...screen, versionId: version.id, publishedAt: version.publishedAt,
        appName: library.appName, platform: library.platform,
      })))
      .slice(0, Number(options.limit));
    await withImages(screens, { download: options.images, json: options.json });

    if (options.json) return out(screens);
    console.log(`\n${library.appName}  [${library.platform}]`);
    table(screens.map(screen => ({
      id: screen.id.slice(0, 8),
      version: screen.versionId.slice(0, 8),
      published: String(screen.publishedAt || '').slice(0, 10),
      image: screen.path || '-',
    })), ['id', 'version', 'published', 'image']);
    const scope = options.all || wanted ? '' : ' in the newest version';
    console.log(`\n${screens.length} of ${total} screen(s)${scope}. ${library.versions.length} version(s) held; --all spans them.`);
  });

program.command('screen <id>')
  .description('Show one screen by id or id prefix and download it')
  .option('-p, --platform <list>', 'comma separated: ios,web', 'ios,web')
  .option('--no-images', 'do not download the screenshot')
  .option('--json', 'machine-readable output')
  .action(async (id, options) => {
    const wanted = id.toLowerCase();
    const catalog = await fetchCatalogs(platformsFrom(options.platform));
    // The catalog holds only a few preview screens per app, so it answers a
    // prefix cheaply but knows almost nothing. Any id from a search result has
    // to be asked for directly.
    const screen = toScreens(catalog).find(candidate => candidate.id.toLowerCase().startsWith(wanted))
      || await fetchScreenInfo(id);
    if (!screen) {
      // The tables print shortened ids, but only catalog previews can be found
      // by prefix — the upstream will resolve a screen only by its whole id.
      const isPrefix = id.length < 36;
      console.log(isPrefix
        ? `not found. "${id}" is a shortened id, which only works for the preview screens in the catalog.\nFor a screen from search results, pass the full id — \`--json\` prints it.`
        : 'not found');
      process.exitCode = 1;
      return;
    }
    const [resolved] = await withImages([screen], { download: options.images, json: options.json });

    if (options.json) return out(resolved);
    console.log(`\n${resolved.appName || '(unknown app)'}  [${resolved.platform || '?'}]`);
    console.log(`id: ${resolved.id}`);
    console.log(`image: ${resolved.path || 'not downloaded'}`);
    if (resolved.fullpage) console.log(`full page: ${resolved.fullpage}`);
    if (resolved.animation) console.log(`animation: ${resolved.animation}`);
  });

program.command('tags [kind]')
  .description('The vocabulary the filters accept: patterns, elements, actions, categories, styles')
  .option('-p, --platform <platform>', 'ios, web, or sites', 'ios')
  .option('--search <text>', 'only tags whose name or synonyms contain this')
  .option('--definitions', 'include the definition of each tag')
  .option('--refresh', 're-fetch the cached vocabulary')
  .option('--json', 'machine-readable output')
  .action(async (kind, options) => {
    // Sites are their own experience rather than a platform, but they are a
    // vocabulary a caller browses the same way, so the option accepts both.
    const isSites = String(options.platform).toLowerCase() === 'sites';
    const platform = isSites ? 'sites' : platformsFrom(options.platform)[0];
    const dictionary = isSites ? SITE_FILTERS : FILTERS;
    const byKind = isSites ? SITE_FILTER_BY_KIND : FILTER_BY_KIND;
    const taxonomy = await fetchTaxonomy({ refresh: options.refresh });

    const selected = kind ? byKind.get(String(kind).toLowerCase()) : null;
    if (kind && !selected) {
      throw new Error(`tags kind must be one of ${Object.values(dictionary).map(spec => spec.plural).join(', ')}`);
    }
    const wanted = selected ? [[selected, dictionary[selected]]] : Object.entries(dictionary);

    const needle = options.search?.toLowerCase();
    const sections = wanted.map(([option, spec]) => {
      const tags = tagsFor(taxonomy, platform, spec.catalog).filter(tag => !needle
        || tag.displayName.toLowerCase().includes(needle)
        || tag.synonyms.some(synonym => synonym.toLowerCase().includes(needle)));
      return { kind: spec.plural, option, field: spec.field, platform, tags };
    });

    if (options.json) {
      return out(sections.map(section => ({
        ...section,
        tags: section.tags.map(tag => ({
          name: tag.displayName,
          group: tag.subCategory,
          synonyms: tag.synonyms,
          ...(options.definitions ? { definition: tag.definition } : {}),
        })),
      })));
    }
    for (const section of sections) {
      console.log(`\n${section.kind}  (--${section.option}, ${section.platform})  ${section.tags.length} value(s)`);
      let group = null;
      for (const tag of section.tags) {
        if (tag.subCategory !== group) {
          group = tag.subCategory;
          console.log(`  ${group}`);
        }
        const synonyms = tag.synonyms.length ? `  (${tag.synonyms.slice(0, 4).join(', ')})` : '';
        console.log(`    ${tag.displayName}${synonyms}`);
        if (options.definitions && tag.definition) console.log(`      ${tag.definition}`);
      }
    }
  });

program.command('stats')
  .description('What the upstream catalog currently holds')
  .option('-p, --platform <list>', 'comma separated: ios,web', 'ios,web')
  .action(async (options) => {
    const platforms = platformsFrom(options.platform);
    const taxonomy = await fetchTaxonomy();
    const byPlatform = [];
    let screens = 0;
    for (const platform of platforms) {
      const apps = await fetchCatalog(platform);
      const count = apps.reduce((total, app) => total + app.previews.length, 0);
      byPlatform.push({
        platform,
        apps: apps.length,
        previewScreens: count,
        vocabulary: Object.fromEntries(Object.entries(FILTERS)
          .map(([, spec]) => [spec.plural, tagsFor(taxonomy, platform, spec.catalog).length])),
      });
      screens += count;
    }
    const sites = await searchContent(buildSiteSearchQuery({ contentType: 'sites' }), { limit: 1 });
    const sections = await searchContent(buildSiteSearchQuery({ contentType: 'sections' }), { limit: 1 });

    out({
      source: BASE,
      contentTypes: [...CONTENT_TYPES, ...SITE_CONTENT_TYPES],
      apps: byPlatform.reduce((total, entry) => total + entry.apps, 0),
      previewScreens: screens,
      byPlatform,
      sites: {
        sites: sites.totalCount,
        sections: sections.totalCount,
        vocabulary: Object.fromEntries(Object.entries(SITE_FILTERS)
          .map(([, spec]) => [spec.plural, tagsFor(taxonomy, 'sites', spec.catalog).length])),
      },
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
    UPSTREAM_REJECTED: `${BASE} rejected the query; this is a poppin bug, please report it`,
    UPSTREAM_UNAUTHENTICATED: `${BASE} is not signed in; this is an upstream problem, not a missing credential of yours`,
    UPSTREAM_UNAVAILABLE: `${BASE} could not be reached`,
  };
  let message = messages[error.code]
    || (['TimeoutError', 'AbortError'].includes(error.name) ? `${BASE} did not respond in time` : error.message);

  // "not signed in" says nothing about whether this is a blip or has been
  // broken since yesterday. The proxy reports its own session state, so ask.
  if (error.code === 'UPSTREAM_UNAUTHENTICATED') {
    const health = await fetchHealth();
    if (health) message += `\n${describeSession(health)}`;
  }
  console.error(message);
  process.exitCode = 1;
}

function describeSession(health) {
  if (health.stopped) {
    const why = health.lastError?.message ? ` (${health.lastError.message})` : '';
    return `the proxy has given up renewing its session and needs attention${why}`;
  }
  if (health.expiresAt && !health.sessionValid) {
    return `its session expired ${ago(health.expiresAt)}; it should renew itself shortly`;
  }
  if (health.lastError) return `last renewal failed ${ago(health.lastError.at)}: ${health.lastError.message}`;
  return 'the proxy reports a valid session, so this may be a transient upstream failure';
}

function ago(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(timestamp)) / 1000));
  if (!Number.isFinite(seconds)) return 'at an unknown time';
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}
