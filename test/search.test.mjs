import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAppName, rankApps, terms } from '../src/search.mjs';

const app = (appName, extra = {}) => ({
  id: appName.toLowerCase(),
  platform: 'ios',
  appName,
  tagline: null,
  keywords: [],
  previews: [],
  ...extra,
});

const CATALOG = [
  app('Calm', { tagline: 'Sleep more, stress less', keywords: ['meditation', 'sleep', 'mindfulness'] }),
  app('Headspace', { tagline: 'Meditation and sleep', keywords: ['meditation', 'wellness'] }),
  app('Duolingo', { tagline: 'Learn a language', keywords: ['education', 'gamification'] }),
  app('Calmly', { platform: 'web', keywords: ['notes'] }),
];

test('stop words and single characters are dropped from a query', () => {
  assert.deepEqual(terms('show me the onboarding screens for a app'), ['onboarding']);
});

test('an exact app name outranks a keyword match', () => {
  const [first] = rankApps(CATALOG, 'calm', { limit: 5 });
  assert.equal(first.appName, 'Calm');
});

test('conceptual queries match curated keywords', () => {
  const names = rankApps(CATALOG, 'meditation sleep', { limit: 5 }).map(result => result.appName);
  assert.deepEqual(names.slice(0, 2), ['Calm', 'Headspace']);
  assert.ok(!names.includes('Duolingo'));
});

test('apps matching every term rank above apps matching one', () => {
  const names = rankApps(CATALOG, 'meditation language', { limit: 5 }).map(result => result.appName);
  assert.ok(names.includes('Calm'));
  assert.ok(names.includes('Duolingo'));
});

test('a shortened query still matches by prefix', () => {
  const names = rankApps(CATALOG, 'medit', { limit: 5 }).map(result => result.appName);
  assert.ok(names.includes('Calm'));
  assert.ok(names.includes('Headspace'));
});

test('a platform filter is applied before ranking', () => {
  const names = rankApps(CATALOG, 'calm', { limit: 5, platform: 'web' }).map(result => result.appName);
  assert.deepEqual(names, ['Calmly']);
});

test('an unmatched query returns nothing rather than everything', () => {
  assert.deepEqual(rankApps(CATALOG, 'quantum tunnelling', { limit: 5 }), []);
});

test('app name matching is a case-insensitive substring, shortest first', () => {
  const names = matchAppName(CATALOG, 'calm').map(result => result.appName);
  assert.deepEqual(names, ['Calm', 'Calmly']);
});
