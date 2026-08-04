import { PLATFORMS } from './config.mjs';
import { postJson, upstreamError } from './upstream.mjs';

const CATALOG_PATH = '/api/search-bar/fetch-searchable-apps';

/**
 * The app index behind Mobbin's search bar: one record per app with its
 * curated keywords and roughly four preview screens. It is what `find` ranks
 * locally, and it is the only place an app's id can be looked up by name,
 * which is what the library and screen commands need. Fetched per command so
 * the client owns no storage and nothing can go stale.
 */
export async function fetchCatalog(platform = 'ios') {
  if (!PLATFORMS.includes(platform)) throw new Error(`platform must be one of ${PLATFORMS.join(', ')}`);

  const payload = await postJson(CATALOG_PATH, { platform });
  const records = Array.isArray(payload) ? payload : payload?.data || payload?.apps;
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

const SITE_CATALOG_PATH = '/api/search-bar/fetch-searchable-sites';

/**
 * The sites index behind the search bar: every marketing site with its curated
 * keywords. The sites *search* endpoint filters by category and style only, so
 * this is the only way to reach a site by what it is about — the same role the
 * app catalog plays for `find`.
 *
 * Shaped like an app record on purpose, so one ranker serves both.
 */
export async function fetchSiteCatalog() {
  const payload = await postJson(SITE_CATALOG_PATH, {});
  const records = Array.isArray(payload) ? payload : payload?.data || payload?.sites;
  if (!Array.isArray(records) || !records.length) {
    throw upstreamError('UPSTREAM_INVALID', 'the upstream returned an empty site catalog');
  }
  return records
    .filter(record => record?.id && record?.name)
    .map(record => ({
      id: String(record.id),
      platform: 'sites',
      appName: String(record.name),
      tagline: record.tagline ? String(record.tagline) : null,
      keywords: Array.isArray(record.keywords) ? record.keywords.map(String) : [],
      logoUrl: pickLogo(record.logoCdnImgSources),
      // Sites carry no preview screens in this index; `poppin sites` has the
      // page images.
      previews: [],
    }));
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
