import { after, before, test } from 'node:test';
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

const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poppin-cli-test-'));
let server;
let base;

before(async () => {
  server = http.createServer((request, response) => {
    if (request.url !== '/api/search-bar/fetch-searchable-apps') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const { platform } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ value: CATALOG[platform] || [] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(imageDir, { recursive: true, force: true });
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
      env: { ...process.env, POPPIN_BASE: base, POPPIN_IMAGE_DIR: imageDir, ...env },
      encoding: 'utf8',
    }, (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }));
  });
}

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

test('a named app falls back to its screens when the query matches nothing', async () => {
  const result = await run(['search', 'nonsense', '--app', 'calm', '--json']);
  assert.equal(result.status, 0);
  const screens = JSON.parse(result.stdout);
  assert.equal(screens.length, 2);
  assert.ok(screens.every(screen => screen.appName === 'Calm'));
});

test('app lists the screens of one app', async () => {
  const result = await run(['app', 'calm', '--json']);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).length, 2);
});

test('stats reports the live catalog rather than a local library', async () => {
  const result = await run(['stats']);
  assert.equal(result.status, 0);
  const stats = JSON.parse(result.stdout);
  assert.equal(stats.source, base);
  assert.equal(stats.apps, 2);
  assert.equal(stats.screens, 3);
  assert.equal(stats.imageDir, imageDir);
});

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
