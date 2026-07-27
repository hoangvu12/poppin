/**
 * FTS5 query building. No embedding model involved — the quality comes from
 * asking the index better questions instead of a single flat OR.
 */

// Words that add no signal in a design library: nearly every screen is a
// "screen" belonging to an "app", so matching on them just adds noise.
const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'with', 'and', 'or', 'in', 'on', 'to',
  'screen', 'screens', 'ui', 'app', 'apps', 'design', 'page', 'show', 'me', 'find', 'like']);

export function terms(query) {
  return String(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOP.has(t));
}

const quote = (t) => `"${t.replace(/"/g, '')}"`;

/**
 * Build progressively looser FTS5 queries. The caller tries them in order and
 * stops at the first that returns enough rows, so exact multi-term matches
 * outrank incidental single-term ones.
 */
export function queryLadder(query) {
  const t = terms(query);
  if (!t.length) return [];
  const ladder = [];
  if (t.length > 1) {
    ladder.push(t.map(quote).join(' AND '));            // all terms
    ladder.push(t.map(x => `${quote(x)}*`).join(' AND ')); // all terms, prefix
  }
  ladder.push(t.map(x => `${quote(x)}*`).join(' OR '));  // any term, prefix
  return [...new Set(ladder)];
}

// bm25 weights, column order: id, name/title, app_name, description, tags.
// A hit in the screen name matters far more than one buried in a description.
export const SCREEN_WEIGHTS = '0.0, 12.0, 4.0, 2.0, 6.0';
export const FLOW_WEIGHTS = '0.0, 12.0, 4.0, 3.0, 6.0';

/** Run each rung of the ladder until one yields results. */
export function laddered(db, buildSql, query, args = []) {
  for (const m of queryLadder(query)) {
    const rows = db.prepare(buildSql).all(m, ...args);
    if (rows.length) return { rows, match: m };
  }
  return { rows: [], match: null };
}
