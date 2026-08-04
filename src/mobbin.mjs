import { randomUUID } from 'node:crypto';
import { FILTERS, MAX_PAGES, PAGINATED_CONTENT_TYPES, SITE_FILTERS } from './config.mjs';
import { getJson, postJson, postMultipart } from './upstream.mjs';

const SEARCH_PATH = {
  screens: '/api/search/fetch-search-page-screens',
  'ui-elements': '/api/search/fetch-search-page-ui-elements',
  flows: '/api/search/fetch-search-page-flows',
  apps: '/api/search/fetch-search-page-apps',
  sites: '/api/search/fetch-search-page-sites',
  sections: '/api/search/fetch-search-page-sections',
};

const APP_SCREENS_PATH = '/api/app/fetch-app-versions-screens';
const VISUAL_SEARCH_PATH = '/api/visual-search-image/create';

/** The upstream refuses anything larger, so fail before spending the upload. */
export const MAX_VISUAL_SEARCH_BYTES = 5 * 1024 * 1024;

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

/**
 * Marketing sites and the sections cut out of them.
 *
 * A different experience with a different vocabulary, but the same strict shape
 * rule: `sections` declares `pageAndSectionPatterns` and `textInScreenshotQuery`
 * and both must be present. Leaving `textInScreenshotQuery` out is what makes
 * the upstream drop the request and answer with an empty body.
 */
export function buildSiteSearchQuery({ contentType, filters = {}, text = null, sort = 'publishedAt' }) {
  const query = {
    type: 'filters',
    contentType,
    categories: null,
    styles: null,
    sortBy: sort,
  };
  if (contentType === 'sections') {
    Object.assign(query, { pageAndSectionPatterns: null, textInScreenshotQuery: text });
  }

  for (const [option, values] of Object.entries(filters)) {
    if (!values?.length) continue;
    const spec = SITE_FILTERS[option];
    if (spec && spec.contentTypes.includes(contentType)) query[spec.field] = values;
  }
  return query;
}

/**
 * Search by screenshot. The uploaded image is referenced by id rather than
 * resent, and the query carries none of the ordinary filter fields — this mode
 * declares its own shape, and `screens` is the only content type that accepts
 * it.
 */
export function buildVisualSearchQuery({ platform, imageId }) {
  return {
    type: 'visual_search',
    contentType: 'screens',
    image: { id: imageId },
    platform,
    sortBy: 'similarity',
  };
}

/** Upload a screenshot and get back the id a visual search refers to. */
export async function uploadVisualSearchImage(bytes, { filename = 'image.png', type = 'image/png' } = {}) {
  const form = new FormData();
  form.append('image', new Blob([bytes], { type }), filename);
  const value = await postMultipart(VISUAL_SEARCH_PATH, form);
  const id = value?.id ? String(value.id) : null;
  // A rejected image answers 200 with a null body rather than an error status.
  if (!id) throw new Error('the upstream could not read that image; try a full screenshot in PNG, JPEG or WebP');
  return id;
}

const SEARCH_BAR_PATH = '/api/search-bar/search';

/**
 * Mobbin's own query resolution, the index behind its search bar.
 *
 * poppin resolves a query locally against the vocabulary first, which is
 * instant and works from cache. This is the second opinion for queries that
 * match nothing there: it is the same Typesense index the site itself consults,
 * so it recognises phrasing the local synonym lists do not.
 *
 * It answers with references rather than names — `{id, type}` for an app, a
 * filter tag, or a site — which the caller resolves against the dictionaries it
 * already holds.
 */
export async function resolveViaSearchBar(query, { experience = 'apps', platform = 'ios' } = {}) {
  const value = await postJson(SEARCH_BAR_PATH, { query, experience, platform });
  const groups = [value?.primary, value?.other, value?.secondaryPlatform, value?.sites];
  const refs = groups.flatMap(group => (Array.isArray(group) ? group : []));
  return {
    apps: refs.filter(ref => ref?.type === 'app').map(ref => String(ref.id)),
    filterTags: refs.filter(ref => ref?.type === 'filter-tag').map(ref => String(ref.id)),
    sites: refs.filter(ref => ref?.type === 'site').map(ref => String(ref.id)),
  };
}

