/**
 * Ranking over the live catalog. There is no index to query, so the quality
 * comes from scoring each field the way the old FTS weights did: a hit in the
 * app name outranks one in a curated keyword, which outranks one in a tagline.
 */

// Words that add no signal in a design library: nearly every record is a
// "screen" belonging to an "app", so matching on them just adds noise.
const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'with', 'and', 'or', 'in', 'on', 'to',
  'screen', 'screens', 'ui', 'app', 'apps', 'design', 'page', 'show', 'me', 'find', 'like']);

const FIELD_WEIGHTS = { appName: 10, keywords: 6, tagline: 4 };

export function terms(query) {
  return [...new Set(String(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(term => term.length > 1 && !STOP.has(term)))];
}

/**
 * How well one term matches one piece of text, from a whole-field hit down to
 * an incidental substring. Prefix hits are kept because design vocabulary
 * inflects freely: "onboard" should still find "onboarding".
 */
function textScore(text, term) {
  if (!text) return 0;
  const value = String(text).toLowerCase();
  if (value === term) return 1;
  const words = value.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.includes(term)) return 0.85;
  if (words.some(word => word.startsWith(term))) return 0.6;
  if (value.includes(term)) return 0.3;
  return 0;
}

function termScore(app, term) {
  const keywords = app.keywords.reduce((best, keyword) => Math.max(best, textScore(keyword, term)), 0);
  return Math.max(
    FIELD_WEIGHTS.appName * textScore(app.appName, term),
    FIELD_WEIGHTS.keywords * keywords,
    FIELD_WEIGHTS.tagline * textScore(app.tagline, term),
  );
}

/**
 * Rank apps against a query. Records matching every term come first as a group,
 * so an incidental single-term hit can never outrank a full match, mirroring
 * the old query ladder.
 */
export function rankApps(apps, query, { limit = 12, platform = null } = {}) {
  const wanted = terms(query);
  const pool = platform ? apps.filter(app => app.platform === platform) : apps;
  if (!wanted.length) return pool.slice(0, limit);

  const exact = query.trim().toLowerCase();
  const scored = [];
  for (const app of pool) {
    let total = 0;
    let matched = 0;
    for (const term of wanted) {
      const score = termScore(app, term);
      if (score > 0) matched++;
      total += score;
    }
    if (!matched) continue;
    if (app.appName.toLowerCase() === exact) total += 25;
    scored.push({ app, total, complete: matched === wanted.length });
  }

  scored.sort((left, right) => Number(right.complete) - Number(left.complete)
    || right.total - left.total
    || left.app.appName.length - right.app.appName.length
    || left.app.appName.localeCompare(right.app.appName));

  return scored.slice(0, limit).map(entry => entry.app);
}

/** Substring match on the app name, for commands that name an app directly. */
export function matchAppName(apps, name, { platform = null } = {}) {
  const wanted = String(name).toLowerCase();
  return apps
    .filter(app => (!platform || app.platform === platform) && app.appName.toLowerCase().includes(wanted))
    .sort((left, right) => left.appName.length - right.appName.length
      || left.appName.localeCompare(right.appName));
}
