import { chromium } from 'playwright-core';
import path from 'node:path';
import { DATA_DIR } from './db.mjs';

export const PROFILE_DIR = process.env.POPPIN_PROFILE || path.join(DATA_DIR, 'profile');
export const BASE = 'https://mobbin.com';

/**
 * Launch a real Chrome against a persistent profile, so a manual login in
 * `poppin login` carries over into every later `sync` run.
 */
export async function launch({ headless = true } = {}) {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless,
    viewport: { width: 1440, height: 1000 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  // Trim obvious noise so we are not pulling analytics payloads on every page.
  await ctx.route(/(googletagmanager|google-analytics|analytics\.google|doubleclick|pinterest|churnkey|framerusercontent|framer\.com|monitoring\?o=)/, r => r.abort());
  const page = ctx.pages()[0] || await ctx.newPage();
  return { ctx, page };
}

export async function isLoggedIn(page) {
  await page.goto(`${BASE}/explore/mobile`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  return page.evaluate(() =>
    !document.querySelector('a[href="/login"]') || !!document.querySelector('a[href^="/account"],[data-testid*=avatar]')
  );
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
