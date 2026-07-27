import fs from 'node:fs';
import path from 'node:path';
import { IMG_DIR } from './db.mjs';

const BYTESCALE = 'https://bytescale.mobbin.com/FW25bBB/image/mobbin.com/prod';

/**
 * The data layer hands back storage URLs that are internal keys rather than
 * fetchable addresses, so requesting them directly fails. Map the key onto the
 * CDN that actually serves it, at the size and format we want to cache.
 */
export function toServableUrl(url, { width = 1920 } = {}) {
  if (!url) return null;
  if (url.includes('bytescale.mobbin.com')) return url; // already a CDN URL
  const m = url.match(/\/public\/(content\/[^?]+)/) || url.match(/\/(content\/app_[a-z]+\/[^?]+)/);
  if (!m) return url;
  return `${BYTESCALE}/${m[1]}?f=webp&w=${width}&q=85`;
}

const EXT_BY_TYPE = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/avif': 'avif',
  'image/gif': 'gif',
};

/** Any already-cached file for this id, whatever format it was served in. */
export function imagePath(id) {
  for (const ext of ['webp', 'png', 'jpg', 'avif', 'gif']) {
    const p = path.join(IMG_DIR, `${id}.${ext}`);
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return p;
  }
  return null;
}

/**
 * Download and store the image as served. The CDN is asked for webp, so the
 * bytes are already in the format we want. Re-encoding them locally would cost
 * a large native image dependency and lose quality for no benefit, so the
 * response body is written straight to disk.
 */
export async function cacheImage(id, url, { force = false } = {}) {
  if (!url) return null;
  if (!force) {
    const existing = imagePath(id);
    if (existing) return existing;
  }

  const res = await fetch(toServableUrl(url), {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'referer': 'https://mobbin.com/',
      'accept': 'image/webp,image/png,image/*,*/*;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`image ${res.status} for ${id}`);

  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  const ext = EXT_BY_TYPE[type] || 'webp';
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error(`empty image body for ${id}`);

  const dest = path.join(IMG_DIR, `${id}.${ext}`);
  fs.writeFileSync(dest, buf);
  return dest;
}
