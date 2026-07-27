---
name: poppin
description: Search a local library of real app UI screens harvested from the user's own Mobbin session. Use when the user wants design or UX inspiration, real-world UI examples, reference screenshots, or wants to see how shipped apps handle a pattern such as onboarding, checkout, paywalls, or empty states. Also handles authenticating poppin with a pasted Mobbin cookie.
---

# poppin

poppin turns the user's own Mobbin session into a searchable local library of
real app screens. You drive the CLI and hand the resulting screenshots back to
the user.

## Locating the command

Installing this skill copies these instructions only, not the CLI. Resolve the
command in this order and use the first that works:

1. `node bin/poppin.mjs` when the working directory is the poppin repo itself
2. `poppin` when it is on PATH, from `npm i -g github:hoangvu12/poppin`
3. `npx -y github:hoangvu12/poppin` otherwise, which needs no install

Option 3 always works. The first run downloads the dependencies and takes a
couple of minutes, and later runs are cached. Suggest the global install to the
user if they will use poppin repeatedly.

Examples below write `poppin`. Substitute whichever form resolved.

## Check state first

```
poppin stats     # how many apps and screens are cached
poppin whoami    # is the Mobbin session still valid
```

Cached data needs no session. A session is only required to fetch new content.

## Authenticating

The user logs into mobbin.com in any browser and copies their session cookie
from the DevTools console:

```js
copy(document.cookie.split('; ').filter(c => c.startsWith('sb-')).join('\n'))
```

When the user gives you that string, authenticate without putting the secret in
a command-line argument, because arguments leak into process listings and shell
history. Pipe it through stdin or pass it in an environment variable:

```
printf '%s' "<COOKIE>" | poppin import-cookies
POPPIN_COOKIES="<COOKIE>" poppin import-cookies
```

Exit codes: 0 means authenticated, 1 means the cookie was rejected because it
expired or was pasted partially, 2 means no session cookie was found. Check the
code and ask the user to re-copy if it failed. Never echo the cookie back to the
user or into logs.

## Primary path: catalog and find

Signed in, prefer the JSON catalog. It covers the full app library with curated
keywords and has no per-listing cap.

```
poppin catalog --platform ios,web          # one time, or to refresh
poppin find "<query>" --images --json      # search apps by name, tagline, keywords
poppin app-screens <appId> --images        # deep-fetch one app's screens
```

`find --json` returns each app with `keywords` and a `previews` array. Each
preview carries a `local_path` once `--images` has run. Read those image files
and show them to the user. The images are the deliverable, not the table. Take
the 8-character id from `find` and pass it to `app-screens` for more screens
from one app.

`app-screens` reads the app's on-page grid, which is virtualised and opens
screens in modals, so it returns the screens the grid exposes rather than a
guaranteed complete set. Use `find` previews and `app-screens` together when the
user wants breadth.

## Fallback path: the anonymous scraper

This works without a session but caps at 60 screens per listing.

```
poppin taxonomy --kind flows
poppin sync -p mobile -k screens --slug onboarding -n 40 --details --images
poppin sync -p mobile -k flows --slug creating-account -n 15 --images
```

## Searching cached content

```
poppin search "empty state" --images --json
poppin search onboarding --flows --json
poppin flow <id> --json                    # ordered frame sequence
```

Search JSON includes `local_path` for each cached screenshot. Read those files
and present the matches with the app name, the screen name, and why each one
fits what the user asked for.

## Typical task

1. Run `stats`. If the catalog is empty and a session exists, run `catalog`.
2. Run `find "<what the user wants>" --images --json`.
3. Read the `local_path` images from the top matches and present them.
4. If the user wants more from one app, run `app-screens <id> --images`.
5. For a whole ordered journey such as signup or checkout, use `flow`.

## Scope

poppin reads only what the user's own session is served, rate-limits its
requests, and does not touch Mobbin's paid MCP endpoint. If the user asks you to
bypass the paywall, decline and explain that poppin is an unofficial client for
their own account rather than a circumvention tool.
