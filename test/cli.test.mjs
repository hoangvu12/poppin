import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CATALOG = {
  ios: [{
    id: 'app-calm',
    platform: 'ios',
    appName: 'Calm',
    appTagline: 'Sleep more, stress less',
    keywords: ['meditation', 'sleep'],
    previewScreens: [
      { id: 'screen-aaaa', screenUrl: 'https://example.test/content/app_screens/a.png' },
      { id: 'screen-bbbb', screenUrl: 'https://example.test/content/app_screens/b.png' },
    ],
  }],
  web: [{
    id: 'app-linear',
    platform: 'web',
    appName: 'Linear',
    appTagline: 'Issue tracking',
    keywords: ['project management'],
    previewScreens: [{ id: 'screen-cccc', screenUrl: 'https://example.test/content/app_screens/c.png' }],
  }],
};

const group = (displayName, tags) => ({ displayName, tags });
const tag = (displayName, synonyms = []) => ({ displayName, synonyms, definition: `${displayName} definition` });

/** A cut-down copy of Mobbin's real dictionary, including the synonyms that make resolution work. */
const TAXONOMY = {
  mobile: {
    appCategories: [group('Categories', [tag('Finance', ['Banking']), tag('Health & Fitness')])],
    screenPatterns: [
      group('New User Experience', [tag('Signup', ['Register', 'Create Account']), tag('Login')]),
      group('Commerce & Finance', [tag('Subscription & Paywall', ['Upgrade', 'Free Trial', 'Premium'])]),
    ],
    // "Action Sheet" alongside "Bottom Sheet" makes a bare "sheet" genuinely
    // ambiguous, as it is in Mobbin's real vocabulary.
    screenElements: [group('Overlay', [tag('Bottom Sheet'), tag('Action Sheet'), tag('Button')])],
    flowActions: [group('New User Experience', [tag('Onboarding', ['Intro'])])],
  },
  web: {
    appCategories: [group('Categories', [tag('Finance')])],
    screenPatterns: [group('New User Experience', [tag('Signup')])],
    screenElements: [group('Overlay', [tag('Button')])],
    flowActions: [group('New User Experience', [tag('Onboarding')])],
  },
};

const screenRow = (id, over = {}) => ({
  type: 'curated',
  id,
  screenUrl: `https://example.test/content/app_screens/${id}.png`,
  width: 1179,
  height: 2556,
  screenPatterns: ['Signup'],
  screenElements: [],
  animation_id: null,
  appId: 'app-calm',
  appName: 'Calm',
  platform: 'ios',
  appVersionPublishedAt: '2026-07-27T10:03:15.055+00:00',
  restricted: false,
  ...over,
});

const APP_LIBRARY = {
  id: 'app-calm',
  appName: 'Calm',
  platform: 'ios',
  appVersions: [
    {
      id: 'version-old',
      publishedAt: '2020-09-15T00:00:00+00:00',
      appScreens: [{ id: 'old-0001', screenUrl: 'https://example.test/content/app_screens/o1.png' }],
    },
    {
      id: 'version-new',
      publishedAt: '2026-07-27T00:00:00+00:00',
      appScreens: [
        { id: 'new-0001', screenUrl: 'https://example.test/content/app_screens/n1.png' },
        { id: 'new-0002', screenUrl: 'https://example.test/content/app_screens/n2.png' },
      ],
    },
  ],
};

const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poppin-cli-test-'));
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poppin-cache-test-'));
let server;
let base;

/** Per-path request counts and last body, so tests can assert what was sent. */
let seen;
const resetSeen = () => { seen = { counts: {}, bodies: {} }; };
resetSeen();

