# poppin

A command-line design reference library built from your own Mobbin session.
Search the app catalog, cache the screenshots locally, and hand them to yourself
or to a coding agent.

One dependency, no browser, no image processing.

## What it is

poppin is an unofficial client. You give it your own Mobbin session cookie, and
it keeps a local cache of what that session is served. It belongs to the same
category as any unofficial client for a service you hold an account with.

It does not circumvent the paywall. It reads only what your own account
receives, and it never touches Mobbin's paid MCP endpoint.

Mobbin's terms very likely prohibit automated access even with a valid account.
That is a terms-of-service risk to your account, and the decision to accept it
is yours.

## Requirements

Node 22.13 or newer on the v22 line, 23.4 or newer on v23, or any Node 24. The
library is stored with the built-in `node:sqlite` module, which sat behind the
`--experimental-sqlite` flag before those versions. poppin checks this on
startup and tells you if your runtime is too old.

Nothing else. No browser, no native modules.

## Install

Run it without installing anything:

```bash
npx -y github:hoangvu12/poppin --help
```

Install it globally if you will use it more than once:

```bash
npm i -g github:hoangvu12/poppin
poppin --help
```

Or clone the repository and run it in place:

```bash
git clone https://github.com/hoangvu12/poppin.git
cd poppin
npm install
node bin/poppin.mjs --help
```

### Agent skill

```bash
npx skills add hoangvu12/poppin
```

That installs the instructions from `skills/poppin/` for your coding agent. It
does not install the CLI, because a skill is documentation rather than code. The
skill falls back to `npx -y github:hoangvu12/poppin`, so it works whether or not
you installed the CLI first.

## Sign in

Sign in once by pasting your session cookie. It persists for later commands.

There is no automated login. Mobbin authenticates through Google, which
regularly refuses automated browser windows, and driving a browser purely to log
in would pull in a large dependency for one step. Pasting a cookie from a browser
you already trust takes about ten seconds.

Log into mobbin.com in any browser, open the DevTools console, and run:

```js
copy(document.cookie.split('; ').filter(c => c.startsWith('sb-')).join('\n'))
```

Then hand it to poppin. No file is required:

```bash
poppin import-cookies                        # paste, then Ctrl+Z Enter on Windows, Ctrl+D elsewhere
poppin import-cookies < cookies.txt          # from a file
POPPIN_COOKIES="..." poppin import-cookies   # from the environment
```

A Cookie-Editor JSON export also works. The snippet selects the session cookies
for you, and they are sometimes split across numbered chunks, so copy every line
it produces.

`import-cookies` verifies the cookie by making a real request. It exits 0 when
the session works, 1 when the cookie was rejected, and 2 when the input
contained no session cookie. Confirm later with `poppin whoami`, which also
exits 1 when the session has expired.

Any browser works as the source. poppin only needs the cookie string.

## Quick start

```bash
poppin import-cookies              # paste your cookie
poppin catalog --platform ios      # pull the app catalog, about 900 apps
poppin find budgeting --images     # search it and cache the screenshots
```

`find` prints a local file path for each preview, which is the thing you
actually want to look at.

## Commands

| Command | What it does |
| --- | --- |
| `import-cookies` | Store and verify your session |
| `whoami` | Check whether the stored session still works |
| `catalog` | Pull the searchable app catalog into the library |
| `find <query>` | Search the catalog by name, tagline, or keywords |
| `search <query>` | Search cached screens |
| `screen <id>` | Show one screen |
| `app <name>` | Show cached screens for an app |
| `images` | Download screenshots that are not cached yet |
| `stats` | What the library holds |
| `reindex` | Rebuild the full-text index |

### catalog

```bash
poppin catalog --platform ios,web        # both platforms
poppin catalog --platform ios --images   # and cache preview screenshots
poppin catalog --no-previews             # apps only
```

One request per platform returns every app with its tagline, curated keywords,
preview screens, and logo. About 900 apps and 3,500 preview screens for iOS.

### find

```bash
poppin find budgeting -n 10
poppin find "meditation calm" --images --json
poppin find wallet --platform ios
```

`find` matches app names, taglines, and Mobbin's curated keywords, so
`poppin find "meditation calm"` returns Calm, Calm Sleep and Tide rather than
only literal matches. Each result carries up to four preview screens, and
`--images` caches them at full resolution.

### search

```bash
poppin search wallet -n 10
poppin search "empty state" --images --json
poppin search dashboard --app Monarch
```

`search` covers screens already in the library, ranking exact multi-term matches
above incidental ones.

## How it works

Mobbin is a Next.js application on Supabase. Signed in, its search bar downloads
the whole app catalog as JSON and filters it client side. poppin does the same
thing: one authenticated request per platform, stored in SQLite, searched
locally with FTS5.

That is why there is no browser here. The catalog is a plain JSON endpoint, and
the session is a cookie, so an HTTP request with the right header is all it
takes.

Two details are worth recording because they caused real bugs.

The image URLs in the catalog are storage keys rather than fetchable addresses,
and requesting them directly fails. `src/images.mjs` maps each key onto the CDN
that serves it, asks for webp, and writes the response body straight to disk, so
nothing is decoded or re-encoded locally.

An expired or malformed session does not produce a 401. The endpoint answers 200
with an almost empty body, so success is judged by the payload rather than the
status code. That is what `whoami` and `import-cookies` check.

## Agent use

Every read command accepts `--json`, and results carry `local_path` pointing at
a cached screenshot, so an agent can search the library and then read the actual
images.

```bash
poppin find "empty state" --images --json
poppin search onboarding --json
```

Progress messages go to stderr when `--json` is set, so stdout stays parseable.

The skill in `skills/poppin/` documents the workflow, including how to accept a
cookie from the user through stdin or the environment rather than through a
command-line argument, which would leak the session into process listings and
shell history.

## Layout

```
bin/poppin.mjs        CLI entry point
src/preflight.mjs     runtime version check
src/config.mjs        shared constants
src/session.mjs       stored session and authenticated requests
src/cookies.mjs       cookie parsing
src/db.mjs            SQLite schema and FTS index
src/search.mjs        FTS query building and ranking
src/harvest-api.mjs   catalog normalising, storage, and image caching
src/images.mjs        image cache and CDN URL mapping
skills/poppin/        agent skill
```

## Scope

poppin covers the app catalog and its preview screens, which is roughly four
screens per app.

It does not crawl a whole app's screen library, and it does not capture flows.
Both live behind a virtualised grid that only renders what is on screen, so
reading them needs a real browser. That was worth about 13 MB of dependency for
four screens per app, which is what the catalog already provides, so it was
removed. The git history has the browser-based version if you want it back.

## Data and privacy

The library lives in `POPPIN_DATA` when that is set, otherwise in `./data` when
that directory already exists, otherwise in `~/.poppin`. It holds the SQLite
database, the image cache, and `session.json`.

`session.json` contains your Mobbin session, so treat it as a credential. It is
excluded from git, and no cookie value is written to the repository.

## License

MIT
