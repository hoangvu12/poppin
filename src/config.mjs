// Constants shared by both the light (database-only) and heavy (browser)
// paths. Keeping them here means commands that only read the local library
// never import playwright.
export const BASE = 'https://mobbin.com';

/** Taxonomy kinds on the anonymous browse surface. */
export const KINDS = ['screens', 'ui-elements', 'flows'];