before(async () => {
  server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url;
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      seen.counts[url] = (seen.counts[url] || 0) + 1;
      seen.bodies[url] = body;

      const send = (value) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ value }));
      };

      if (url === '/api/search-bar/fetch-searchable-apps') return send(CATALOG[body.platform] || []);
      if (url === '/api/filter-tags/fetch-filter-tag-catalogs') return send(TAXONOMY);
      if (url === '/api/app/fetch-app-versions-screens') return send(APP_LIBRARY);

      if (url === '/api/search/fetch-search-page-screens' || url === '/api/search/fetch-search-page-ui-elements') {
        const query = body.searchQuery;
        // Free text is a distinct mode upstream: tag filters are ignored there,
        // and a missing/unsupported `mode` gets the request dropped entirely.
        if (query.type === 'free_text_search') {
          if (query.mode !== 'standard' || !query.query) {
            response.writeHead(200, { 'content-type': 'application/json' });
            return response.end('');
          }
          const rows = [screenRow('free-0001', { appName: 'Phantom', screenPatterns: [] })];
          return send({ searchRequestId: body.searchRequestId, data: rows, hasNextPage: false, totalCount: 42 });
        }
        // Mirror the upstream: an unknown filter value is an empty result, not an error.
        const rows = query.screenPatterns?.includes('Subscription & Paywall')
          ? [screenRow('pay-0001', { screenPatterns: ['Subscription & Paywall'] })]
          : query.screenElements?.includes('Bottom Sheet')
            ? [screenRow('sheet-001', { screenElements: ['Bottom Sheet'], screenPatterns: [] })]
            : query.textInScreenshotQuery
              ? [screenRow('text-0001')]
              : query.screenPatterns?.includes('Signup')
                ? [screenRow('sign-0001'), screenRow('sign-0002', { appName: 'Headspace' })]
                : [];
        return send({ searchRequestId: body.searchRequestId, data: rows, hasNextPage: false, totalCount: rows.length * 10 });
      }

      if (url === '/api/search/fetch-search-page-flows') {
        const rows = body.searchQuery.flowActions?.includes('Onboarding') ? [{
          id: 'flow-0001',
          name: 'Onboarding',
          actions: ['Onboarding'],
          appId: 'app-calm',
          appName: 'Calm',
          platform: 'ios',
          appVersionPublishedAt: '2026-08-03T10:10:38.818Z',
          restricted: false,
          videoCdnVideoSources: { source: { url: 'https://bytescale.mobbin.com/FW25bBB/video/mobbin.com/prod/file.mp4' } },
          screens: [
            { order: 1, screenId: 'frame-b', screenCdnImgSources: { src: 'https://bytescale.mobbin.com/FW25bBB/image/mobbin.com/prod/b.webp' } },
            { order: 0, screenId: 'frame-a', hotspotX: 10, hotspotY: 20, hotspotWidth: 30, hotspotHeight: 40, screenCdnImgSources: { src: 'https://bytescale.mobbin.com/FW25bBB/image/mobbin.com/prod/a.webp' } },
          ],
        }] : [];
        return send({ searchRequestId: body.searchRequestId, data: rows, hasNextPage: false, totalCount: rows.length });
      }

      if (url === '/api/search/fetch-search-page-apps') {
        const rows = body.searchQuery.categories?.includes('Finance') ? [{
          id: 'app-monzo',
          appName: 'Monzo',
          appTagline: 'Personal & business banking',
          platform: 'ios',
          keywords: ['money'],
          allAppCategories: ['Finance', 'Banking (Digital)'],
          appVersionLatestPublishedAt: '2026-08-03T10:11:38.818+00:00',
          isRestricted: false,
          previewScreens: [{ id: 'monzo-001', screenUrl: 'https://example.test/content/app_screens/m1.png' }],
        }] : [];
        return send({ searchRequestId: body.searchRequestId, data: rows, hasNextPage: false, totalCount: rows.length });
      }

      response.writeHead(404).end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(imageDir, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetSeen();
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
});

/**
 * The stub server shares this process, so the CLI must be spawned
 * asynchronously: a synchronous spawn would block the event loop that has to
 * answer the child's request.
 */
function run(args, env = {}) {
  return new Promise(resolve => {
    execFile(process.execPath, ['bin/poppin.mjs', ...args], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        POPPIN_BASE: base,
        POPPIN_IMAGE_DIR: imageDir,
        POPPIN_CACHE_DIR: cacheDir,
        ...env,
      },
      encoding: 'utf8',
    }, (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }));
  });
}

// ------------------------------------------------------------------- find
test('find returns matching apps with their previews as JSON', async () => {
  const result = await run(['find', 'meditation', '--json']);
  assert.equal(result.status, 0);
  const apps = JSON.parse(result.stdout);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].appName, 'Calm');
  assert.equal(apps[0].previews.length, 2);
  assert.equal(apps[0].previews[0].path, null);
});

test('the platform option selects which catalog is fetched', async () => {
  const result = await run(['find', 'issue tracking', '--platform', 'web', '--json']);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout)[0].appName, 'Linear');
});

