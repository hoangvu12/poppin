---
name: poppin
description: Search real shipped apps for UI screens, multi-screen user flows, and UI elements, and return the screenshots. Use when the user wants design or UX inspiration, real-world UI examples, reference screenshots, or wants to see how shipped products handle something such as onboarding, paywalls, checkout, dashboards, settings, or empty states — including when they describe the need without naming a source, as in "what does good onboarding look like" or "show me some pricing pages". Also use to find screens containing specific on-screen copy, or to see how one app's UI changed across versions. Do NOT use this skill to critique, design, theme, or implement the user's own interface; it only retrieves examples of what other apps shipped, and adjacent design skills own the work of improving the user's own UI.
license: MIT
compatibility: Requires Node 20+ and outbound network access to nibbom.nguyenvu.dev and bytescale.mobbin.com. Writes screenshots to the system temp directory.
---

# poppin

poppin searches Mobbin's library of screens from real shipped apps and
downloads the screenshots. You drive the CLI and hand the resulting images back
to the user. **The screenshots are the deliverable, not the tables.**

There is no sign-in. Never ask the user for a Mobbin account, cookie, or API
key — the upstream carries its own session, so a failing command is a network
or upstream problem, never a missing credential of theirs.

## Running it

```
npx -y github:hoangvu12/poppin <command> --images --json
```

That works with nothing installed. If `poppin` is already on PATH, or the
working directory is the poppin repo itself, use `poppin` or
`node bin/poppin.mjs` instead to skip the download. Examples below write
`poppin` for brevity.

## Pick the command by what the user wants to see

| They want | Command |
| --- | --- |
| Screens of a kind ("paywalls", "empty states") | `poppin search <query>` |
| A journey across several screens ("the signup flow") | `poppin flows <query>` |
| A specific control ("bottom sheets", "date pickers") | `poppin elements <query>` |
| Everything one app ships, or how it changed | `poppin app <name>` |
| Which apps exist in a space | `poppin find <query>` |

## The vocabulary is the whole trick

Mobbin does not do free-text search over screens. It classifies every screen
against a curated vocabulary and filters on that. A bare query is resolved
against that vocabulary for you, through Mobbin's own synonyms and partial
matches — `upgrade`, `free trial`, and `paywal` all reach
`Subscription & Paywall`.

**When an explicit `--pattern`/`--element`/`--action`/`--category` value cannot
be resolved, the command fails and lists the closest candidates. Trust that
error and retry with a suggestion — do not report "no results" to the user.** An
unresolvable value is never sent to the upstream, because the upstream answers
an unknown filter with an ordinary empty result that looks exactly like a
genuine one.

A *bare query* is more forgiving: if it names nothing in the vocabulary it falls
through to Mobbin's free-text search automatically, and says so on stderr. So
`poppin search "crypto portfolio dashboard"` works even though no such pattern
exists. Two consequences worth knowing:

- Free text is a **separate mode**, and the upstream ignores tag filters in it.
  Combining them is refused rather than silently returning unfiltered results.
  Only `--text` and `--animated` still apply.
- An **ambiguous** query (matching several real terms) is refused rather than
  falling back — pick one of the listed candidates.

Prefer a vocabulary term when one fits: it is curated, so results are far more
precise than keyword matching.

```
$ poppin search --pattern "Upgrade & Paywall"
--pattern "Upgrade & Paywall" is not a known value for this platform.
Closest: "Subscription & Paywall", "Signup". Run `poppin tags patterns` for the full list.
```

If you need to see the vocabulary, read it rather than guessing:

```
poppin tags patterns --json              # 119 iOS screen patterns
poppin tags elements --platform web      # 60 web UI elements
poppin tags actions                      # 71 flow actions
poppin tags patterns --search checkout --definitions
```

## Searching screens

```
poppin search "<query>" --images --json
poppin search --pattern Signup --category Finance --images --json
poppin search --text "Continue with Apple" --images --json
```

Each result carries the patterns and elements Mobbin tagged it with, plus a
`path` once `--images` has run:

```json
[
  {
    "id": "ae26fa9d-...",
    "appName": "Deliveroo",
    "platform": "ios",
    "patterns": ["Signup"],
    "elements": [],
    "animated": false,
    "path": "/tmp/poppin-screens/ae26fa9d-....webp"
  }
]
```

**Read those image files and show them to the user.** Present each with the app
name and why it fits what they asked for. A table of ids is not an answer.

Without `--images` every `path` is `null` and nothing has been downloaded, so
pass `--images` whenever you intend to show something.

### `--text` is a separate axis

`--text` matches copy rendered *inside* the screenshot, which no other filter
can reach. It composes with everything else. Reach for it when the user asks
about wording rather than structure — "who says *7-day free trial* on their
paywall", "which apps offer *Continue with Apple*".

### Combining filters

Different filter kinds are AND'd; repeating one kind ORs its values.

```
poppin search --pattern Signup --pattern Login --category Finance
```

## Flows

A flow is an ordered run of screens with the tap that led to each one, so it
shows a journey rather than a moment. Prefer it whenever the user says "flow",
"journey", "steps", "process", or "how does X work end to end".

```
poppin flows onboarding --images --json
```

Each flow has `screens` in order, each frame with its own `path`. Present them
in order — the sequence is the point. Frames are named by position, so a screen
that repeats stays distinct.

## One app in depth

```
poppin app duolingo --versions           # version history, newest first
poppin app duolingo --images --json      # newest version
poppin app duolingo --all -n 60 --images # across every version
```

This is the app's full library — hundreds to thousands of screens — so always
bound it with `-n` and only pass `--all` when the user genuinely wants history.
`--versions` is the cheap way to answer "how has this app changed".

## Platforms

`--platform` takes `ios`, `web`, or `ios,web` and defaults to `ios`. Use `web`
for web apps, dashboards, and SaaS interfaces, and `ios,web` when the user has
not said. The vocabulary differs between them, so a pattern that exists on iOS
may not exist on web.

## Screenshots

Images land in `poppin-screens` inside the system temp directory, named by
screen id, and are reused within a session rather than downloaded twice. Treat
them as working files: the OS clears them on its own schedule, so do not promise
the user a permanent library. `POPPIN_IMAGE_DIR` can redirect them into a
project, but do not do that unasked — it turns a temp file into a committed
asset, and the upstream's terms restrict redistributing this content.

## Cost

The filter vocabulary is cached for 24 hours; results are always fetched live.
One well-aimed search with a sensible `-n` beats several narrow ones. Skip
`--images` only when you truly do not need the pictures — a result without them
is just ids, which is rarely what the user wanted.

## Scope and limits

- **One page per search.** Up to 100 rows come back, and the footer reports how
  many matched in total: `5 result(s) of 87 matching upstream` means 82 more
  exist that this client cannot page to. Say so rather than implying the result
  set is complete.
- **Free text is keyword-ranked, not semantic.** Mobbin's AI-ranked `deep` mode
  is not available to this upstream. If a concept returns weak results, try a
  vocabulary term from `poppin tags` instead of rephrasing.
- **Company stage, region, language, web page pattern and page type filters do
  not work.** Mobbin's UI offers them; these endpoints ignore them. Do not
  promise them, and do not try to pass them.
- **Search by image is not supported.**
- **Marketing sites are not covered.** Mobbin's sites experience — landing page
  sections, heroes, footers — is not wired up. Say so if asked.
- Run `poppin stats` for current catalog and vocabulary sizes rather than
  quoting a figure from memory.
