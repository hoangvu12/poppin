import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCatalog, normaliseApp, toScreens } from '../src/catalog.mjs';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const RECORD = {
  id: 'app-1',
  platform: 'ios',
  appName: 'Calm',
  appTagline: 'Sleep more',
  keywords: ['meditation'],
  appLogoCdnImgSources: { src: 'https://bytescale.mobbin.com/logo.webp' },
  previewScreens: [
    { id: 'screen-1', screenUrl: 'https://example.test/content/app_screens/one.png' },
    { id: '', screenUrl: 'https://example.test/content/app_screens/two.png' },
  ],
};

test('a catalog record is normalised and malformed previews are dropped', () => {
  const app = normaliseApp(RECORD, 'ios');
  assert.equal(app.appName, 'Calm');
  assert.equal(app.tagline, 'Sleep more');
  assert.equal(app.logoUrl, 'https://bytescale.mobbin.com/logo.webp');
  assert.deepEqual(app.previews, [{ id: 'screen-1', url: 'https://example.test/content/app_screens/one.png' }]);
});

test('records without an id or name are discarded', () => {
  assert.equal(normaliseApp({ appName: 'No id' }, 'ios'), null);
  assert.equal(normaliseApp({ id: 'x' }, 'ios'), null);
});

test('the catalog is requested without any credential', async () => {
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url: String(url), options };
    return Response.json({ value: [RECORD] });
  };
  const apps = await fetchCatalog('ios');
  assert.match(seen.url, /nibbom\.nguyenvu\.dev\/api\/search-bar\/fetch-searchable-apps$/);
  assert.equal(seen.options.headers.cookie, undefined);
  assert.equal(seen.options.headers.authorization, undefined);
  assert.equal(apps.length, 1);
});

test('an unknown platform is rejected before any request', async () => {
  globalThis.fetch = async () => { throw new Error('should not be called'); };
  await assert.rejects(fetchCatalog('android'), /platform must be one of/);
});

test('an empty payload is reported as an upstream problem', async () => {
  globalThis.fetch = async () => Response.json({ value: [] });
  await assert.rejects(fetchCatalog('ios'), error => error.code === 'UPSTREAM_INVALID');
});

test('rate limiting is distinguished from other upstream failures', async () => {
  globalThis.fetch = async () => new Response('', { status: 429 });
  await assert.rejects(fetchCatalog('ios'), error => error.code === 'RATE_LIMITED');
});

test('apps flatten into screen rows carrying their app name', () => {
  const screens = toScreens([normaliseApp(RECORD, 'ios')]);
  assert.deepEqual(screens, [{
    id: 'screen-1',
    url: 'https://example.test/content/app_screens/one.png',
    appName: 'Calm',
    platform: 'ios',
  }]);
});
