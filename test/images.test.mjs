import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poppin-images-test-'));
process.env.POPPIN_IMAGE_DIR = tempDir;

let images;
let originalFetch;

before(async () => {
  images = await import('../src/images.mjs');
  originalFetch = globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.POPPIN_IMAGE_DIR;
});

test('screenshots are written under the temp image directory', () => {
  assert.equal(images.IMG_DIR, tempDir);
});

test('image URLs are restricted to known sources', () => {
  assert.throws(() => images.toServableUrl('https://attacker.example/content/app_ios/file.png'), /unsupported/);
  assert.equal(
    images.toServableUrl('https://ujasntkfphywizsdaapi.supabase.co/storage/v1/object/public/content/app_ios/file.png'),
    'https://bytescale.mobbin.com/FW25bBB/image/mobbin.com/prod/content/app_ios/file.png?f=webp&w=1920&q=85',
  );
});

test('unsafe screen ids are rejected before a filesystem write', async () => {
  await assert.rejects(
    images.saveImage('../outside', '/storage/v1/object/public/content/app_ios/file.png'),
    /invalid screen id/,
  );
});

test('non-image responses are not written to disk', async () => {
  globalThis.fetch = async () => new Response('<html>nope</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
  await assert.rejects(
    images.saveImage('screen-1234', '/storage/v1/object/public/content/app_ios/file.png'),
    /unsupported image content type/,
  );
  assert.equal(images.imagePath('screen-1234'), null);
});

test('a saved image is reused instead of downloaded twice', async () => {
  const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46]);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(bytes, { status: 200, headers: { 'content-type': 'image/webp' } });
  };
  const url = '/storage/v1/object/public/content/app_ios/file.png';
  const first = await images.saveImage('screen-5678', url);
  const second = await images.saveImage('screen-5678', url);
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(path.dirname(first), tempDir);
});

test('a batch reports failures instead of throwing', async () => {
  globalThis.fetch = async () => new Response('', { status: 404 });
  const failures = [];
  const saved = await images.saveImages(
    [{ id: 'screen-aaaa', url: '/storage/v1/object/public/content/app_ios/a.png' }],
    { onError: (screen, error) => failures.push([screen.id, error.message]) },
  );
  assert.equal(saved.size, 0);
  assert.equal(failures.length, 1);
});
