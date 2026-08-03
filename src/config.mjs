/**
 * poppin talks to nibbom, a hosted proxy that already carries a Mobbin session
 * and answers Mobbin's data endpoints unauthenticated. Nothing in this client
 * stores, refreshes, or transmits a credential.
 */
export const BASE = process.env.POPPIN_BASE || 'https://nibbom.nguyenvu.dev';

export const USER_AGENT = 'poppin/0.3 (+https://github.com/hoangvu12/poppin)';

export const PLATFORMS = ['ios', 'web'];
