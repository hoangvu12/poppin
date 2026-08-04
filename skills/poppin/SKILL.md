---
name: poppin
description: Searches real shipped apps for UI screens, multi-screen user flows, and UI elements, and returns the screenshots. Use for design or UX inspiration, reference screenshots, or to see how shipped products handle onboarding, paywalls, checkout, dashboards, settings, or empty states — including when the user describes the need without naming a source, as in "what does good onboarding look like" or "show me some pricing pages". Also finds screens containing specific on-screen copy, and how one app's UI changed across versions. Do not use it to critique, design, theme, or implement the user's own interface; it only retrieves examples of what other apps shipped.
license: MIT
compatibility: Requires Node 20+ and outbound network access to nibbom.nguyenvu.dev and bytescale.mobbin.com. Writes screenshots to the system temp directory.
---

# poppin

poppin searches Mobbin's library of screens from real shipped apps and downloads
the screenshots. **The screenshots are the deliverable, not the tables** — read
the downloaded files and show them, each with its app name and why it fits what
was asked for. A table of ids is not an answer.

There is no sign-in. Never ask the user for a Mobbin account, cookie, or API
key; a failing command is a network or upstream problem, never a missing
credential of theirs.

## Running it

```
npx -y github:hoangvu12/poppin <command> --images --json
```

That works with nothing installed. Use `poppin` directly if it is on PATH.
Examples below write `poppin` for brevity.

Without `--images` every `path` is `null` and nothing has been downloaded, so
pass it whenever you intend to show something.

## Pick the command

| They want | Command |
| --- | --- |
| Screens of a kind ("paywalls", "empty states") | `poppin search <query>` |
| A journey across several screens ("the signup flow") | `poppin flows <query>` |
| A specific control ("bottom sheets", "date pickers") | `poppin elements <query>` |
| Everything one app ships, or how it changed | `poppin app <name>` |
| Which apps exist in a space | `poppin find <query>` |
| The leading apps in a space, unprompted | `poppin popular --category <name>` |
| What is popular right now | `poppin trending` |
| Marketing and landing pages | `poppin sites <query>` |
| Which companies exist in a space | `poppin find <query> -p sites` |
| One piece of a landing page ("hero", "pricing table") | `poppin sections --pattern <name>` |
| Screens that look like an image they have | `poppin similar <file>` |
| One screen or one flow, by id | `poppin screen <id>` / `poppin flow <id>` |

## The vocabulary

Mobbin does not do free-text search over screens. It classifies each one against
a curated vocabulary and filters on that. A bare query resolves against that
vocabulary through Mobbin's own synonyms and partial matches — `upgrade`, `free
trial`, and `paywal` all reach `Subscription & Paywall`. Prefer a vocabulary
term when one fits; it is curated, so results are far more precise than keyword
matching.

**When an explicit `--pattern`/`--element`/`--action`/`--category` value cannot
be resolved, the command fails and lists the closest candidates. Trust that
error and retry with a suggestion — do not report "no results" to the user.**
Unresolvable values are never sent upstream, because the upstream answers an
unknown filter with an ordinary empty result that looks exactly like a genuine
one.

```
$ poppin search --pattern "Upgrade & Paywall"
--pattern "Upgrade & Paywall" is not a known value for this platform.
Closest: "Subscription & Paywall", "Signup". Run `poppin tags patterns` for the full list.
```

A bare query is more forgiving: if it names nothing in the vocabulary it falls
through to free-text search and says so on stderr, so `poppin search "crypto
portfolio dashboard"` works. But free text is a **separate mode** — tag filters
are refused there rather than silently returning unfiltered results, and only
`--text` and `--animated` still apply. An **ambiguous** query is refused too;
pick one of the listed candidates.

Read the vocabulary rather than guessing at it:

```
poppin tags patterns --json              # iOS screen patterns
poppin tags elements --platform web
poppin tags patterns --search checkout --definitions
poppin tags --platform sites             # the separate sites vocabulary
```

`poppin trending` is the shortcut when the user has no particular term in mind:
it prints the terms Mobbin is promoting, each labelled with the option it goes
to (`Signup (--pattern)`), so its output feeds straight into a search.

