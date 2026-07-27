# poppin

A command-line design reference library built from your own Mobbin session.
Search real app screens, browse whole user flows, and cache the screenshots
locally so you or a coding agent can look at them.

## What it is

poppin is an unofficial client. You give it your own Mobbin session, and it
keeps a local cache of what that session is served. It belongs to the same
category as any unofficial client for a service you hold an account with.

It does not circumvent the paywall. It reads only what your own account
receives, it never touches Mobbin's paid MCP endpoint, and it rate limits its
requests.

Mobbin's terms very likely prohibit automated access even with a valid account.
That is a terms-of-service risk to your account, and the decision to accept it
is yours.

## Requirements

Node 22 or newer, because the CLI uses the built-in `node:sqlite` module, plus
Google Chrome, which the browser layer drives rather than downloading one.

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
regularly refuses automated browser windows with a "this browser may not be
secure" error, so an automated flow would be unreliable. Pasting a cookie from a
browser you already trust works every time and takes about ten seconds.

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

`import-cookies` exits 0 when the session works, 1 when the cookie was rejected
because it expired or was pasted partially, and 2 when the input contained no
session cookie. Confirm with `poppin whoami`, which exits 1 when signed out.

Any browser works as the source. poppin drives its own Chrome profile and only
needs the cookie string.

## Quick start

```bash
poppin import-cookies              # paste your cookie
poppin catalog --platform ios      # pull the app catalog, about 900 apps
poppin find budgeting --images     # search it and cache the screenshots
```

`find` prints a local file path for each preview, which is the thing you
actually want to look at.

## Commands

### Fetching, signed in

| Command | What it does |
| --- | --- |
| `catalog` | Pull the searchable app catalog into the library |
| `app-screens <id>` | Deep-fetch the screens for one catalog app |

```bash
poppin catalog --platform ios,web        # both platforms
poppin catalog --platform ios --images   # and cache preview screenshots
poppin app-screens 63d748eb --images     # id or 8-character prefix from find
```

`catalog` accepts `--platform <list>` (default `ios`), `--no-previews` to store
apps without their preview screens, `--images`, and `--headed` to watch the
browser.

`app-screens` reads the app's on-page grid, which is virtualised and opens
screens in modals, so it returns the screens that grid exposes rather than a
guaranteed complete set.

### Fetching, without a session

The public browse pages work signed out but stop at 60 screens per listing. This
path is also the only source of ordered flows.

```bash
poppin taxonomy --kind flows
poppin sync -p mobile -k screens --slug onboarding -n 40 --details --images
poppin sync -p mobile -k flows --slug creating-account -n 15 --images
```

| Flag | Meaning |
| --- | --- |
| `-p, --platform` | `mobile` or `web`, default `mobile` |
| `-k, --kind` | `screens`, `ui-elements`, `flows`, or `all`, default `screens` |
| `-s, --slug` | sync a single listing, such as `--slug onboarding` |
| `-n, --limit` | screens per listing, default 40 |
| `-t, --taxonomy-limit` | listings to crawl per kind, default 12 |
| `--details` | open each screen page for descriptions and tags |
| `--images` | download screenshots |
| `--delay` | milliseconds between page loads, default 1500 |
| `--headed` | watch the browser work |

`--taxonomy-limit` applies per kind, so `--kind all` does not spend the whole
budget on whichever kind sorts first.

### Reading the library

None of these need a session or a browser.

```bash
poppin find budgeting -n 10              # search the catalog by app
poppin search "empty state" --images     # search cached screens
poppin search onboarding --flows         # search flows
poppin search paywall --all              # both
poppin screen 3d951da4                   # one screen and its tags
poppin flows onboarding                  # list captured flows
poppin flow c6d624b6                     # one flow as an ordered sequence
poppin app Monarch                       # cached screens for an app
poppin taxonomy --kind flows             # known patterns, elements, flows
poppin stats                             # what the library holds
```

`find` matches app names, taglines, and Mobbin's curated keywords, so
`poppin find "meditation calm"` returns Calm, Tide, and Ten Percent Happier
rather than only literal matches. `search` covers screens and flows already in
the library, with exact multi-term matches ranked above incidental ones.

### Maintenance

```bash
poppin images -n 500      # download screenshots that are not cached yet
poppin images --force     # re-download even if cached
poppin reindex            # rebuild the full-text index
```

## How it works

Mobbin is a Next.js App Router application on Supabase, and it presents two
different surfaces.

The public surface at `/explore` is DOM only and caps at 60 screens per listing.
`sync` scrapes it with `playwright-core` against a persistent Chrome profile.

The authenticated surface is backed by JSON rather than HTML, so `catalog` and
`find` read structured records instead of scraping markup. That is why the
signed-in path has no per-listing cap and carries keywords the public pages
never expose. The details live in `src/api.mjs`.

Everything else reads the local SQLite database, with FTS5 for search.

A few implementation notes, since they explain why the code looks the way it
does.

Image URLs returned by the data layer are storage keys rather than fetchable
addresses, so `src/images.mjs` maps them onto the CDN that serves them before
caching anything.

Image URLs on the public surface carry a signed transform token, so the width
cannot be changed by editing the query string. The rendered `src` is often a
thumbnail while `srcset` advertises the original, and the scraper takes the
widest `srcset` candidate.

The "Explore similar screens" section on a screen page holds full-size
screenshots and tag links belonging to other screens. Without a
`compareDocumentPosition` guard, the scraper attributes a neighbour's screenshot
to the current screen.

Flow pages are not screen pages. They render no screen cards at all. They render
whole flows as `<article>` elements, each an ordered run of frames, and the app
name, title, and description come from the article's text block rather than from
image alt text.

## Agent use

Every read command accepts `--json`, and results carry `local_path` pointing at
a cached screenshot, so an agent can search the library and then read the actual
images.

```bash
poppin find "empty state" --images --json
poppin search onboarding --flows --json
poppin flow c6d624b6 --json
```

Progress messages go to stderr when `--json` is set, so stdout stays parseable.

The skill in `skills/poppin/` documents the workflow, including how to accept a
cookie from the user through stdin or the environment rather than through a
command-line argument, which would leak the session into process listings and
shell history.

## Layout

```
bin/poppin.mjs        CLI entry point
src/config.mjs        constants shared by the light and browser paths
src/db.mjs            SQLite schema and FTS index
src/search.mjs        FTS query building and ranking
src/images.mjs        image cache and CDN URL mapping
src/cookies.mjs       cookie parsing and session import
src/api.mjs           authenticated data access
src/harvest-api.mjs   catalog sync and per-app fetch
src/browser.mjs       persistent Chrome profile
src/extract.mjs       DOM extractors for the public browse pages
src/harvest.mjs       crawl orchestration for those pages
skills/poppin/        agent skill
```

Browser modules load on demand, so commands that only read the local library
never import playwright and start immediately.

## Dependencies

Two, on purpose.

`commander` parses arguments. `playwright-core` drives the browser, and it uses
the Chrome you already have rather than downloading its own, which is why it
costs about 13 MB rather than several hundred.

There is no image processing dependency. The CDN is asked for webp and the
response body is written straight to disk, so nothing is decoded or re-encoded
locally.

## Data and privacy

The library lives in `POPPIN_DATA` when that is set, otherwise in `./data` when
that directory already exists, otherwise in `~/.poppin`. It holds the SQLite
database, the image cache, and the Chrome profile.

The Chrome profile contains your Mobbin session, so treat that directory as a
credential. It is excluded from git, and no cookie value is written to the
repository.

## License

MIT
