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

One screen, downloaded by default since asking for a single screen usually
means you want to look at it. A full id is resolved upstream and works for any
screen; a shortened one only matches the preview screens held in the catalog,
because the upstream will resolve a screen only by its whole id. The tables
print shortened ids, so use `--json` when you need the full one.

```bash
poppin screen 2729b66d                       # a catalog preview, by prefix
poppin screen 539361ea-cd64-4829-b6ac-e5dd685b8de8
poppin screen 539361ea-cd64-4829-b6ac-e5dd685b8de8 --no-images --json
```

This is also the only place the full-page capture and the animation recording
are exposed, when a screen has them.

### sites

Mobbin's other library: marketing sites, filtered by what the company does and
how the page looks. Sites have no platform, and their vocabulary is separate
from the app one — a sites category is not an app category.

```bash
poppin sites --category Finance --style Dark
poppin sites brutalist
poppin tags --platform sites
```

### sections

The individual pieces those pages are built from — heroes, pricing tables,
FAQs, footers — searchable on their own.

```bash
poppin sections --pattern "Hero Section"
poppin sections --pattern Pricing --text "per month" --images
```

### similar

Search by screenshot rather than by word. The image is uploaded, and Mobbin
ranks its library by visual similarity. Screens only, and at most 5 MB.

```bash
poppin search --pattern Login --limit 1 --images
poppin similar ~/screens/that-one.webp --limit 20
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
| `-n, --limit <n>` | `find`, `search`, `flows`, `elements`, `app`, `sites`, `sections`, `similar` | Maximum results |
| `-p, --platform <list>` | all but `sites`/`sections` | `ios`, `web`, or `ios,web`. Defaults to `ios`, except `screen` and `stats` which check both. `tags` also accepts `sites` |
| `--pattern <name>` | `search`, `elements`, `sections` | Screen pattern, or page/section pattern on `sections`. Repeatable; several are OR'd |
| `--element <name>` | `search`, `elements` | UI element. Repeatable |
| `--action <name>` | `flows` | Flow action. Repeatable |
| `--category <name>` | `search`, `flows`, `elements`, `find`, `sites`, `sections` | App category, or site category on the sites commands. Repeatable |
| `--style <name>` | `sites`, `sections` | Visual style of the site. Repeatable |
| `--text <copy>` | `search`, `elements`, `sections` | Text rendered inside the screenshot |
| `--animated` | `search`, `elements` | Only screens with a recorded animation |
| `--app <name>` | `search`, `flows`, `elements`, `similar` | Restrict to apps whose name contains this |
| `--sort <order>` | `search`, `flows`, `elements`, `sites`, `sections` | `popularity`, `publishedAt`, `trending`. Defaults to `popularity`, or `publishedAt` on the sites commands |
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

- **One page per search, for the content libraries.** Paging is a paid feature:
  Mobbin's own page only offers a load-more control to a subscribed account, and
  the upstream enforces the same rule by answering page 1 with `totalCount: 0`.
  Screens, elements, flows and sections therefore stop after their first page,
  and counts are reported honestly — `5 result(s) of 87 matching upstream` means
  there are 82 more this client cannot reach. Apps and sites are directory
  listings, are not gated, and are read to completion.
- **Free text does not combine with filters.** Mobbin treats it as a separate
  mode and ignores tag filters there. Its AI-ranked `deep` mode is refused for
  this upstream's account, so free text is keyword-ranked, not semantic.
- **Five filter dimensions Mobbin's own UI shows are not available.** Company
  stage, region, language, web page pattern, and page type are all silently
  ignored by these endpoints — every field-name spelling was probed against a
  live baseline, and `activeFilterTags` is ignored in every shape too. This is a
  different failure from the paid ones: an ignored field leaves the result count
  untouched, where a refused one zeroes it. Mobbin applies these somewhere this
  API does not reach.
- **No app-scoped search upstream.** The search endpoints ignore an app id, so
  `--app` narrows the page of results already returned rather than the query.
- **`restricted` is reported honestly, and does not limit downloads.** poppin
  asks the proxy for the upstream's real entitlement state rather than the
  rewritten one, so the flag says what Mobbin's own UI would gate behind a
  subscription — most rows, in practice. Screenshots are fetched from the CDN
  directly and are unaffected: every restricted row tested downloaded normally.

## Development

```bash
npm test
```

The tests run against a stub server on localhost, so the suite needs no network
and no credential.
