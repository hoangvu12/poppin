import { BASE, USER_AGENT } from './config.mjs';

const REQUEST_TIMEOUT_MS = 45_000;

/**
 * Every upstream call is a POST that answers `{ value }` on success and
 * `{ error }` on failure. Centralising it keeps one error vocabulary for the
 * CLI to translate, so no command has to invent its own failure wording.
 */
/**
 * Ask the proxy not to rewrite entitlement state.
 *
 * Without this every row claims `restricted: false`, because the proxy rewrites
 * that flag to unlock the browser UI. The rewrite changes flags, not access, so
 * a screen reported as available can still fail to download. Reporting what is
 * actually reachable is worth more here than a uniformly optimistic answer.
 */
const CLIENT_HEADERS = { 'user-agent': USER_AGENT, 'x-nibbom-raw': '1' };

export async function postJson(path, body = {}, { timeout = REQUEST_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetch(new URL(path, BASE), {
      method: 'POST',
      signal: AbortSignal.timeout(timeout),
      headers: { 'content-type': 'application/json', ...CLIENT_HEADERS },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (['TimeoutError', 'AbortError'].includes(error.name)) throw error;
    throw upstreamError('UPSTREAM_UNAVAILABLE', `${BASE} could not be reached`);
  }

  if (response.status === 429) throw upstreamError('RATE_LIMITED', 'the upstream rate-limited the request');
  if (!response.ok) throw upstreamError('UPSTREAM_ERROR', `the upstream returned HTTP ${response.status}`);

  return readEnvelope(await response.text());
}

/** Unwrap `{ value }` / `{ error }`, translating both into one vocabulary. */
function readEnvelope(text) {
  // A malformed query is not answered with a status code: the upstream drops
  // the request and closes with an empty 200. Treating that as a client-side
  // bug is the only reading that does not silently look like "no results".
  if (!text.trim()) throw upstreamError('UPSTREAM_REJECTED', 'the upstream rejected the query as malformed');

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw upstreamError('UPSTREAM_INVALID', 'the upstream returned an unreadable response');
  }

  if (payload?.error) {
    const message = payload.error.message || 'unknown upstream error';
    if (message === 'unauthenticated') throw upstreamError('UPSTREAM_UNAUTHENTICATED', 'the upstream session is not signed in');
    throw upstreamError('UPSTREAM_ERROR', `the upstream refused the request: ${message}`);
  }
  return payload?.value === undefined ? payload : payload.value;
}

/**
 * The one upstream endpoint that answers a GET. Same envelope, same error
 * vocabulary; only the method differs, so the reading is shared.
 */
export async function getJson(path, { timeout = REQUEST_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetch(new URL(path, BASE), {
      signal: AbortSignal.timeout(timeout),
      headers: CLIENT_HEADERS,
    });
  } catch (error) {
    if (['TimeoutError', 'AbortError'].includes(error.name)) throw error;
    throw upstreamError('UPSTREAM_UNAVAILABLE', `${BASE} could not be reached`);
  }
  if (response.status === 429) throw upstreamError('RATE_LIMITED', 'the upstream rate-limited the request');
  if (!response.ok) throw upstreamError('UPSTREAM_ERROR', `the upstream returned HTTP ${response.status}`);
  return readEnvelope(await response.text());
}

/**
 * Upload a file and read back the JSON envelope. Kept separate from postJson
 * because the body is multipart: setting a content-type by hand here would
 * strip the boundary the upstream needs to parse it.
 */
export async function postMultipart(path, form, { timeout = REQUEST_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetch(new URL(path, BASE), {
      method: 'POST',
      signal: AbortSignal.timeout(timeout),
      headers: CLIENT_HEADERS,
      body: form,
    });
  } catch (error) {
    if (['TimeoutError', 'AbortError'].includes(error.name)) throw error;
    throw upstreamError('UPSTREAM_UNAVAILABLE', `${BASE} could not be reached`);
  }
  if (!response.ok) throw upstreamError('UPSTREAM_ERROR', `the upstream returned HTTP ${response.status}`);

  const text = await response.text();
  if (!text.trim()) throw upstreamError('UPSTREAM_REJECTED', 'the upstream rejected the upload');
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw upstreamError('UPSTREAM_INVALID', 'the upstream returned an unreadable response');
  }
  if (payload?.error) throw upstreamError('UPSTREAM_ERROR', `the upstream refused the upload: ${payload.error.message || 'unknown error'}`);
  return payload?.value === undefined ? payload : payload.value;
}

/**
 * The proxy's own session state. Used only to explain a failure: it turns a
 * bare "not signed in" into how long it has been that way and why.
 */
export async function fetchHealth({ timeout = 10_000 } = {}) {
  try {
    const response = await fetch(new URL('/healthz', BASE), {
      signal: AbortSignal.timeout(timeout),
      headers: CLIENT_HEADERS,
    });
    const text = await response.text();
    return JSON.parse(text);
  } catch {
    // Diagnosis is best-effort; never let it mask the failure it is describing.
    return null;
  }
}

export function upstreamError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
