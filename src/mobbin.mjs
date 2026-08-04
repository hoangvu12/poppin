import { randomUUID } from 'node:crypto';
import { FILTERS } from './config.mjs';
import { postJson } from './upstream.mjs';

const SEARCH_PATH = {
  screens: '/api/search/fetch-search-page-screens',
  'ui-elements': '/api/search/fetch-search-page-ui-elements',
  flows: '/api/search/fetch-search-page-flows',
  apps: '/api/search/fetch-search-page-apps',
};

const APP_SCREENS_PATH = '/api/app/fetch-app-versions-screens';

/**
 * The upstream validates this payload strictly and by shape, not by content:
 * every field its schema declares for a content type has to be present, even
 * when unset. Omitting one is not a narrower query, it is a rejected request,
 * so the nulls below are load-bearing.
 */
export function buildSearchQuery({ contentType, platform, filters = {}, text = null, animated = null, sort = 'popularity' }) {
  const query = {
    type: 'filters',
    activeFilterTags: [],
    contentType,
    platform,
    categories: null,
    sortBy: sort,
  };
  if (contentType === 'screens' || contentType === 'ui-elements') {
    Object.assign(query, {
      screenElements: null,
      screenPatterns: null,
      textInScreenshotQuery: text,
      hasAnimation: animated,
    });
  }
  if (contentType === 'flows') query.flowActions = null;

  for (const [option, values] of Object.entries(filters)) {
    if (!values?.length) continue;
    const spec = FILTERS[option];
    if (spec && spec.contentTypes.includes(contentType)) query[spec.field] = values;
  }
  return query;
}

/**
 * Mobbin's free-text search, for queries that name nothing in the vocabulary.
 *
 * It is a different mode rather than an extra filter: the upstream ignores
 * every tag filter here, and only the text and animation axes still apply.
 * `mode` is required — omitting it, or asking for the AI-ranked `deep` mode
 * this session is not entitled to, gets the request dropped.
 */
export function buildFreeTextQuery({ contentType, platform, query, text = null, animated = null, sort = 'popularity' }) {
  const searchQuery = {
    type: 'free_text_search',
    query,
    contentType,
    platform,
    categories: null,
    sortBy: sort,
    mode: 'standard',
  };
  if (contentType === 'screens' || contentType === 'ui-elements') {
    Object.assign(searchQuery, {
      screenElements: null,
      screenPatterns: null,
      textInScreenshotQuery: text,
      hasAnimation: animated,
    });
  }
  return searchQuery;
}

/** Content types whose free-text mode returns anything; `apps` answers zero. */
export const FREE_TEXT_CONTENT_TYPES = ['screens', 'ui-elements'];

/**
 * One page of results. The upstream serves up to 100 rows and reports a
 * `hasNextPage`, but requesting page 1 through this proxy comes back empty, so
 * `totalCount` is reported honestly while only the first page is returned.
 */
export async function searchContent(searchQuery) {
  const value = await postJson(SEARCH_PATH[searchQuery.contentType], {
    searchRequestId: randomUUID(),
    pageIndex: 0,
    searchQuery,
  });
  const rows = Array.isArray(value?.data) ? value.data : [];
  const normalise = searchQuery.contentType === 'flows' ? normaliseFlow
    : searchQuery.contentType === 'apps' ? normaliseApp
      : normaliseScreen;
  return {
    totalCount: Number.isFinite(value?.totalCount) ? value.totalCount : rows.length,
    hasMore: Boolean(value?.hasNextPage),
    results: rows.map(normalise),
  };
}

/**
 * Prefer the storage URL: it maps onto the CDN deterministically, at whatever
 * width we ask for. The `enc=`-signed CDN sources expire, so they are only a
 * fallback for rows that carry no storage URL, such as flow frames.
 */
function imageUrl(row) {
  return row.screenUrl || row.screenCdnImgSources?.src || null;
}

/**
 * `ui-elements` returns whole screens that contain the element rather than a
 * crop of it, so both content types normalise identically.
 */
function normaliseScreen(row) {
  return {
    id: String(row.id),
    appId: row.appId ? String(row.appId) : null,
    appName: row.appName || null,
    platform: row.platform || null,
    patterns: Array.isArray(row.screenPatterns) ? row.screenPatterns : [],
    elements: Array.isArray(row.screenElements) ? row.screenElements : [],
    animated: Boolean(row.animation_id),
    width: row.width ?? null,
    height: row.height ?? null,
    publishedAt: row.appVersionPublishedAt || null,
    restricted: Boolean(row.restricted),
    url: imageUrl(row),
    path: null,
  };
}

/** A flow is an ordered run of screens, with the tap that led to each one. */
function normaliseFlow(row) {
  const frames = (row.screens || [])
    .slice()
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .map(frame => ({
      order: frame.order ?? 0,
      // Frames are addressed by their position in the flow: the same screen can
      // legitimately appear twice, so the screen id alone is not a file name.
      id: `flow-${row.id}-${String(frame.order ?? 0).padStart(3, '0')}`,
      screenId: frame.screenId ? String(frame.screenId) : null,
      hotspot: frame.hotspotX === null || frame.hotspotX === undefined ? null : {
        x: frame.hotspotX, y: frame.hotspotY, width: frame.hotspotWidth, height: frame.hotspotHeight,
      },
      url: frame.screenCdnImgSources?.src || null,
      path: null,
    }));
  return {
    id: String(row.id),
    name: row.name || null,
    actions: Array.isArray(row.actions) ? row.actions : [],
    appId: row.appId ? String(row.appId) : null,
    appName: row.appName || null,
    platform: row.platform || null,
    publishedAt: row.appVersionPublishedAt || null,
    restricted: Boolean(row.restricted),
    video: row.videoCdnVideoSources?.source?.url || null,
    screenCount: frames.length,
    screens: frames,
  };
}

function normaliseApp(row) {
  return {
    id: String(row.id),
    appName: row.appName || null,
    tagline: row.appTagline || null,
    platform: row.platform || null,
    categories: Array.isArray(row.allAppCategories) ? row.allAppCategories : [row.appCategory].filter(Boolean),
    keywords: Array.isArray(row.keywords) ? row.keywords : [],
    publishedAt: row.appVersionLatestPublishedAt || row.appVersionPublishedAt || null,
    restricted: Boolean(row.isRestricted),
    previews: (row.previewScreens || [])
      .map(screen => ({ id: String(screen.id), url: imageUrl(screen), path: null }))
      .filter(screen => screen.url),
  };
}

/**
 * Every screen Mobbin holds for one app, grouped by the version it shipped in.
 * This is the app's real library — hundreds to thousands of screens — rather
 * than the four previews the search-bar catalog carries.
 */
export async function fetchAppLibrary(appId) {
  const value = await postJson(APP_SCREENS_PATH, { appId });
  const versions = (value?.appVersions || [])
    .map(version => ({
      id: String(version.id),
      publishedAt: version.publishedAt || version.createdAt || null,
      screens: (version.appScreens || []).map(screen => ({
        id: String(screen.id),
        url: screen.screenUrl || null,
        path: null,
      })),
    }))
    .sort((left, right) => String(right.publishedAt || '').localeCompare(String(left.publishedAt || '')));
  return {
    id: String(value?.id || appId),
    appName: value?.appName || null,
    platform: value?.platform || null,
    versions,
  };
}
