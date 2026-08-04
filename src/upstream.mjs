import { BASE, USER_AGENT } from './config.mjs';

const REQUEST_TIMEOUT_MS = 45_000;

/**
 * Every upstream call is a POST that answers `{ value }` on success and
 * `{ error }` on failure. Centralising it keeps one error vocabulary for the
 * CLI to translate, so no command has to invent its own failure wording.
 */
export async function postJson(path, body = {}, { timeout = REQUEST_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetch(new URL(path, BASE), {
      method: 'POST',
      signal: AbortSignal.timeout(timeout),
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (['TimeoutError', 'AbortError'].includes(error.name)) throw error;
    throw upstreamError('UPSTREAM_UNAVAILABLE', `${BASE} could not be reached`);
  }

  if (response.status === 429) throw upstreamError('RATE_LIMITED', 'the upstream rate-limited the request');
  if (!response.ok) throw upstreamError('UPSTREAM_ERROR', `the upstream returned HTTP ${response.status}`);

  const text = await response.text();
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

export function upstreamError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
