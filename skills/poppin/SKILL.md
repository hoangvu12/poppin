---
name: poppin
description: Search a local library of real app UI screens harvested from the user's own Mobbin session. Use when the user wants design or UX inspiration, real-world UI examples, reference screenshots, or wants to see how shipped apps present something such as onboarding, paywalls, dashboards, or empty states. Also handles authenticating poppin with a pasted Mobbin cookie.
---

# poppin

poppin turns the user's own Mobbin session into a searchable local library of
real app screens. You drive the CLI and hand the resulting screenshots back to
the user. The screenshots are the deliverable, not the tables.

## Locating the command

Installing this skill copies these instructions only, not the CLI. Resolve the
command in this order and use the first that works:

1. `node bin/poppin.mjs` when the working directory is the poppin repo itself
2. `poppin` when it is on PATH, from `npm i -g github:hoangvu12/poppin`
3. `npx -y github:hoangvu12/poppin` otherwise, which needs no install

Option 3 always works. Suggest the global install if the user will run poppin
repeatedly. Examples below write `poppin`, so substitute whichever form
resolved.

## Check state first

```
poppin stats     # how many apps and screens are cached
poppin whoami    # is the stored session still valid
```

Cached data needs no session. A session is only needed to fetch new content.

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

Exit codes: 0 authenticated, 1 the cookie was rejected because it expired or was
pasted partially, 2 no session cookie was found in the input. Check the code and
ask the user to re-copy if it failed. Never echo the cookie back or into logs.

## Fetching content

```
poppin catalog --platform ios          # about 900 apps and 3,500 preview screens
poppin catalog --platform ios,web      # both platforms
```

Run this once, or again to refresh. Everything else reads the local library.

## Finding and returning screens

```
poppin find "<query>" --images --json   # search apps, cache their previews
poppin search "<query>" --images --json # search screens already cached
```

`find` matches app names, taglines, and Mobbin's curated keywords, so
conceptual queries work: "meditation calm" returns Calm, Calm Sleep and Tide.
Each result carries a `previews` array, and each preview has a `local_path` once
`--images` has run.

**Read those image files and show them to the user.** Present each with the app
name and why it fits what they asked for. A table of ids is not an answer.

## Typical task

1. Run `stats`. If the catalog is empty and a session exists, run `catalog`.
2. Run `find "<what the user wants>" --images --json`.
3. Read the `local_path` images from the top matches and present them.
4. Use `search` instead when the user wants a specific screen already cached
   rather than a whole app.

## Scope

poppin covers the app catalog and its preview screens, roughly four per app. It
does not crawl an app's full screen library and does not capture flows, because
those need a real browser. If the user asks for those, say so rather than
implying the library is exhaustive.

poppin reads only what the user's own session is served and does not touch
Mobbin's paid MCP endpoint. If the user asks you to bypass the paywall, decline
and explain that poppin is an unofficial client for their own account rather
than a circumvention tool.
