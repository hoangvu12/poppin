import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { IMG_DIR } from './db.mjs';

const BYTESCALE = 'https://bytescale.mobbin.com/FW25bBB/image/mobbin.com/prod';

/**
 * The data layer hands back storage URLs that are internal keys rather than
 * fetchable addresses, so requesting them directly fails. Map the key onto the
 * CDN that actually serves it, at the size we want to cache.
 */
export function toServableUrl(url, { width = 1920 } = {}) {
  if (!url) return null;
  if (url.includes('bytescale.mobbin.com')) return url; // already a CDN URL
  const m = url.match(/\/public\/(content\/[^?]+)/) || url.match(/\/(content\/app_[a-z]+\/[^?]+)/);
  if (!m) return url;
  return `${BYTESCALE}/${m[1]}?f=webp&w=${width}&q=85`;
}

/**
 * Download the image exactly as the page serves it (watermark and all) and
 * normalise to webp for compact local storage.
 */
export async function cacheImage(id, url, { force = false } = {}) {
  if (!url) return null;
  const dest = path.join(IMG_DIR, `${id}.webp`);
  if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;

  const res = await fetch(toServableUrl(url), {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'referer': 'https://mobbin.com/',
      'accept': 'image/webp,image/png,image/*,*/*;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`image ${res.status} for ${id}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await sharp(buf).webp({ quality: 82 }).toFile(dest);
  return dest;
}

export function imagePath(id) {
  const p = path.join(IMG_DIR, `${id}.webp`);
  return fs.existsSync(p) ? p : null;
}
