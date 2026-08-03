# Mobbin as a Server-Side Wrapper Target

**Research date:** 2026-08-02
**Scope:** Public, first-party sources and unauthenticated protocol observations only. No account was used; no CAPTCHA, paywall, rate limit, or access control was bypassed.

## Executive conclusion

Mobbin now has an **official public REST API and an official remote MCP server**. The REST API is the best fit for a conventional server-side wrapper: it uses a workspace-scoped API key and is available on Team and Enterprise plans. The MCP server is the better fit when each human user should authorize their own Pro, Team, or Enterprise account: it uses browser-based OAuth with access and refresh tokens. ([official overview](https://docs.mobbin.com/overview), [REST quick start](https://docs.mobbin.com/api/quickstart), [MCP integration guide](https://docs.mobbin.com/mcp/build-an-integration))

Do **not** build the wrapper around Mobbin website cookies or undocumented web-app endpoints. That path is unnecessary now, has no published compatibility or session contract, and creates materially higher Terms of Service and credential-handling risk. Mobbin prohibits unauthorized automated access and account sharing, restricts caching/rehosting, and separately limits API/MCP resale, competitive products, and standalone content repositories. ([Terms sections 3 and 4](https://mobbin.com/terms))

Recommended decision: use the official REST API for one organization's controlled internal agents, or use official MCP OAuth for per-user delegation. In either case, the agent receives only the wrapper's own narrow credential and never a Mobbin password, API key, OAuth token, refresh token, or website cookie.

## Evidence labels

- **Published fact** means Mobbin states it in an official page or contract.
- **Observation** means an unauthenticated response or this repository's existing client code exposed it.
- **Inference** means an architectural conclusion from those facts; it still needs production validation.

## 1. Official API availability

**Published fact:** Mobbin exposes two documented programmatic products:

| Product | Availability | Authentication | Published surface |
| --- | --- | --- | --- |
| REST API | Team and Enterprise | Workspace API key as `Authorization: Bearer ...` | `POST https://api.mobbin.com/v1/screens/search` |
| Remote MCP | Pro, Team, and Enterprise | Per-user OAuth | `https://api.mobbin.com/mcp` over Streamable HTTP |

Sources: [official overview](https://docs.mobbin.com/overview), [REST quick start](https://docs.mobbin.com/api/quickstart), [MCP introduction](https://docs.mobbin.com/mcp/introduction), [OpenAPI 3.1 document](https://docs.mobbin.com/openapi.json).

**Observation:** Unauthenticated calls to both official endpoints returned structured `401 Unauthorized` responses. The MCP response advertised protected-resource metadata through `WWW-Authenticate`; the REST response said the Authorization header was missing or invalid. This is normal protocol enforcement, not a browser challenge. ([MCP endpoint](https://api.mobbin.com/mcp), [REST endpoint](https://api.mobbin.com/v1/screens/search), [protected-resource metadata](https://api.mobbin.com/.well-known/oauth-protected-resource/mcp))

**Conclusion:** The answer to "does Mobbin offer an official public API?" is **yes**. The repository's current description of itself as needing an unofficial website session is outdated relative to Mobbin's current product surface.

## 2. Authentication and lifecycle

### REST API key

**Published fact:** A Team or Enterprise workspace admin creates a key under `Settings > API Keys`; the key is scoped to that workspace, must be kept secret, and is sent as a Bearer token. ([REST quick start](https://docs.mobbin.com/api/quickstart))

**Unknown:** Public docs do not state API-key expiry, rotation, last-used visibility, number of keys, revocation semantics, or whether keys identify a service versus the creating admin. These must not be guessed.

### MCP OAuth

**Published fact:** Mobbin explicitly supports third-party integrations acting for their users. It uses Dynamic Client Registration (RFC 7591), Authorization Code with PKCE `S256`, the `openid` scope, access tokens, and refresh tokens. The user authenticates and consents in a browser; subsequent MCP calls carry the access token as a Bearer token, and the refresh token obtains new access tokens. ([Mobbin integration guide](https://docs.mobbin.com/mcp/build-an-integration), [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591))

**Observation:** Resource metadata currently identifies `https://ujasntkfphywizsdaapi.supabase.co/auth/v1` as the authorization server and only `openid` as a resource scope. Its public metadata advertises authorization-code and refresh-token grants, a dynamic registration endpoint, token endpoint, JWKS, and public/confidential client authentication methods. ([Mobbin resource metadata](https://api.mobbin.com/.well-known/oauth-protected-resource/mcp), [authorization-server metadata](https://ujasntkfphywizsdaapi.supabase.co/auth/v1/.well-known/oauth-authorization-server))

**Published fact:** Users can revoke an MCP client in Mobbin settings, after which the client loses access immediately. ([Mobbin revoke guide](https://docs.mobbin.com/mcp/disconnect))

**Inference:** A wrapper should refresh proactively from the returned `expires_in` or JWT `exp`, serialize refreshes per grant, atomically replace a rotated refresh token, and fall back to reauthorization after `invalid_grant` or a persistent `401`. Supabase documents a default one-hour access token and possible refresh-token rotation, but these are vendor defaults, **not proof of Mobbin's configured lifetime or rotation policy**. ([Supabase OAuth flow documentation](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows), [Supabase session documentation](https://supabase.com/docs/guides/auth/sessions))

### Website login and cookies

**Published fact:** Website login can use social providers, an emailed login link/code, an optional password, or Enterprise SAML SSO. ([Mobbin login help](https://help.mobbin.com/en/articles/691072), [password help](https://help.mobbin.com/en/articles/691136))

**Observation:** Existing repository code imports browser-visible `sb-*` cookies, recognizes chunked Supabase auth cookies, and replays them to an undocumented website endpoint. It reports that stale sessions may produce an empty `200` rather than `401`. This is a local implementation observation, not an official Mobbin contract (`src/cookies.mjs`, `src/session.mjs`).

**Unknown:** Mobbin publishes no exact web-cookie names, access-token lifetime, refresh timing, cookie rotation contract, or supported server-to-server login flow. Its generic Cookie Policy only says essential cookies enable login. ([Cookie Policy](https://mobbin.com/cookie)) Supabase's general session behavior cannot establish Mobbin's actual configuration.

**Conclusion:** Website cookies are bearer credentials containing or representing a user's web session. They should not enter the proposed wrapper or be accepted from an agent.

## 3. Useful wrapper resources and operations

### Supported official operations

**Published fact:** REST currently documents one operation, natural-language screen search. Inputs include `query`, `platform` (`ios` or `web`), mode (`standard` or AI-ranked `deep`), result limit up to 100, image quality, and screen IDs to exclude. Results include screen ID, expiring image URL and expiry timestamp, dimensions when known, app name, platform, and a Mobbin permalink. ([screen search reference](https://docs.mobbin.com/api-reference/screens/search-screens-with-natural-language), [OpenAPI](https://docs.mobbin.com/openapi.json))

**Published fact:** MCP exposes `search_screens`, `search_flows`, and `search_sections`; sections cover website components such as pricing pages and footers. Some clients can render an MCP Apps gallery, but tool results remain usable without that gallery. ([MCP features](https://docs.mobbin.com/mcp/features))

**Published fact:** Mobbin's public site organizes content across mobile apps, web apps, sites, screens, UI elements, and flows, and exposes some public screen pages and collections. ([public Explore page](https://mobbin.com/explore), [sitemap](https://mobbin.com/sitemap.xml)) These public web resources do not imply an additional supported API.

### Recommended wrapper contract

Expose only stable, product-level operations rather than Mobbin's protocol details:

- `searchScreens(query, platform, mode, limit, quality, excludeIds)`
- `searchFlows(query, ...)` when using the MCP adapter
- `searchSections(query, ...)` when using the MCP adapter
- `connectionStatus()` and `disconnect()` for delegated OAuth

Normalize each result to Mobbin ID, type, app/site name, platform, dimensions, short-lived image URL plus expiry, and Mobbin permalink. Preserve Mobbin attribution and expiry rather than proxying results into a permanent local repository.

Do not promise catalog enumeration, app history, collections, comments, bulk download, or full-text extraction: no such REST operations appear in the current OpenAPI document. ([OpenAPI](https://docs.mobbin.com/openapi.json))

## 4. Bot, hosting, browser, and rate constraints

**Observation:** Public responses from `mobbin.com` and `api.mobbin.com` identified Vercel, not Cloudflare. No Cloudflare challenge, CAPTCHA, or browser-integrity challenge was observed on the public pages, metadata, REST 401, or MCP 401. This is a point-in-time observation, not a guarantee about other routes or future controls. ([Mobbin home](https://mobbin.com/), [MCP endpoint](https://api.mobbin.com/mcp))

**Published fact:** `robots.txt` currently allows general crawling but disallows `GPTBot`. The Terms additionally require descriptive user agents, robots compliance, non-disruptive access, and contactability for crawlers, while prohibiting unauthorized automated access and bypassing authentication, security, or rate limits. ([robots.txt](https://mobbin.com/robots.txt), [Terms section 3](https://mobbin.com/terms)) API permission should come from the API/MCP contract, not from `robots.txt`.

**Published fact:** Both REST and MCP allow 60 requests per 60 seconds: REST per workspace and MCP per user. A `429` includes `Retry-After`; Mobbin recommends exponential backoff with jitter. ([rate limits](https://docs.mobbin.com/rate-limits))

**Published fact:** MCP requires a browser only for initial user authentication/consent and can then run over Streamable HTTP. REST requires a human admin to provision the key, but normal calls are server-to-server. ([MCP introduction](https://docs.mobbin.com/mcp/introduction), [REST quick start](https://docs.mobbin.com/api/quickstart))

**Inference:** There is no technical reason for the wrapper to emulate a browser. It should identify itself honestly, enforce a lower internal quota, honor `Retry-After`, and never switch to web scraping when official calls fail.

## 5. Terms, account, and credential risks

This is an engineering reading, not legal advice.

**High risk: web-session replay and caching.** Mobbin prohibits unauthorized bots/scrapers and prohibits transferring, mirroring, caching, archiving, or rehosting retrieved content without prior express written consent. It also prohibits bypassing rate limiting, authentication, and security measures. ([Terms section 3.2](https://mobbin.com/terms)) An undocumented cookie-based wrapper therefore needs express permission even if the user owns the account.

**High risk: shared personal accounts.** Account sharing is strictly prohibited. Pro is individual-use, permits up to three simultaneous devices, and is not shareable with teammates; Team/Enterprise assign individual seats. ([Terms section 4.1](https://mobbin.com/terms), [device-limit help](https://help.mobbin.com/en/articles/8122177), [team invitation help](https://help.mobbin.com/en/articles/692480)) A shared website cookie would look exactly like the prohibited pattern.

**Material limitation: wrapper business model.** API/MCP use is allowed for personal/internal business use or integration into a proprietary product, but access may not be resold, sublicensed, or leased; the product may not compete with Mobbin; and retrieved content may not become a standalone repository or substitute service. If third parties can use a product containing Mobbin material, customer terms must be at least as protective of Mobbin and the integrating customer is responsible for those users. ([Terms sections 3.5 and 12.3](https://mobbin.com/terms))

**Material limitation: AI use.** The Terms prohibit using automated tools to create derivative works, train/test/index/benchmark/improve models, or for other commercial purposes except where the Terms or written consent expressly permit it. The official MCP product is expressly designed for agents, but downstream storage, model training, benchmarking, broad indexing, and commercial redistribution remain outside the safe core. ([Terms sections 3.4-3.5](https://mobbin.com/terms), [official MCP page](https://mobbin.com/mcp))

**Credential risk:** REST keys are workspace-scoped secrets; MCP refresh tokens are delegated credentials capable of renewing access; website cookies expose an interactive user session. Leakage into prompts, tool traces, command lines, logs, analytics, crash reports, or support bundles could enable account use and make the account owner responsible under the Acceptable Use Policy. ([REST quick start](https://docs.mobbin.com/api/quickstart), [Acceptable Use Policy section 2](https://mobbin.com/acceptable-use))

**Decision gate:** For an external, multi-tenant, customer-facing wrapper, obtain written Mobbin approval or an Enterprise agreement before launch. Enterprise explicitly offers custom agreements plus legal, security, and procurement review. ([Enterprise help](https://help.mobbin.com/en/articles/693376))

## 6. Recommended architecture

### Preferred: official REST adapter for internal agents

1. Use a Team/Enterprise workspace with correctly licensed humans.
2. Store the workspace API key only in a managed secret store; inject it into the wrapper process at runtime.
3. Authenticate calling agents to the wrapper with a separate, narrow, short-lived credential and authorize by tenant/user/purpose.
4. Construct the Mobbin Authorization header only in the outbound adapter. Redact request headers and signed image URLs from logs.
5. Enforce per-workspace token-bucket limits below 60/minute, bounded concurrency, request deadlines, `Retry-After`, and jittered backoff.
6. Return normalized results and Mobbin links. Do not persist or rehost images/content without written permission; if transient processing is approved, enforce deletion at or before `url_expires_at`.
7. Keep audit records of actor, operation, query hash or redacted query, result count, status, and cost/rate metadata, but no Mobbin secrets or image payloads.

### Alternative: official MCP OAuth broker for per-user access

1. Register the wrapper dynamically and use Authorization Code + PKCE `S256` with exact redirect URIs and `state`/`nonce` validation.
2. Send the human user, not the agent, through Mobbin's browser consent flow.
3. Store each user's access and refresh tokens encrypted under a per-tenant envelope key; keep token rows inaccessible to agent/tool output.
4. Serialize refreshes per grant and atomically store any rotated refresh token. On revocation or terminal refresh failure, mark the connection disconnected and require the human to reconnect.
5. Translate the wrapper's narrow API into `search_screens`, `search_flows`, and `search_sections`; do not expose a generic MCP pass-through that lets an agent inspect protocol/auth state.
6. Provide a human-visible connection/revocation page and also link to Mobbin's own revocation control. ([Mobbin integration guide](https://docs.mobbin.com/mcp/build-an-integration), [revoke guide](https://docs.mobbin.com/mcp/disconnect))

### Explicit exclusions

- No Mobbin email, password, social-provider credential, magic-link code, API key, OAuth token, refresh token, or cookie in an agent prompt or context.
- No cookie import endpoint, headless login, browser profile reuse, CAPTCHA handling, challenge solving, or fallback scraper.
- No shared Pro account or shared personal OAuth grant across users.
- No durable screenshot mirror, bulk catalog, training corpus, benchmark set, or search index of Mobbin content without written permission.

## 7. Uncertainty and safe validation experiments

| Question | Safe validation experiment |
| --- | --- |
| Which plan and identity model does Mobbin approve for internal agents or an external SaaS? | Send Mobbin a concrete data-flow and user/seat diagram; obtain written confirmation or negotiate Enterprise terms before implementation. |
| REST key expiry, revocation, rotation, ownership, and audit behavior | In an authorized Team sandbox, create a dedicated test key, inspect available metadata, call one documented query, revoke it, and verify the next call returns `401`. Never log the key. |
| Actual MCP access-token lifetime and refresh rotation | With a consenting test user, record only `expires_in`, token fingerprint, and whether a replacement refresh token is returned; test one refresh and then Mobbin-side revocation. Do not decode or retain personal claims beyond the test. |
| MCP tool input/output schemas and costs | Run standard MCP `initialize`, `tools/list`, then one minimal call per documented tool in a paid test account; snapshot schemas, not content. |
| REST/MCP error and rate behavior | Validate documented `400/401/403/429/500` mapping at low volume; do not deliberately flood the service. For `429`, use a Mobbin-approved sandbox experiment or naturally occurring response and verify `Retry-After`. |
| Signed image URL lifetime and allowed handling | Compare `url_expires_at` to actual low-volume availability around expiry, then delete any test artifact. Ask Mobbin whether memory-only processing or short-lived encrypted caching is permitted. |
| Whether one workspace API key may serve multiple internal agents/users | Obtain written clarification covering seats, agent identities, concurrent use, query attribution, and whether each benefiting human needs a seat. |
| Current security/subprocessor posture | Review the public [Trust Center](https://trust.mobbin.com/) interactively and request SOC 2/security materials available with the applicable plan; do not infer controls from the landing page. |

No further website-cookie experiment is recommended: the official API/MCP paths answer the product need, while cookie replay adds policy and security exposure without a supported contract.

## Final assessment

- **Technical fit:** High through official REST; high through MCP when per-user delegation or flow/section search is needed.
- **Website-session fit:** Poor and unnecessary.
- **Security fit:** Good if all Mobbin credentials remain in a server-side broker/secret store and agents receive only wrapper-scoped access.
- **Contract fit:** Plausible for internal/proprietary use, but caching, external multi-tenancy, seats, and commercial exposure require explicit confirmation.
- **Primary unresolved decision:** Choose workspace-owned REST versus per-user MCP OAuth based on who is legally entitled to each query and whether flows/sections are required.

## Primary sources

- [Mobbin documentation index](https://docs.mobbin.com/llms.txt)
- [Mobbin REST quick start](https://docs.mobbin.com/api/quickstart)
- [Mobbin OpenAPI](https://docs.mobbin.com/openapi.json)
- [Mobbin MCP integration guide](https://docs.mobbin.com/mcp/build-an-integration)
- [Mobbin MCP features](https://docs.mobbin.com/mcp/features)
- [Mobbin rate limits](https://docs.mobbin.com/rate-limits)
- [Mobbin Terms of Service](https://mobbin.com/terms)
- [Mobbin Acceptable Use Policy](https://mobbin.com/acceptable-use)
- [Mobbin Privacy Policy](https://mobbin.com/privacy)
- [Mobbin Cookie Policy](https://mobbin.com/cookie)
- [Mobbin robots.txt](https://mobbin.com/robots.txt)
- [Mobbin Help Center](https://help.mobbin.com/)
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization)
- [Supabase OAuth flow documentation](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows)
