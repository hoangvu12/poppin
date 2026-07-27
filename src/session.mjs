import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.mjs';
import { BASE } from './config.mjs';

const SESSION_FILE = path.join(DATA_DIR, 'session.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function saveSession(cookies) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const header = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ header, saved: new Date().toISOString() }, null, 2));
  return header;
}

export function loadSession() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).header || null; }
  catch { return null; }
}

export function hasSession() {
  return !!loadSession();
}

/**
 * A request carrying the stored session. Mobbin's endpoints answer 200 with an
 * empty body when the cookie is missing or stale rather than returning 401, so
 * callers must judge success by the payload, not the status code.
 */
export async function authedFetch(pathOrUrl, { method = 'GET', body, headers = {} } = {}) {
  const cookie = loadSession();
  if (!cookie) throw new Error('no stored session, run `poppin import-cookies`');
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE}${pathOrUrl}`;
  return fetch(url, {
    method,
    headers: {
      'user-agent': UA,
      origin: BASE,
      referer: `${BASE}/discover/apps/ios/latest`,
      cookie,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/**
 * Fetch the searchable catalog without a browser. Returns null when the
 * response comes back empty, which is how an expired session presents.
 */
export async function fetchCatalogDirect(platform = 'ios') {
  const res = await authedFetch('/api/search-bar/fetch-searchable-apps', {
    method: 'POST', body: { platform },
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (text.length < 200) return null; // empty payload means the session is stale
  try {
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : (data?.data || data?.apps || Object.values(data || {})[0]);
    return Array.isArray(arr) && arr.length ? arr : null;
  } catch { return null; }
}

export { SESSION_FILE };