test('an unknown platform is refused without a stack trace', async () => {
  const result = await run(['find', 'calm', '--platform', 'android']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /platform must be one of/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('find with a category asks the upstream app search rather than ranking locally', async () => {
  const result = await run(['find', 'banking', '--category', 'Finance', '--json']);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout)[0].appName, 'Monzo');
  assert.equal(seen.bodies['/api/search/fetch-search-page-apps'].searchQuery.categories[0], 'Finance');
});

// ----------------------------------------------------------------- search
test('a bare query resolves to a screen pattern', async () => {
  const result = await run(['search', 'signup', '--json']);
  assert.equal(result.status, 0);
  const screens = JSON.parse(result.stdout);
  assert.equal(screens.length, 2);
  assert.deepEqual(seen.bodies['/api/search/fetch-search-page-screens'].searchQuery.screenPatterns, ['Signup']);
});

test('a synonym resolves to the canonical pattern name', async () => {
  const result = await run(['search', 'upgrade', '--json']);
  assert.equal(result.status, 0);
  assert.deepEqual(
    seen.bodies['/api/search/fetch-search-page-screens'].searchQuery.screenPatterns,
    ['Subscription & Paywall'],
  );
  assert.equal(JSON.parse(result.stdout)[0].patterns[0], 'Subscription & Paywall');
});

test('a query naming an element is sent as an element, not a pattern', async () => {
  const result = await run(['search', 'bottom sheet', '--json']);
  assert.equal(result.status, 0);
  const query = seen.bodies['/api/search/fetch-search-page-screens'].searchQuery;
  assert.deepEqual(query.screenElements, ['Bottom Sheet']);
  assert.equal(query.screenPatterns, null);
});

/**
 * The upstream answers an unknown filter with an ordinary empty result, so a
 * typo would otherwise read as "Mobbin has none of these".
 */
test('an unknown filter value fails loudly with suggestions instead of returning nothing', async () => {
  // "Upgrade & Paywall" is a plausible guess that Mobbin does not use; the real
  // name is "Subscription & Paywall", reachable through the "Upgrade" synonym.
  const result = await run(['search', '--pattern', 'Upgrade & Paywall']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a known value/);
  assert.match(result.stderr, /Subscription & Paywall/);
  assert.equal(seen.counts['/api/search/fetch-search-page-screens'], undefined);
});

test('a partial filter value still resolves rather than being refused', async () => {
  const result = await run(['search', '--pattern', 'paywal', '--json']);
  assert.equal(result.status, 0);
  assert.deepEqual(
    seen.bodies['/api/search/fetch-search-page-screens'].searchQuery.screenPatterns,
    ['Subscription & Paywall'],
  );
});

/**
 * A query naming nothing in the vocabulary is not necessarily a mistake, so it
 * falls through to Mobbin's free-text search rather than being refused.
 */
test('a query that matches no vocabulary term falls back to free-text search', async () => {
  const result = await run(['search', 'crypto portfolio dashboard', '--json']);
  assert.equal(result.status, 0);
  const query = seen.bodies['/api/search/fetch-search-page-screens'].searchQuery;
  assert.equal(query.type, 'free_text_search');
  assert.equal(query.query, 'crypto portfolio dashboard');
  assert.equal(query.mode, 'standard');
  assert.equal(JSON.parse(result.stdout)[0].appName, 'Phantom');
});

test('the free-text fallback is announced on stderr, keeping stdout parseable', async () => {
  const plain = await run(['search', 'crypto portfolio dashboard']);
  assert.match(plain.stderr, /matched no vocabulary term/);
  const json = await run(['search', 'crypto portfolio dashboard', '--json']);
  assert.doesNotMatch(json.stdout, /matched no vocabulary term/);
  JSON.parse(json.stdout);
});

/**
 * The upstream silently ignores tag filters in free-text mode, so combining
 * them would quietly return unfiltered results.
 */
test('a free-text query combined with a tag filter is refused rather than silently unfiltered', async () => {
  const result = await run(['search', 'crypto portfolio dashboard', '--category', 'Finance']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ignores every tag filter/);
  assert.equal(seen.counts['/api/search/fetch-search-page-screens'], undefined);
});

test('an ambiguous query is refused rather than falling back to free text', async () => {
  const result = await run(['search', 'sheet']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ambiguous/);
  assert.equal(seen.counts['/api/search/fetch-search-page-screens'], undefined);
});

test('an explicit unknown --pattern still fails instead of falling back', async () => {
  const result = await run(['search', '--pattern', 'Upgrade & Paywall']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a known value/);
  assert.equal(seen.counts['/api/search/fetch-search-page-screens'], undefined);
});

test('flows do not fall back to free text, since their vocabulary is small and closed', async () => {
  const result = await run(['flows', 'zzzznotathing']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a known value/);
  assert.equal(seen.counts['/api/search/fetch-search-page-flows'], undefined);
});

test('the strict payload shape the upstream requires is sent in full', async () => {
  await run(['search', 'signup', '--json']);
  const query = seen.bodies['/api/search/fetch-search-page-screens'].searchQuery;
  for (const field of ['categories', 'screenElements', 'textInScreenshotQuery', 'hasAnimation']) {
    assert.ok(field in query, `${field} must be present even when unset`);
  }
  assert.equal(query.type, 'filters');
  assert.equal(query.contentType, 'screens');
  assert.equal(query.platform, 'ios');
  assert.equal(query.sortBy, 'popularity');
});

test('text searches the copy printed inside the screenshot', async () => {
  const result = await run(['search', '--text', 'get started', '--json']);
  assert.equal(result.status, 0);
  assert.equal(
    seen.bodies['/api/search/fetch-search-page-screens'].searchQuery.textInScreenshotQuery,
    'get started',
  );
  assert.equal(JSON.parse(result.stdout).length, 1);
});

test('filters compose and repeat', async () => {
  await run(['search', '--pattern', 'Signup', '--pattern', 'Login', '--category', 'Finance', '--json']);
  const query = seen.bodies['/api/search/fetch-search-page-screens'].searchQuery;
  assert.deepEqual(query.screenPatterns, ['Signup', 'Login']);
  assert.deepEqual(query.categories, ['Finance']);
});

test('an app name narrows results the upstream cannot scope itself', async () => {
  const result = await run(['search', 'signup', '--app', 'headspace', '--json']);
  assert.equal(result.status, 0);
  const screens = JSON.parse(result.stdout);
  assert.equal(screens.length, 1);
  assert.equal(screens[0].appName, 'Headspace');
});

test('search without a query or any filter explains itself rather than guessing', async () => {
  const result = await run(['search']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /give a query or at least one filter/);
});

test('an unknown sort is refused by the CLI before the upstream drops it', async () => {
  const result = await run(['search', 'signup', '--sort', 'rating']);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

// --------------------------------------------------------------- elements
test('elements searches by UI element', async () => {
  const result = await run(['elements', 'bottom sheet', '--json']);
  assert.equal(result.status, 0);
  const query = seen.bodies['/api/search/fetch-search-page-ui-elements'].searchQuery;
  assert.deepEqual(query.screenElements, ['Bottom Sheet']);
  assert.equal(JSON.parse(result.stdout)[0].elements[0], 'Bottom Sheet');
});

// ------------------------------------------------------------------ flows
test('flows returns ordered frames with their hotspots', async () => {
  const result = await run(['flows', 'onboarding', '--json']);
  assert.equal(result.status, 0);
  const [flow] = JSON.parse(result.stdout);
  assert.equal(flow.appName, 'Calm');
  assert.equal(flow.screenCount, 2);
  assert.deepEqual(flow.screens.map(frame => frame.order), [0, 1]);
  assert.deepEqual(flow.screens[0].hotspot, { x: 10, y: 20, width: 30, height: 40 });
  assert.ok(flow.video);
});

test('flow frames are addressed by position, so a repeated screen stays distinct', async () => {
  const result = await run(['flows', 'onboarding', '--json']);
  const [flow] = JSON.parse(result.stdout);
  assert.equal(flow.screens[0].id, 'flow-flow-0001-000');
  assert.equal(flow.screens[1].id, 'flow-flow-0001-001');
});

// -------------------------------------------------------------------- app
test('app returns the newest version by default and reports the rest', async () => {
  const result = await run(['app', 'calm', '--json']);
  assert.equal(result.status, 0);
  const screens = JSON.parse(result.stdout);
  assert.equal(screens.length, 2);
  assert.ok(screens.every(screen => screen.versionId === 'version-new'));
});

test('app --all spans every version, newest first', async () => {
  const result = await run(['app', 'calm', '--all', '--json']);
  assert.equal(result.status, 0);
  const screens = JSON.parse(result.stdout);
  assert.equal(screens.length, 3);
  assert.equal(screens[0].versionId, 'version-new');
  assert.equal(screens.at(-1).versionId, 'version-old');
});

test('app --versions lists the version history', async () => {
  const result = await run(['app', 'calm', '--versions', '--json']);
  assert.equal(result.status, 0);
  const library = JSON.parse(result.stdout);
  assert.equal(library.versions.length, 2);
  assert.equal(library.versions[0].screens, 2);
});

test('an unknown app exits non-zero', async () => {
  const result = await run(['app', 'nosuchapp']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no matching app/);
});

// ----------------------------------------------------------------- screen
test('screen resolves an id prefix across platforms', async () => {
  const result = await run(['screen', 'screen-cc', '--no-images', '--json']);
  assert.equal(result.status, 0);
  const screen = JSON.parse(result.stdout);
  assert.equal(screen.appName, 'Linear');
  assert.equal(screen.id, 'screen-cccc');
});

test('an unknown screen id exits non-zero', async () => {
  const result = await run(['screen', 'nope-1234', '--no-images']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not found/);
});

// ------------------------------------------------------------------- tags
test('tags lists the vocabulary a filter accepts', async () => {
  const result = await run(['tags', 'patterns', '--json']);
  assert.equal(result.status, 0);
  const [section] = JSON.parse(result.stdout);
  assert.equal(section.option, 'pattern');
  assert.ok(section.tags.some(entry => entry.name === 'Subscription & Paywall'));
});

test('tags --search finds a tag through its synonyms', async () => {
  const result = await run(['tags', 'patterns', '--search', 'free trial', '--json']);
  assert.equal(result.status, 0);
  const [section] = JSON.parse(result.stdout);
  assert.equal(section.tags.length, 1);
  assert.equal(section.tags[0].name, 'Subscription & Paywall');
});

test('tags takes either the option name or its plural, including irregular ones', async () => {
  for (const kind of ['categories', 'category']) {
    const result = await run(['tags', kind, '--json']);
    assert.equal(result.status, 0, `tags ${kind} should be accepted`);
    const [section] = JSON.parse(result.stdout);
    assert.equal(section.kind, 'categories');
    assert.ok(section.tags.some(entry => entry.name === 'Finance'));
  }
  const bad = await run(['tags', 'bogus']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /must be one of .*categories/);
});

test('tags with no kind lists every vocabulary', async () => {
  const result = await run(['tags', '--json']);
  assert.equal(result.status, 0);
  const sections = JSON.parse(result.stdout);
  assert.deepEqual(sections.map(section => section.option).sort(), ['action', 'category', 'element', 'pattern']);
});

// ------------------------------------------------------------------ cache
test('the vocabulary is cached between commands but results are not', async () => {
  await run(['search', 'signup', '--json']);
  assert.equal(seen.counts['/api/filter-tags/fetch-filter-tag-catalogs'], 1);
  await run(['search', 'signup', '--json']);
  assert.equal(seen.counts['/api/filter-tags/fetch-filter-tag-catalogs'], 1, 'taxonomy should be served from cache');
  assert.equal(seen.counts['/api/search/fetch-search-page-screens'], 2, 'results must always be live');
});

test('--refresh re-fetches the cached vocabulary', async () => {
  await run(['search', 'signup', '--json']);
  await run(['search', 'signup', '--refresh', '--json']);
  assert.equal(seen.counts['/api/filter-tags/fetch-filter-tag-catalogs'], 2);
});

// ------------------------------------------------------------------ stats
test('stats reports the live catalog and the vocabulary sizes', async () => {
  const result = await run(['stats']);
  assert.equal(result.status, 0);
  const stats = JSON.parse(result.stdout);
  assert.equal(stats.source, base);
  assert.equal(stats.apps, 2);
  assert.equal(stats.previewScreens, 3);
  assert.equal(stats.imageDir, imageDir);
  assert.equal(stats.byPlatform[0].vocabulary.patterns, 3);
});

// --------------------------------------------------------------- upstream
test('an unreachable upstream fails with a readable message', async () => {
  const result = await run(['find', 'calm'], { POPPIN_BASE: 'http://127.0.0.1:1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not be reached/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('no command reaches the network with a cookie or auth header', async () => {
  const result = await run(['find', 'calm', '--json']);
  assert.doesNotMatch(result.stdout + result.stderr, /cookie|sb-|session/i);
});
