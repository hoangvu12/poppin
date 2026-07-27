import fs from 'node:fs';

const SUPABASE_REF = 'ujasntkfphywizsdaapi';
// Everything we actually need to carry a session. The auth-token may be chunked
// (.0/.1). g_state is harmless to include; anything else is analytics noise.
const KEEP = (name) => name.startsWith('sb-') || name === 'g_state';

/**
 * Accepts whatever is easiest for the user to paste and pulls out the cookies
 * that matter. Handles three shapes:
 *   1. `document.cookie` output:  "name=val; name2=val2"
 *   2. one `name=value` per line (DevTools "copy" / our console snippet)
 *   3. a JSON array of {name,value,domain,...} (Cookie-Editor export)
 */
export function parseCookies(raw) {
  const text = raw.trim();
  if (!text) return [];

  // JSON export?
  if (text.startsWith('[') || text.startsWith('{')) {
    const arr = JSON.parse(text);
    const list = Array.isArray(arr) ? arr : [arr];
    return list
      .filter(c => c && c.name && KEEP(c.name))
      .map(c => cookie(c.name, c.value, c.domain, c.path, c.expires));
  }

  // Otherwise treat as cookie string(s): split on ';' AND newlines.
  const pairs = text.split(/[\n;]+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const name = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (KEEP(name)) out.push(cookie(name, value));
  }
  return out;
}

function cookie(name, value, domain, path, expires) {
  // The Supabase auth cookie is host-only on mobbin.com (not .mobbin.com).
  const host = (domain || 'mobbin.com').replace(/^\./, '');
  // Keep the value verbatim: document.cookie / the Cookie header already carry
  // the URL-encoded form, which is exactly what Playwright re-sends.
  return {
    name,
    value: value ?? '',
    domain: host,
    path: path || '/',
    httpOnly: false,
    secure: true,
    sameSite: 'Lax',
    ...(expires && expires > 0 ? { expires: Math.floor(expires) } : {}),
  };
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(''); // interactive, nothing piped
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/**
 * Resolve the cookie text from whatever the caller provided, most explicit
 * first. Env var and stdin let an agent authenticate without writing a
 * credential into a command-line argument (which leaks into process listings
 * and shell history).
 */
export async function readSource({ cookies, cookieFile } = {}) {
  if (cookieFile) return fs.readFileSync(cookieFile, 'utf8');
  if (cookies) return cookies;
  if (process.env.POPPIN_COOKIES) return process.env.POPPIN_COOKIES;
  const piped = await readStdin();
  if (piped.trim()) return piped;
  throw new Error('no cookies given — paste to stdin, set POPPIN_COOKIES, or use --cookies / --cookie-file');
}

export function summarize(list) {
  const auth = list.filter(c => c.name.startsWith(`sb-${SUPABASE_REF}-auth-token`));
  return {
    total: list.length,
    names: list.map(c => c.name),
    hasAuth: auth.length > 0,
    authChunks: auth.length,
  };
}

export { SUPABASE_REF };