## Searching screens

```
poppin search "<query>" --images --json
poppin search --pattern Signup --category Finance --images --json
poppin search --text "Continue with Apple" --images --json
```

Each result carries the patterns and elements Mobbin tagged it with, `animated`,
`restricted`, and a `path` once `--images` has run.

Different filter kinds are AND'd; repeating one kind ORs its values.

`--text` matches copy rendered *inside* the screenshot, which no other filter
can reach, and it composes with everything else. Reach for it when the user asks
about wording rather than structure — "who says *7-day free trial* on their
paywall".

`--platform` takes `ios`, `web`, or `ios,web` and defaults to `ios`. Use `web`
for dashboards and SaaS interfaces, and `ios,web` when the user has not said.
The vocabulary differs between them.

## Flows

A flow is an ordered run of screens with the tap that led to each one, so it
shows a journey rather than a moment. Prefer it whenever the user says "flow",
"journey", "steps", "process", or "how does X work end to end". Present the
frames in order — the sequence is the point.

```
poppin flows onboarding --images --json
```

## One app in depth

```
poppin app duolingo --versions           # version history, newest first
poppin app duolingo --images --json      # newest version
poppin app duolingo --all -n 60 --images # across every version
```

This is the app's full library, hundreds to thousands of screens, so always
bound it with `-n` and only pass `--all` when the user genuinely wants history.

## The other surfaces

**`sites` and `sections`** search marketing pages, not apps. They have no
platform, and their vocabulary is its own — an app category name will not work
there even when the word is identical. There is no free-text fallback either: an
unrecognised query fails with suggestions, so take the suggestion.

**`find <query> -p sites`** is the only way to reach a marketing site by what
the company *does*; `sites` filters by category and visual style, never words.

**`similar <file>`** uploads a screenshot and ranks Mobbin's library by visual
likeness. Screens only, 5 MB maximum, PNG/JPEG/WebP/GIF/AVIF. A natural pairing
is to pull one screen with `--images` first and then search on it.

**`screen <id>` and `flow <id>`** need the **full** id — the shortened ids in
the tables only match the handful of preview screens in the catalog. Take the id
from `--json`. Prefer `flow <id>` over re-running a search when you already know
the flow: its frame URLs do not expire, and search results' do.

**`popular`** answers "who leads this space" with no query, ranking on Mobbin's
own signal rather than on words you supply. **`collections`** and **`saved`**
read what the account holder curated in Mobbin's UI, which is a way for a human
to hand-pick screens for you. poppin never writes to that account.

## Screenshots

Images land in `poppin-screens` inside the system temp directory, named by
screen id, and are reused within a session rather than downloaded twice. Treat
them as working files: the OS clears them on its own schedule, so do not promise
the user a permanent library. `POPPIN_IMAGE_DIR` can redirect them into a
project, but do not do that unasked — it turns a temp file into a committed
asset, and the upstream's terms restrict redistributing this content.

## Limits worth stating to the user

- **One page per search, for screens, elements, flows and sections.** Paging
  those is a paid Mobbin feature the upstream account does not have. The footer
  reports the true total: `5 result(s) of 87 matching upstream` means 82 more
  exist that this client cannot reach. Say so rather than implying the result
  set is complete. `find` and `sites` are not gated and do read everything.
- **Free text is keyword-ranked, not semantic.** Mobbin's AI-ranked `deep` mode
  is refused for this upstream. If a concept returns weak results, try a
  vocabulary term from `poppin tags` instead of rephrasing.
- **Company stage, region, language, web page pattern and page type filters do
  not work.** Mobbin's UI offers them; these endpoints ignore them. Do not
  promise them, and do not try to pass them.
- **`restricted: true` is not a download failure.** It reports what Mobbin's own
  UI would put behind a subscription, which is most rows. Screenshots come from
  the CDN and download regardless, so do not skip a result or warn the user off
  one because of this flag.
- Run `poppin stats` for current catalog and vocabulary sizes rather than
  quoting a figure from memory.
