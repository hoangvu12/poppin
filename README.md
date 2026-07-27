# poppin

A command-line design reference library built from your own Mobbin session.
Search real app screens, browse flows, and pull structured design analysis
without a subscription API.

## What it is

poppin is an unofficial client. It drives a browser you are already signed into
and keeps a local cache of what that session is served. It belongs to the same
category as any unofficial client for a service you hold an account with.

It does not circumvent the paywall. It only renders what your own account
receives, it never touches Mobbin's paid MCP endpoint, and every request is rate
limited.

Mobbin's terms very likely prohibit automated access even with a valid account.
That is a terms-of-service risk to your account, and the decision to accept it
is yours.

## Requirements

Node 22 or newer, because the CLI uses the built-in `node:sqlite` module, plus
Google Chrome.

## Install

```bash
npm i -g github:hoangvu12/poppin
```

Or clone the repository and run it in place:

```bash
git clone https://github.com/hoangvu12/poppin.git
cd poppin
npm install
node bin/poppin.mjs --help
```

To install the agent skill into a project:

```bash
npx skills add hoangvu12/poppin
```

The skill drives the CLI, so install the CLI as well.

## Sign in

Two options. Both persist the session for later commands, and you only do this
once.

### Paste a cookie from any browser

This avoids the automated login window, and it sidesteps the "this browser may
not be secure" block that Google SSO applies to automated browsers. Log into
mobbin.com in any browser, open the DevTools console, and run:

```js
copy(document.cookie.split('; ').filter(c => c.startsWith('sb-')).join('\n'))
```

Then hand it to poppin. No file is required:

```bash
poppin import-cookies                        # paste, then Ctrl+Z Enter on Windows, Ctrl+D elsewhere
poppin import-cookies < cookies.txt          # from a file
POPPIN_COOKIES="..." poppin import-cookies   # from the environment
```

A Cookie-Editor JSON export also works. The snippet above selects the session
cookies for you. They are sometimes split across numbered chunks, so copy all of
the lines it produces.

`import-cookies` exits 0 when the session works, 1 when the cookie was rejected,
and 2 when no session cookie was found in the input.

### Automated login

```bash
poppin login
```

This opens a Chrome window for you to sign in. Google SSO sometimes refuses
automated browsers, in which case use the cookie method.

Check either with `poppin whoami`.

## Usage

There are two data paths. Signed in, use the catalog, which covers the full app
library with no per-listing cap. The scraper below it works without a session
but stops at 60 screens per listing.

### Catalog and find

```bash
poppin catalog --platform ios,web        # pull the searchable catalog
poppin catalog --platform ios --images   # and cache preview screenshots

poppin find budgeting -n 10
poppin find "meditation calm" --images --json

poppin app-screens 63d748eb --images     # deep-fetch one app
```

`find` searches app names, taglines, and Mobbin's curated keywords. Results
include preview screens, and `--images` caches them locally at full resolution.

### The anonymous scraper

```bash
poppin taxonomy --kind flows
poppin sync -p mobile -k screens --slug onboarding -n 40 --details --images
poppin sync -p mobile -k flows --slug creating-account -n 15 --images
```

### Reading the library

```bash
poppin search "empty state" --images --json
poppin search onboarding --flows --json
poppin screen 3d951da4
poppin flows onboarding
poppin flow c6d624b6                     # ordered frame sequence
poppin app Monarch
poppin analyze 3d951da4                  # palette, theme, contrast, layout
poppin stats
```

### Sync options

| Flag | Meaning |
| --- | --- |
| `-p, --platform` | `mobile` or `web` |
| `-k, --kind` | `screens`, `ui-elements`, `flows`, or `all` |
| `-s, --slug` | sync a single listing, such as `--slug onboarding` |
| `-n, --limit` | screens per listing |
| `-t, --taxonomy-limit` | listings to crawl per kind |
| `--details` | open each screen page for descriptions and tags |
| `--images` | download screenshots |
| `--delay` | milliseconds between page loads |
| `--headed` | watch the browser work |

## How it works

Mobbin is a Next.js App Router application on Supabase, and it presents two
different surfaces.

The anonymous surface at `/explore` is DOM only and caps at 60 screens per
listing. The `sync` and `search` commands scrape it with `playwright-core`
against a persistent Chrome profile.

The authenticated surface is backed by JSON rather than HTML, so the `catalog`
and `find` commands read structured records instead of scraping markup. The
details of those endpoints live in `src/api.mjs`.

A few implementation notes, since they explain why the code looks the way it
does.

Image URLs returned by the data layer are storage keys rather than fetchable
addresses, so `src/images.mjs` maps them onto the CDN that actually serves them
before caching anything.

Image URLs on the anonymous surface carry a signed transform token, which means
the width cannot be changed by editing the query string. The rendered `src` is
often a thumbnail while `srcset` advertises the original, so the scraper takes
the widest `srcset` candidate.

The "Explore similar screens" section on a screen page holds full-size
screenshots and tag links belonging to other screens. Without a
`compareDocumentPosition` guard, the scraper attributes a neighbour's screenshot
to the current screen.

Flow pages are not screen pages. They render no screen cards at all. They render
whole flows as `<article>` elements, each an ordered run of frames, and the app
name, title, and description come from the article's text block rather than from
image alt text.

## Layout

```
bin/poppin.mjs        CLI entry point
src/api.mjs           authenticated JSON and RSC access
src/harvest-api.mjs   catalog sync and per-app fetch
src/browser.mjs       persistent Chrome profile
src/cookies.mjs       cookie parsing and session import
src/extract.mjs       DOM extractors for the anonymous surface
src/harvest.mjs       anonymous crawl orchestration
src/db.mjs            SQLite schema and FTS index
src/images.mjs        image cache and CDN URL rewriting
src/analyze.mjs       palette, theme, contrast, layout extraction
skills/poppin/        agent skill
```

## Agent use

Every read command accepts `--json`, and results carry `local_path` pointing at
a cached screenshot, so an agent can search the library and then read the actual
images.

```bash
poppin find "empty state" --images --json
```

Progress messages go to stderr when `--json` is set, so stdout stays parseable.

The skill in `skills/poppin/` documents the workflow, including how to accept a
cookie from the user through stdin or the environment rather than through a
command-line argument, which would leak the session into process listings and
shell history.

## Data and privacy

The library lives in `POPPIN_DATA` when set, otherwise in `./data` when that
directory exists, otherwise in `~/.poppin`. It holds the SQLite database, the
image cache, and the Chrome profile.

The Chrome profile contains your Mobbin session. Treat that directory as a
credential. It is excluded from git, and no cookie value is ever written to the
repository.

## License

MIT
