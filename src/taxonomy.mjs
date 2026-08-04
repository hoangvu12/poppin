import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, CACHE_TTL_MS, EXPERIENCE_BY_PLATFORM, FILTERS } from './config.mjs';
import { postJson, upstreamError } from './upstream.mjs';

const TAXONOMY_PATH = '/api/filter-tags/fetch-filter-tag-catalogs';
const CACHE_FILE = path.join(CACHE_DIR, 'filter-tags.json');

/**
 * Mobbin's whole filter vocabulary: every screen pattern, UI element, flow
 * action, app category and region, each with a definition and the synonyms its
 * own search bar accepts. Filters are matched by display name, so this is not
 * documentation — it is the set of values the upstream will actually honour.
 */
export async function fetchTaxonomy({ refresh = false } = {}) {
  if (!refresh) {
    const cached = readCache();
    if (cached) return cached;
  }
  const value = await postJson(TAXONOMY_PATH);
  if (!value || typeof value !== 'object') throw upstreamError('UPSTREAM_INVALID', 'the upstream returned an unreadable taxonomy');
  writeCache(value);
  return value;
}

function readCache() {
  try {
    const stat = fs.statSync(CACHE_FILE);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(value) {
  // A cache that cannot be written is not worth failing a search over: the
  // taxonomy is already in hand by the time we get here.
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const temp = `${CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value));
    fs.renameSync(temp, CACHE_FILE);
  } catch { /* ignore */ }
}

/** Every tag in one dictionary, flattened out of Mobbin's sub-category groups. */
export function tagsFor(taxonomy, platform, catalogName) {
  const experience = EXPERIENCE_BY_PLATFORM[platform];
  const groups = taxonomy?.[experience]?.[catalogName] || [];
  return groups.flatMap(group => (group.tags || []).map(tag => ({
    displayName: String(tag.displayName),
    subCategory: group.displayName || tag.subCategory || null,
    definition: tag.definition || null,
    synonyms: Array.isArray(tag.synonyms) ? tag.synonyms.map(String) : [],
  })));
}

const normalise = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Turn whatever a caller typed into a display name the upstream recognises.
 *
 * This exists because an unknown filter value is not rejected upstream: it
 * comes back as an ordinary empty result set, indistinguishable from a real
 * one. An agent guessing "paywall" would conclude Mobbin has no paywall
 * screens rather than that it should have asked for "Subscription & Paywall".
 * Failing loudly with the near misses is the whole point.
 */
export function resolveTagName(tags, input, { option }) {
  const wanted = normalise(input);
  if (!wanted) throw new Error(`--${option} needs a value`);

  const exact = tags.find(tag => normalise(tag.displayName) === wanted);
  if (exact) return exact.displayName;

  const bySynonym = tags.find(tag => tag.synonyms.some(synonym => normalise(synonym) === wanted));
  if (bySynonym) return bySynonym.displayName;

  const partial = tags.filter(tag => normalise(tag.displayName).includes(wanted)
    || tag.synonyms.some(synonym => normalise(synonym).includes(wanted)));
  if (partial.length === 1) return partial[0].displayName;
  if (partial.length > 1) {
    throw tagError('AMBIGUOUS_TAG',
      `--${option} "${input}" is ambiguous. Did you mean: ${partial.slice(0, 8).map(tag => `"${tag.displayName}"`).join(', ')}?`);
  }

  const near = suggest(tags, wanted);
  const hint = near.length ? ` Closest: ${near.map(name => `"${name}"`).join(', ')}.` : '';
  throw tagError('UNKNOWN_TAG',
    `--${option} "${input}" is not a known value for this platform.${hint} Run \`poppin tags ${option}s\` for the full list.`);
}

/**
 * Callers distinguish these: a bare query that names nothing in the vocabulary
 * can fall back to free-text search, but an ambiguous one has matched several
 * real terms and only the caller can say which they meant.
 */
function tagError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Rank candidates by shared words, so a wrong guess still points somewhere useful. */
function suggest(tags, wanted) {
  const words = new Set(wanted.split(' ').filter(Boolean));
  return tags
    .map(tag => {
      const haystack = normalise([tag.displayName, ...tag.synonyms].join(' ')).split(' ');
      const overlap = haystack.filter(word => words.has(word)).length;
      const prefix = haystack.some(word => [...words].some(part => word.startsWith(part) || part.startsWith(word))) ? 0.5 : 0;
      return { name: tag.displayName, score: overlap + prefix };
    })
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.name.length - right.name.length)
    .slice(0, 5)
    .map(entry => entry.name);
}

/** Which `--pattern`/`--element`/`--action`/`--category` options a content type accepts. */
export function optionsFor(contentType) {
  return Object.entries(FILTERS)
    .filter(([, spec]) => spec.contentTypes.includes(contentType))
    .map(([option]) => option);
}
