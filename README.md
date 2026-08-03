# poppin

Search real app UI screens from the command line, then hand the screenshots to
yourself or to a coding agent.

One dependency. No account to create, no database to maintain.

## What it is

poppin is a thin client for [nibbom](https://nibbom.nguyenvu.dev), a hosted
proxy that carries a Mobbin session and answers Mobbin's data endpoints. poppin
itself holds no credential. There is nothing to sign into, and no cookie for
you or an agent to handle.

Every command asks nibbom for the live catalog and ranks it in memory, so
results cannot go stale. Screenshots are downloaded into the system temp
directory as working files rather than kept in a library.

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

## Commands

### find

Search apps by name, tagline, and Mobbin's curated keywords, and get their
preview screens.

```bash
poppin find "meditation calm sleep"
poppin find "issue tracking" --platform web
poppin find "onboarding" --images --json
```

Conceptual queries work because the curated keywords are searched too:
"meditation calm sleep" returns Calm, Calm Sleep, Endel, and Ten Percent
Happier. Apps matching every term in the query always rank above apps that
matched only one.

### search

The same ranking, flattened into screen rows instead of apps.

```bash
poppin search "project management" --platform web
poppin search "checkout" --app stripe --images
```

Naming an app with `--app` is the stronger signal. If the query matches nothing
inside that app, you get the app's screens rather than an empty result.

### app

Every preview screen for one app, matched by substring.

```bash
poppin app duolingo --images
```

### screen

One screen by id or id prefix. This command downloads the screenshot by
default, since asking for a single screen usually means you want to look at it.

```bash
poppin screen 2729b66d
poppin screen 2729b66d --no-images --json
```

### stats

What the upstream currently holds, and where screenshots are written.

```bash
poppin stats
```

## Options

| Option | Applies to | Meaning |
| --- | --- | --- |
| `-n, --limit <n>` | `find`, `search` | Maximum results |
| `-p, --platform <list>` | all | `ios`, `web`, or `ios,web`. Defaults to `ios`, except `screen` and `stats` which check both |
| `--app <name>` | `search` | Restrict to apps whose name contains this |
| `--images` | `find`, `search`, `app` | Download the screenshots |
| `--no-images` | `screen` | Skip the download |
| `--json` | all | Machine-readable output |

Under `--json`, progress messages go to stderr so stdout stays parseable.

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

## Scope

poppin covers the app catalog and its preview screens, roughly four per app. It
does not crawl an app's full screen library and does not capture flows, because
the upstream endpoint it reads does not carry them.

Each command fetches the catalog fresh, about 1.8 MB for iOS and 950 KB for
web. Holding no local state costs a couple of seconds per command.

## Development

```bash
npm test
```

The tests run against a stub server on localhost, so the suite needs no network
and no credential.
