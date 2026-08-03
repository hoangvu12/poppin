---
name: poppin
description: Search a catalog of screens from real shipped apps and return the screenshots. Use when the user wants design or UX inspiration, real-world UI examples, reference screenshots, or wants to see how shipped products handle something such as onboarding, paywalls, dashboards, settings, or empty states — including when they describe the need without naming a source, as in "what does good onboarding look like" or "show me some pricing pages". Do NOT use this skill to critique, design, theme, or implement the user's own interface; it only retrieves examples of what other apps shipped, and adjacent design skills own the work of improving the user's own UI.
license: MIT
compatibility: Requires Node 20+ and outbound network access to nibbom.nguyenvu.dev and bytescale.mobbin.com. Writes screenshots to the system temp directory.
---

# poppin

poppin searches a catalog of screens from real shipped apps and downloads the
screenshots. You drive the CLI and hand the resulting images back to the user.
The screenshots are the deliverable, not the tables.

There is no sign-in. Never ask the user for a Mobbin account, cookie, or API
key — the upstream carries its own session, so a failing command is a network
or upstream problem, never a missing credential.

## Running it

```
npx -y github:hoangvu12/poppin find "<query>" --images --json
```

That works with nothing installed. If `poppin` is already on PATH, or the
working directory is the poppin repo itself, use `poppin` or
`node bin/poppin.mjs` instead to skip the download. Examples below write
`poppin` for brevity.

## Finding and returning screens

`find` is the command for almost every request. It matches app names,
taglines, and curated keywords, so conceptual queries work: "meditation calm
sleep" returns Calm, Calm Sleep, Endel, and Ten Percent Happier.

```
poppin find "<query>" --images --json
```

Each result is an app carrying a `previews` array of screens, and each screen
has a `path` once `--images` has run:

```json
[
  {
    "appName": "Calm",
    "tagline": "Sleep, meditation, relaxation",
    "platform": "ios",
    "keywords": ["meditation", "relaxation", "sleep aid"],
    "previews": [{ "id": "2729b66d-...", "path": "/tmp/poppin-screens/2729b66d-....webp" }]
  }
]
```

**Read those image files and show them to the user.** Present each with the app
name and why it fits what they asked for. A table of ids is not an answer.

Without `--images` every `path` is `null` and nothing has been downloaded, so
pass `--images` whenever you intend to show something.

## Other commands

```
poppin find "<query>" --platform web --json    # web apps instead of iOS
poppin search "<query>" --images --json        # screens directly, not grouped by app
poppin app "<name>" --images --json            # every screen for one app
poppin screen <id> --json                      # one screen, downloaded by default
poppin stats                                   # catalog size and image directory
```

Prefer `find` when the user names a kind of app or a design problem, and
`search` when they want individual screens across many apps. `--platform`
takes `ios`, `web`, or `ios,web` and defaults to `ios`; use `web` for web
apps, dashboards, and SaaS interfaces, and `ios,web` when they have not said.

## Screenshots

Images land in `poppin-screens` inside the system temp directory, named by
screen id, and are reused within a session rather than downloaded twice.
Treat them as working files: the OS clears them on its own schedule, so do not
promise the user a permanent library. `POPPIN_IMAGE_DIR` can redirect them into
a project, but do not do that unasked — it turns a temp file into a committed
asset, and the upstream's terms restrict redistributing this content.

## Cost

Every command fetches the live catalog, which takes a couple of seconds. One
`find` with a good query and a sensible `-n` beats several narrow ones. Skip
`--images` only when you truly do not need the pictures — a result without them
is just ids, which is rarely what the user wanted.

## Scope

poppin covers the app catalog and its preview screens, roughly four per app.
It does not crawl an app's full screen library and does not capture flows. Run
`poppin stats` for the current catalog size rather than quoting a figure from
memory. If the user asks for flows or exhaustive coverage, say so rather than
implying the catalog is complete.
