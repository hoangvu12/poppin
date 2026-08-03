import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { USER_AGENT } from './config.mjs';

const BYTESCALE = 'https://bytescale.mobbin.com/FW25bBB/image/mobbin.com/prod';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 20_000;
const SAFE_SCREEN_ID = /^[a-zA-Z0-9-]{4,64}$/;
const ALLOWED_SOURCE_HOSTS = new Set([
  'bytescale.mobbin.com',
  'ujasntkfphywizsdaapi.supabase.co',
  'mobbin.com',
]);

/**
 * Screenshots are working files, not a library: they go to the system temp
 * directory so the OS reclaims them, and an existing file for the same screen
 * is reused within a session rather than downloaded twice.
 */
export const IMG_DIR = process.env.POPPIN_IMAGE_DIR
  ? path.resolve(process.env.POPPIN_IMAGE_DIR)
  : path.join(os.tmpdir(), 'poppin-screens');

/**
 * The catalog hands back storage URLs that are internal keys rather than
 * fetchable addresses, so requesting them directly fails. Map the key onto the
 * CDN that actually serves it, at the size and format we want on disk.
 */
export function toServableUrl(url, { width = 1920 } = {}) {
  if (!url) return null;
  const parsed = new URL(url, 'https://mobbin.com');
  if (parsed.protocol !== 'https:' || !ALLOWED_SOURCE_HOSTS.has(parsed.hostname)) {
    throw new Error('unsupported image source');
  }
  if (parsed.hostname === 'bytescale.mobbin.com') {
    if (!parsed.pathname.startsWith('/FW25bBB/image/mobbin.com/prod/')) throw new Error('unsupported CDN path');
    return parsed.href;
  }
  const match = url.match(/\/public\/(content\/[^?]+)/) || url.match(/\/(content\/app_[a-z]+\/[^?]+)/);
  if (!match) throw new Error('unsupported image path');
  const key = match[1];
  if (key.includes('\\') || key.split('/').some(part => part === '..')) throw new Error('unsupported image path');
  return `${BYTESCALE}/${key}?f=webp&w=${width}&q=85`;
}

const EXT_BY_TYPE = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/avif': 'avif',
  'image/gif': 'gif',
};

/** Any file already on disk for this screen, whatever format it was served in. */
export function imagePath(id) {
  assertScreenId(id);
  for (const ext of Object.values(EXT_BY_TYPE)) {
    const candidate = path.join(IMG_DIR, `${id}.${ext}`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) return candidate;
  }
  return null;
}

/**
 * Download and store the image as served. The CDN is asked for webp, so the
 * bytes already arrive in the format we want. Re-encoding them locally would
 * cost a large native dependency and lose quality for no benefit, so the
 * response body is written straight to disk.
 */
export async function saveImage(id, url, { force = false } = {}) {
  if (!url) return null;
  assertScreenId(id);
  if (!force) {
    const existing = imagePath(id);
    if (existing) return existing;
  }

  const response = await fetch(toServableUrl(url), {
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    headers: {
      'user-agent': USER_AGENT,
      referer: 'https://mobbin.com/',
      accept: 'image/webp,image/png,image/*,*/*;q=0.8',
    },
  });
  if (!response.ok) throw new Error(`image ${response.status} for ${id}`);

  const type = (response.headers.get('content-type') || '').split(';')[0].trim();
  const ext = EXT_BY_TYPE[type];
  if (!ext) throw new Error(`unsupported image content type for ${id}`);
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) throw new Error(`image too large for ${id}`);
  const body = await readLimitedBody(response, id);
  if (!body.length) throw new Error(`empty image body for ${id}`);

  fs.mkdirSync(IMG_DIR, { recursive: true });
  const destination = path.join(IMG_DIR, `${id}.${ext}`);
  const temp = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temp, body);
  fs.renameSync(temp, destination);
  return destination;
}

/**
 * Download a batch with bounded concurrency and report failures instead of
 * throwing: one dead image should never sink a whole result set.
 */
export async function saveImages(screens, { concurrency = 5, onError = () => {} } = {}) {
  const queue = [...screens];
  const saved = new Map();
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const screen = queue.shift();
      try {
        const file = await saveImage(screen.id, screen.url);
        if (file) saved.set(screen.id, file);
      } catch (error) {
        onError(screen, error);
      }
    }
  });
  await Promise.all(workers);
  return saved;
}

function assertScreenId(id) {
  if (!SAFE_SCREEN_ID.test(id)) throw new Error('invalid screen id');
}

async function readLimitedBody(response, id) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) throw new Error(`image too large for ${id}`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
