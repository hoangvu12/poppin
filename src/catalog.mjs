import { BASE, PLATFORMS, USER_AGENT } from './config.mjs';

const CATALOG_PATH = '/api/search-bar/fetch-searchable-apps';
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The catalog is the whole data surface: one record per app, carrying Mobbin's
 * curated keywords and roughly four preview screens. It is fetched per command
 * rather than mirrored locally, so results are never stale and the client owns
 * no storage.
 */
export async function fetchCatalog(platform = 'ios') {
  if (!PLATFORMS.includes(platform)) throw new Error(`platform must be one of ${PLATFORMS.join(', ')}`);

  let response;
  try {
    response = await fetch(new URL(CATALOG_PATH, BASE), {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify({ platform }),
    });
  } catch (error) {
    if (['TimeoutError', 'AbortError'].includes(error.name)) throw error;
    throw upstreamError('UPSTREAM_UNAVAILABLE', `${BASE} could not be reached`);
  }

  if (response.status === 429) throw upstreamError('RATE_LIMITED', 'the upstream rate-limited the request');
  if (!response.ok) throw upstreamError('UPSTREAM_ERROR', `the upstream returned HTTP ${response.status}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw upstreamError('UPSTREAM_INVALID', 'the upstream returned an unreadable catalog');
  }

  const records = Array.isArray(payload)
    ? payload
    : payload?.value || payload?.data || payload?.apps;
  if (!Array.isArray(records) || !records.length) {
    throw upstreamError('UPSTREAM_INVALID', 'the upstream returned an empty catalog');
  }
  return records.map(record => normaliseApp(record, platform)).filter(Boolean);
}

/** Fetch several platforms concurrently and flatten them into one list. */
export async function fetchCatalogs(platforms = ['ios']) {
  const lists = await Promise.all(platforms.map(platform => fetchCatalog(platform)));
  return lists.flat();
}

export function normaliseApp(record, platform) {
  if (!record?.id || !record?.appName) return null;
  return {
    id: String(record.id),
    platform: PLATFORMS.includes(record.platform) ? record.platform : platform,
    appName: String(record.appName),
    tagline: record.appTagline ? String(record.appTagline) : null,
    keywords: Array.isArray(record.keywords) ? record.keywords.map(String) : [],
    logoUrl: pickLogo(record.appLogoCdnImgSources),
    previews: (record.previewScreens || [])
      .map(screen => ({ id: String(screen?.id || ''), url: String(screen?.screenUrl || '') }))
      .filter(screen => screen.id && screen.url),
  };
}

function pickLogo(sources) {
  if (!sources) return null;
  if (typeof sources === 'string') return sources;
  if (Array.isArray(sources)) return sources[0]?.url || sources[0] || null;
  return sources.src || sources.url || sources.png || sources.webp || null;
}

/** Flatten apps into screen rows, which is all a "screen" is in this catalog. */
export function toScreens(apps) {
  return apps.flatMap(app => app.previews.map(preview => ({
    id: preview.id,
    url: preview.url,
    appName: app.appName,
    platform: app.platform,
  })));
}

function upstreamError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
