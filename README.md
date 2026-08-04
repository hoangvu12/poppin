# poppin

Search real app UI screens, flows, and elements from the command line, then
hand the screenshots to yourself or to a coding agent.

One dependency. No account to create, no database to maintain.

## What it is

poppin is a thin client for [nibbom](https://nibbom.nguyenvu.dev), a hosted
proxy that carries a Mobbin session and answers Mobbin's data endpoints. poppin
itself holds no credential. There is nothing to sign into, and no cookie for
you or an agent to handle.

Searches run on Mobbin's own search endpoints rather than being ranked locally,
so a query reaches the whole library rather than a preview of it. Screenshots
are downloaded into the system temp directory as working files rather than kept
in a library.

This does not circumvent a paywall. poppin reads what the upstream serves.
Mobbin's terms restrict automated access and redistribution of its content, so
how you use what comes back is your call.

## Requirements

Node 20 or newer. There are no native modules to build and no database to
install.

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
does not install the CLI, because a skill is documentation rather than code.
The skill falls back to `npx -y github:hoangvu12/poppin`, so it works whether
or not you installed the CLI first.

## The vocabulary

Mobbin does not search screens by free text. It classifies every screen against
a curated vocabulary — screen patterns, UI elements, flow actions, app
categories — and filters on that. `poppin tags` is how you read it:

```bash
poppin tags                          # every vocabulary, for iOS
poppin tags patterns                 # the 119 iOS screen patterns
poppin tags elements --platform web  # the 60 web UI elements
poppin tags patterns --search paywall --definitions
```

You rarely need the exact name. Values resolve through Mobbin's own synonyms
and through partial matches, so `upgrade`, `free trial`, and `paywal` all reach
`Subscription & Paywall`. A value that resolves to nothing is refused with the
closest candidates rather than being sent, because **the upstream answers an
unknown filter with an ordinary empty result** — indistinguishable from a real
one. Silence would read as "Mobbin has none of these".

```
$ poppin search --pattern "Upgrade & Paywall"
--pattern "Upgrade & Paywall" is not a known value for this platform.
Closest: "Subscription & Paywall", "Signup". Run `poppin tags patterns` for the full list.
```

## Commands

### search

Screens, by pattern, element, category, or the copy printed on them.

```bash
poppin search signup --images
poppin search "bottom sheet" --platform web
poppin search --pattern Signup --category Finance --images
poppin search --text "Continue with Apple" --json
poppin search onboarding --animated
```

A bare query is first resolved against the pattern and element vocabularies,
which is what Mobbin's own search bar does. If it names nothing there, it falls
through to Mobbin's free-text search instead, and the CLI says so on stderr:

```
$ poppin search "crypto portfolio dashboard"
"crypto portfolio dashboard" matched no vocabulary term; searching free text instead.
```

Free text is a **different mode, not an extra filter**: the upstream ignores
every tag filter in it, so combining the two is refused rather than quietly
returning unfiltered results. Only `--text` and `--animated` still apply.

`--text` is a separate axis in either mode: it matches text rendered *inside*
the screenshot, and with a vocabulary term it composes with every other filter.

### flows

Multi-screen user flows, in the order the screens appear, with the tap that led
to each one.

```bash
poppin flows onboarding --images
poppin flows --action "Purchasing & Ordering" --app deliveroo --images
```

### elements

Screens containing a given UI element. Mobbin returns the whole screen rather
than a crop of the element.

```bash
poppin elements "bottom sheet" --images
poppin elements --element Button --category Finance
```

### app

Every screen Mobbin holds for one app, grouped by the version it shipped in.
This is the app's real library, not the four previews the search bar carries —
Duolingo alone is 2,385 screens across 8 versions.

```bash
poppin app duolingo --versions       # the version history
poppin app duolingo --images         # the newest version
poppin app duolingo --all -n 100     # across every version
poppin app duolingo --version 2585ff78
```

### find

Apps, by name, tagline, and Mobbin's curated keywords.

```bash
poppin find "meditation calm sleep"
poppin find "issue tracking" --platform web
poppin find banking --category Finance
```

Conceptual queries work because the curated keywords are searched too:
"meditation calm sleep" returns Calm, Calm Sleep, and Endel. Apps matching every
term in the query rank above apps that matched only one. Passing `--category`
switches to Mobbin's own app search instead of local ranking.

### screen

One screen by id or id prefix. This command downloads the screenshot by
default, since asking for a single screen usually means you want to look at it.

```bash
poppin screen 2729b66d
poppin screen 2729b66d --no-images --json
```

### stats

What the upstream currently holds, the size of each vocabulary, and where
screenshots are written.

```bash
poppin stats
```

## Options

| Option | Applies to | Meaning |
| --- | --- | --- |
| `-n, --limit <n>` | `find`, `search`, `flows`, `elements`, `app` | Maximum results |
| `-p, --platform <list>` | all | `ios`, `web`, or `ios,web`. Defaults to `ios`, except `screen` and `stats` which check both |
| `--pattern <name>` | `search`, `elements` | Screen pattern. Repeatable; several are OR'd |
| `--element <name>` | `search`, `elements` | UI element. Repeatable |
| `--action <name>` | `flows` | Flow action. Repeatable |
| `--category <name>` | `search`, `flows`, `elements`, `find` | App category. Repeatable |
| `--text <copy>` | `search`, `elements` | Text rendered inside the screenshot |
| `--animated` | `search`, `elements` | Only screens with a recorded animation |
| `--app <name>` | `search`, `flows`, `elements` | Restrict to apps whose name contains this |
| `--sort <order>` | `search`, `flows`, `elements` | `popularity` (default), `publishedAt`, `trending` |
| `--all`, `--versions`, `--version <id>` | `app` | Span every version, list them, or pick one |
| `--images` | `find`, `search`, `flows`, `elements`, `app` | Download the screenshots |
| `--no-images` | `screen` | Skip the download |
| `--refresh` | filtered commands, `tags` | Re-fetch the cached vocabulary |
| `--json` | all | Machine-readable output |

Under `--json`, progress messages go to stderr so stdout stays parseable.
Different filter kinds are AND'd together; repeating one kind ORs its values.

## Screenshots

Screenshots are written to `poppin-screens` inside the system temp directory
(`%TEMP%` on Windows, `/tmp` on Linux and macOS) and named by screen id. A file
that is already there gets reused instead of downloaded again, and the OS
clears it out on its own schedule. Set `POPPIN_IMAGE_DIR` to put them somewhere
else.

The `path` field of every result stays `null` until the screenshot has been
downloaded.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `POPPIN_BASE` | `https://nibbom.nguyenvu.dev` | Upstream to query |
| `POPPIN_IMAGE_DIR` | `<tmp>/poppin-screens` | Where screenshots are written |
| `POPPIN_CACHE_DIR` | `<tmp>/poppin-cache` | Where the vocabulary is cached |

## What is cached

Only the filter vocabulary, for 24 hours. It is roughly 490 KB and changes on
Mobbin's editorial schedule rather than per query, so caching it makes filter
resolution instant without letting anything you actually search go stale.
Results are never cached. `--refresh` re-fetches it.

## Limits

- **One page per search.** The upstream serves up to 100 rows and reports how
  many matched; requesting the second page through the proxy comes back empty.
  Result counts are reported honestly, so `5 result(s) of 87 matching upstream`
  means there are 82 more that this client cannot currently reach.
- **Free text does not combine with filters.** Mobbin treats it as a separate
  mode and ignores tag filters there. Its AI-ranked `deep` mode is rejected for
  this upstream's account, so free text is keyword-ranked, not semantic.
- **Five filter dimensions Mobbin's own UI shows are not available.** Company
  stage, region, language, web page pattern, and page type are all silently
  ignored by these endpoints — every field-name spelling was probed against a
  live baseline, and `activeFilterTags` is ignored in every shape too. Mobbin
  applies them somewhere this API does not reach.
- **Search by image is not implemented.** Mobbin can search from an uploaded
  screenshot; poppin cannot.
- **Sites are not covered.** Mobbin's third experience — marketing site pages
  and sections, with their own page patterns and visual styles — is not wired
  up yet.
- **No app-scoped search upstream.** The search endpoints ignore an app id, so
  `--app` narrows the page of results already returned rather than the query.

## Development

```bash
npm test
```

The tests run against a stub server on localhost, so the suite needs no network
and no credential.