/** Content types whose free-text mode returns anything; `apps` answers zero. */
export const FREE_TEXT_CONTENT_TYPES = ['screens', 'ui-elements'];

const NORMALISE = {
  flows: normaliseFlow,
  apps: normaliseApp,
  sites: normaliseSite,
  sections: normaliseSection,
};

/**
 * Results for one query, reading as many pages as the upstream will serve.
 *
 * Paging is a paid feature for the content libraries: the upstream answers page
 * 1 with `totalCount: 0` rather than an error, which is indistinguishable from
 * a genuinely exhausted result set. Only the content types known to page are
 * looped, so the rest stop after the page they are allowed and report
 * `hasMore`, letting the caller say how much it could not reach.
 *
 * The cursor is just the request id echoed back with the next index — there is
 * no opaque token, and the id is client-generated.
 */
export async function searchContent(searchQuery, { limit = Infinity } = {}) {
  const path = SEARCH_PATH[searchQuery.contentType];
  const normalise = NORMALISE[searchQuery.contentType] || normaliseScreen;
  const paginates = PAGINATED_CONTENT_TYPES.has(searchQuery.contentType);

  const results = [];
  let searchRequestId = randomUUID();
  let totalCount = 0;
  let hasMore = false;

  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
    const value = await postJson(path, { searchRequestId, pageIndex, searchQuery });
    const rows = Array.isArray(value?.data) ? value.data : [];
    if (pageIndex === 0) {
      totalCount = Number.isFinite(value?.totalCount) ? value.totalCount : rows.length;
    }
    results.push(...rows.map(normalise));
    hasMore = Boolean(value?.hasNextPage);

    if (!paginates || !hasMore || !rows.length || results.length >= limit) break;
    // The upstream echoes the id we sent; prefer its copy in case that changes.
    searchRequestId = value?.searchRequestId || searchRequestId;
  }

  return {
    totalCount: totalCount || results.length,
    hasMore: hasMore && results.length < totalCount,
    results,
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

/** A marketing site: one record per company, not per page. */
function normaliseSite(row) {
  return {
    id: String(row.id),
    name: row.name || null,
    tagline: row.tagline || null,
    url: row.url || null,
    versionId: row.latest_site_version ? String(row.latest_site_version) : null,
    restricted: Boolean(row.is_restricted),
    logo: row.logoCdnImgSources?.src || null,
  };
}

/**
 * One section cut out of a marketing page — a hero, a pricing table, a footer.
 * Sections carry the page they came from rather than an app, and some are
 * recorded as video rather than a still.
 */
function normaliseSection(row) {
  return {
    id: String(row.id),
    pageId: row.site_page_id ? String(row.site_page_id) : null,
    pageUrl: row.page_url || null,
    patterns: Array.isArray(row.patterns) ? row.patterns : [],
    type: row.type || null,
    versionId: row.site_version ? String(row.site_version) : null,
    restricted: Boolean(row.restricted),
    video: row.page_video_url || row.cdnVideoSources?.source?.url || null,
    url: row.page_image_url || row.pageCdnImgSources?.src || null,
    path: null,
  };
}

const SCREEN_INFO_PATH = '/api/screen/fetch-screen-info';

/**
 * One screen by its full id, whatever it came from.
 *
 * The catalog only carries a few preview screens per app, so an id from a
 * search result is not in it. This resolves any of them, and is also the only
 * place the full-page capture and the animation recording are exposed.
 *
 * Returns null rather than throwing for an id the upstream does not know: the
 * caller has usually already tried a cheaper lookup and wants to fall through.
 */
export async function fetchScreenInfo(screenId) {
  let value;
  try {
    value = await postJson(SCREEN_INFO_PATH, { screenId });
  } catch {
    return null;
  }
  if (!value?.id) return null;
  const app = value.appVersion?.app || {};
  return {
    id: String(value.id),
    appId: app.id ? String(app.id) : null,
    appName: app.appName || null,
    platform: app.platform || null,
    publishedAt: value.appVersion?.publishedAt || null,
    screenNumber: value.screenNumber ?? null,
    url: value.screenUrl || value.screenCdnImgSources?.src || null,
    fullpage: value.fullpageScreenCdnImgSources?.src || null,
    animation: value.animationCdnVideoSources?.source?.url || null,
    path: null,
  };
}

const FLOW_INFO_PATH = '/api/flow/fetch-flow-info';

/**
 * One flow by its full id, with every frame.
 *
 * Worth preferring over a `flows` search even when both could answer, because
 * the frames here carry the storage URL. Search results only carry the
 * `enc=`-signed CDN source, which expires; these do not.
 *
 * The payload is shaped for the flow detail page rather than for a list: tags
 * arrive as nested dictionary entries grouped by category slug, and the frames
 * come back already ordered, with no explicit order field to sort on.
 */
export async function fetchFlowInfo(flowId) {
  let value;
  try {
    value = await postJson(FLOW_INFO_PATH, { flowId });
  } catch {
    return null;
  }
  if (!value?.id) return null;

  const app = value.appVersion?.app || {};
  const frames = (value.appSectionScreens || []).map((entry, index) => {
    const screen = entry?.appScreen || {};
    return {
      order: index + 1,
      // The same screen can legitimately appear twice in one flow, so a frame
      // is addressed by its position rather than by the screen it shows.
      id: `flow-${value.id}-${String(index + 1).padStart(3, '0')}`,
      screenId: screen.id ? String(screen.id) : null,
      elements: dictionaryTags(screen.content_dictionary_tags, 'screenElements'),
      url: screen.screenUrl || null,
      path: null,
    };
  });

  return {
    id: String(value.id),
    name: value.name || null,
    actions: dictionaryTags(value.content_dictionary_tags, 'flowActions'),
    appName: app.appName || null,
    platform: app.platform || null,
    screenCount: frames.length,
    screens: frames,
  };
}

/**
 * Flatten Mobbin's nested tag records down to display names, keeping only the
 * dictionary asked for. The shape is `{dictionary_entries: {displayName,
 * dictionary_sub_categories: {dictionary_categories: {slug}}}}`.
 */
function dictionaryTags(tags, slug) {
  return (tags || [])
    .map(tag => tag?.dictionary_entries)
    .filter(entry => entry?.dictionary_sub_categories?.dictionary_categories?.slug === slug)
    .map(entry => entry.displayName)
    .filter(Boolean);
}

const TRENDING_PATH = '/api/search-bar/fetch-trending-content';
const POPULAR_APPS_PATH = '/api/popular-apps/fetch-popular-apps-with-preview-screens';
const TOTAL_SCREENS_PATH = '/api/content/fetch-total-screens-count';

/**
 * What Mobbin is currently surfacing, per platform and for sites: the apps
 * being viewed most, the filter tags it is promoting, and the on-screen copy
 * people are searching for. This is editorial rather than a query, which makes
 * it the one honest answer to "what is popular right now".
 */
export async function fetchTrending() {
  const value = await postJson(TRENDING_PATH, {});
  const perPlatform = (key) => {
    const group = value?.[key] || {};
    return {
      apps: (group.apps || []).map(app => ({
        id: String(app.id),
        appName: app.appName || null,
        platform: app.platform || key,
        metric: app.trending_metric ?? null,
      })),
      filterTags: trendingTags(group.filterTags),
      keywords: (group.textInScreenshotKeywords || []).map(String),
    };
  };
  const sites = value?.sites || {};
  return {
    ios: perPlatform('ios'),
    web: perPlatform('web'),
    sites: {
      sites: (sites.sites || []).map(site => ({
        id: String(site.id),
        name: site.name || null,
        metric: site.trending_metric ?? null,
      })),
      filterTags: trendingTags(sites.filterTags),
    },
  };
}

/** Which CLI option each dictionary feeds, so a trending tag is actionable. */
const OPTION_BY_CATALOG = new Map([
  ...Object.entries(FILTERS).map(([option, spec]) => [spec.catalog, option]),
  ...Object.entries(SITE_FILTERS).map(([option, spec]) => [spec.catalog, option]),
]);

/**
 * A promoted tag arrives wrapped in presentation — a card type, an image, an
 * order — with the tag itself nested under `filterTag`. What matters is its
 * display name and which dictionary it came from, because together those say
 * exactly which option it can be passed to.
 */
function trendingTags(rows) {
  return (rows || [])
    .slice()
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .map(row => {
      const tag = row?.filterTag || {};
      return {
        name: tag.displayName || null,
        option: OPTION_BY_CATALOG.get(tag.categorySlug) || null,
        group: tag.subCategory || null,
      };
    })
    .filter(tag => tag.name);
}

/**
 * The most popular apps in each category, with preview screens.
 *
 * Answers "who is worth looking at in this space" without a query, which no
 * search can: `find` ranks on words the caller supplies, and this ranks on
 * Mobbin's own popularity signal. The response is keyed by category name, and
 * the categories are lowercased there but title-cased everywhere else in the
 * vocabulary, so they are normalised into rows rather than left as an object.
 */
export async function fetchPopularApps({ platform = 'ios', perCategory = 10 } = {}) {
  const value = await postJson(POPULAR_APPS_PATH, { platform, limitPerCategory: perCategory });
  return Object.entries(value || {}).map(([category, apps]) => ({
    category,
    platform,
    apps: (apps || []).map(app => ({
      id: String(app.app_id),
      appName: app.app_name || null,
      logo: app.app_logo_url || null,
      previews: (app.preview_screens || [])
        .map(screen => ({ id: String(screen.id), url: screen.screenUrl || null, path: null }))
        .filter(screen => screen.url),
    })),
  }));
}

/** How many screens Mobbin actually holds, across every app and platform. */
export async function fetchTotalScreens() {
  const value = await postJson(TOTAL_SCREENS_PATH, {});
  return Number.isFinite(value) ? value : null;
}

const COLLECTIONS_PATH = '/api/collection/fetch-collections';
const SAVED_PATH = '/api/saved/fetch-saved-contents';
const RECENT_SEARCHES_PATH = '/api/recent-searches';

/**
 * The upstream account's own collections and saved items.
 *
 * poppin only ever reads these. Every caller shares one upstream session, so a
 * write would be a write to everybody's account at once — and the endpoints
 * that would do it are deliberately not wired. What these return is whatever
 * the account holder curated in Mobbin's own UI, which is the point: it lets a
 * human pick screens in the browser and an agent pull exactly those.
 */
export async function fetchCollections() {
  const value = await postJson(COLLECTIONS_PATH, {});
  return (Array.isArray(value) ? value : []).map(row => ({
    id: String(row.id ?? ''),
    name: row.name ?? row.collectionName ?? null,
    contentCount: row.contentCount ?? row.content_count ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null,
  }));
}

/**
 * Saved rows of one content type. `contentIds` is required and narrows the
 * answer to that set — the endpoint reports which of the ids given are saved
 * rather than listing everything saved, so an empty list is a rejected request
 * rather than an empty answer.
 */
export async function fetchSavedContents(contentType, contentIds) {
  if (!contentIds?.length) return [];
  const value = await postJson(SAVED_PATH, { contentType, contentIds });
  return Array.isArray(value) ? value : [];
}

/**
 * The account's recent searches, as recorded by Mobbin's own UI. poppin never
 * writes here: `upsert-recent-search` is left unwired, so this reflects
 * browsing rather than anything the CLI did.
 */
export async function fetchRecentSearches() {
  const value = await getJson(RECENT_SEARCHES_PATH);
  const entries = (list, platform) => (list || []).map(row => ({
    id: String(row.id ?? ''),
    platform: row.platform || platform,
    experience: row.experience || null,
    query: row.textQuery || row.app?.appName || row.site?.name || null,
    method: row.textQueryMethod || (row.app ? 'App' : row.site ? 'Site' : null),
  })).filter(row => row.query);

  return {
    ios: entries(value?.apps?.ios, 'ios'),
    web: entries(value?.apps?.web, 'web'),
    sites: entries(value?.sites, 'sites'),
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
