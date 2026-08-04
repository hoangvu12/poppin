import os from 'node:os';
import path from 'node:path';

/**
 * poppin talks to nibbom, a hosted proxy that already carries a Mobbin session
 * and answers Mobbin's data endpoints unauthenticated. Nothing in this client
 * stores, refreshes, or transmits a credential.
 */
export const BASE = process.env.POPPIN_BASE || 'https://nibbom.nguyenvu.dev';

export const USER_AGENT = 'poppin/0.4 (+https://github.com/hoangvu12/poppin)';

export const PLATFORMS = ['ios', 'web'];

/**
 * Mobbin keys its filter vocabulary by "experience" rather than by platform,
 * and every mobile platform shares one dictionary. Translating here keeps
 * `--platform` the only platform word a caller ever has to know.
 *
 * Marketing sites are their own experience with no platform axis at all, so
 * they get a pseudo-platform that maps onto it.
 */
export const EXPERIENCE_BY_PLATFORM = { ios: 'mobile', web: 'web', sites: 'sites' };

/** What a search returns: whole screens, ordered flows, cropped elements, apps. */
export const CONTENT_TYPES = ['screens', 'flows', 'ui-elements', 'apps'];

/**
 * Mobbin's other library: marketing sites, and the individual page sections
 * (heroes, pricing tables, footers) cut out of them. Separate from the app
 * experience in vocabulary, filters and platform, so it is kept separate here.
 */
export const SITE_CONTENT_TYPES = ['sites', 'sections'];

/**
 * Which content types can actually be paged.
 *
 * Paging is a paid feature: the search page only renders its load-more trigger
 * for a membershipPlan other than "none", and the upstream enforces the same
 * rule independently by answering page 1 with `totalCount: 0`. The two
 * directory listings are exempt, so those alone are read to completion.
 */
export const PAGINATED_CONTENT_TYPES = new Set(['apps', 'sites']);

/** How many pages to read before giving up, so a loop cannot run away. */
export const MAX_PAGES = 60;

/**
 * The orderings the search endpoints accept. `sortBy` is required and strictly
 * validated: an unknown value makes the upstream abandon the request and reply
 * with an empty body rather than an error, so this list is not advisory.
 */
export const SORTS = ['publishedAt', 'popularity', 'trending'];

/**
 * Which filter dictionary backs each option, by content type. `screens` and
 * `ui-elements` share a dictionary; only the endpoint and the cropping differ.
 */
export const FILTERS = {
  pattern: { plural: 'patterns', field: 'screenPatterns', catalog: 'screenPatterns', contentTypes: ['screens', 'ui-elements'] },
  element: { plural: 'elements', field: 'screenElements', catalog: 'screenElements', contentTypes: ['screens', 'ui-elements'] },
  action: { plural: 'actions', field: 'flowActions', catalog: 'flowActions', contentTypes: ['flows'] },
  category: { plural: 'categories', field: 'categories', catalog: 'appCategories', contentTypes: ['screens', 'ui-elements', 'flows', 'apps'] },
};

/**
 * The sites experience has its own dictionaries, and they collide by name with
 * the app ones: a sites "category" is drawn from `categories`, not
 * `appCategories`. Keeping them in a separate map means neither has to carry a
 * condition about which experience is in play.
 */
export const SITE_FILTERS = {
  category: { plural: 'categories', field: 'categories', catalog: 'categories', contentTypes: ['sites', 'sections'] },
  style: { plural: 'styles', field: 'styles', catalog: 'styles', contentTypes: ['sites', 'sections'] },
  pattern: { plural: 'patterns', field: 'pageAndSectionPatterns', catalog: 'pageAndSectionPatterns', contentTypes: ['sections'] },
};

/** `poppin tags <kind>` accepts either the option name or its plural. */
export const FILTER_BY_KIND = new Map(Object.entries(FILTERS)
  .flatMap(([option, spec]) => [[option, option], [spec.plural, option]]));

export const SITE_FILTER_BY_KIND = new Map(Object.entries(SITE_FILTERS)
  .flatMap(([option, spec]) => [[option, option], [spec.plural, option]]));

/**
 * The taxonomy is ~490 KB and changes on Mobbin's editorial schedule, not per
 * query, so it is the one thing worth keeping on disk. Results are never
 * cached: those must stay live.
 */
export const CACHE_DIR = process.env.POPPIN_CACHE_DIR
  ? path.resolve(process.env.POPPIN_CACHE_DIR)
  : path.join(os.tmpdir(), 'poppin-cache');

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
