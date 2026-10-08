# @visionmediahq/astro-consent

Consent banner, click-to-load embeds and a consent script API for Vision Media's Astro sites.

- Swedish, themed by the site's own DaisyUI theme.
- Nothing from a registered third-party service (Google Maps, Google Analytics, Google Ads, Meta
  Pixel) loads before the visitor agrees, with or without JavaScript.
- No server: the visitor's choice is stored in their browser.
- Sites with no registered services show a short notice with an OK button instead of a consent prompt.

Requires Astro 6 or 7, Tailwind 4 and DaisyUI 5.

## Install

```json
"dependencies": {
  "@visionmediahq/astro-consent": "github:visionmediahq/astro-consent#semver:^1.0.0"
}
```

Run `npm install` on a machine with git, and **commit `package-lock.json`**. Coolify builds run in an
image without git: `npm ci` with a lockfile downloads the package as a tarball, while an install
without a lockfile fails.

## Wire a site

Five edits. (`ci/wire-starter.ts` in this repo applies them to an astro-starter checkout; it is a
repo tool and is not part of the installed package.)

1. `astro.config.ts`

   ```ts
   import consent from '@visionmediahq/astro-consent'

   export default defineConfig({
     integrations: [consent(), sitemap()],
   })
   ```

2. `src/styles/global.css`, after the Tailwind imports, so Tailwind generates the banner's classes:

   ```css
   @source "../../node_modules/@visionmediahq/astro-consent/src";
   ```

3. The layout, once per page, before the footer:

   ```astro
   ---
   import ConsentBanner from '@visionmediahq/astro-consent/components/ConsentBanner.astro'
   ---
   <ConsentBanner />
   ```

4. The footer:

   ```astro
   ---
   import PrivacyLinks from '@visionmediahq/astro-consent/components/PrivacyLinks.astro'
   ---
   <PrivacyLinks class="text-neutral-content" />
   ```

5. `src/data/privacy.json`

   ```json
   { "services": ["google-maps"], "policy_url": "https://kund.se/integritet" }
   ```

## `src/data/privacy.json`

| Field | Required | Meaning |
|---|---|---|
| `services` | yes | Registry slugs the site uses: `google-maps`, `google-analytics`, `google-ads`, `meta-pixel`. An empty list gives notice mode. |
| `policy_url` | no | Absolute http(s) URL of the site's privacy policy. Without it there is no "Läs mer" / "Integritetspolicy" link. |
| `log_endpoint` | no | Absolute https URL. When set, every choice is sent there with `navigator.sendBeacon`. Requires Astro's `site` to be set to the real domain. |

Unknown keys, unknown slugs and invalid URLs fail the build with a message naming the field.

## Components

### `<ConsentBanner />`

No props. Hidden until the runtime decides to show it; never takes focus on its own.

### `<ConsentEmbed>`

```astro
---
import ConsentEmbed from '@visionmediahq/astro-consent/components/ConsentEmbed.astro'
---
<ConsentEmbed
  service="google-maps"
  src="https://www.google.com/maps/embed?pb=…"
  href="https://www.google.com/maps/search/?api=1&query=…"
  title="Karta till oss"
>
  <Fragment slot="placeholder"><p>Storgatan 1, 831 30 Östersund</p></Fragment>
</ConsentEmbed>
```

| Prop | Meaning |
|---|---|
| `service` | Registry slug. Must be listed in `privacy.json`, or the build fails — also when the component is imported under another name. |
| `src` | The embed URL, exactly as the provider gives it. |
| `href` | Optional link to open the content at the provider. Defaults to a link built from `src`: "Embed a map" URLs (`/maps/embed?pb=…`) become a Maps search for the place name in `pb`, or its coordinates when it has no name; classic `output=embed` URLs are de-embedded; Maps Embed API URLs (`/maps/embed/v1/…`) are rebuilt from their parameters without the API key. |
| `title` | Used for the iframe title and the "Visa …" button. |
| `aspect` | CSS aspect-ratio, default `16 / 9`. |
| `id` | Optional element id. |

The iframe stays inert until the visitor clicks "Visa" or has granted the service. **Do not put a
`<script>` in its slots**: Astro runs it regardless. Load scripts through `onConsent` instead. Do not
add preconnect hints or static map images for the provider; they would contact it before consent.

### `<PrivacyLinks class="…" />`

A "Cookie-inställningar" button that reopens the banner, and an "Integritetspolicy" link when
`policy_url` is set. Pass the text colour through `class`.

## Script API

For anything that is not an iframe, such as analytics or the Maps JavaScript API:

```ts
import { hasConsent, onConsent, openSettings } from '@visionmediahq/astro-consent/client'

onConsent('google-analytics', () => {
  // load gtag here
})
```

- `onConsent(target, fn)` runs `fn` now if `target` is granted, otherwise once when it becomes
  granted. Never twice.
- `hasConsent(target)` returns a boolean. Use `onConsent` to load a service; when you gate on
  `hasConsent` instead, the target is still treated as loaded, so a later withdrawal reloads the page
  and clears its cookies.
- A callback that throws does not affect the banner or other callbacks; its error is reported
  asynchronously.
- `openSettings()` shows the banner's settings view.
- `target` is a service slug or a category: `necessary`, `external`, `statistics`, `marketing`.
  It must be one the site declares in `privacy.json` (a listed service, or the category of one).
  Anything else can never be granted: the call logs one console warning and does nothing.

The same functions are on `window.__vmConsent`.

Importing the script API brings its own types: `window.__vmConsent` and `window.umami` are declared,
and the package's source type-checks inside a site's `tsc` or `astro check` without extra setup.

## Events and the stored record

Both events are `CustomEvent`s on `window` with `detail.record`:

| Event | When |
|---|---|
| `vm:consent-ready` | Every page load, once the stored record has been read. `record` is `null` when there is no valid choice. |
| `vm:consent-changed` | After every save. |

The record is stored in `localStorage` under `vm_consent`:

```json
{
  "id": "6f1c0c1e-…",
  "version": "1:a3f9c2",
  "saved_at": "2026-10-02T09:12:00.000Z",
  "choice": "custom",
  "categories": ["necessary", "statistics"],
  "services": ["google-maps"]
}
```

- `choice` is what the visitor answered in the banner: `all`, `none`, `custom`, `notice_ok`, or `null`
  when only an embed's "Visa alltid" has been saved. The banner is shown while it is `null`.
- `services` holds services granted one at a time through an embed's "Visa alltid" checkbox.
- `version` changes when the site's service list or the banner wording changes; a record with another
  version, or older than 12 months, is ignored and the banner asks again.
- With `log_endpoint` set, the beacon body is this record plus `"site": "<hostname>"`.

Each choice also calls `window.umami?.track('consent', { choice })`.

## Behaviour worth knowing

- **Umami is not gated.** It is cookie-free and first-party; the banner text says so.
- **Not handled by this package:** Google Fonts, scripts from jsdelivr and reCAPTCHA still load on
  sites that use them.
- **A one-off "Visa"** loads that one embed for that page view and stores nothing. Declining in the
  banner afterwards keeps it on screen and loads nothing else.
- **Withdrawing** something that is loaded deletes its first-party cookies (`_ga*`, `_gid`, `_gcl_*`,
  `_fbp`) and reloads the page once. Other open tabs reload too.
- **A page without `<ConsentBanner />`** still gets working embeds and the script API.
- **Not supported:** Astro view transitions (`<ClientRouter />`). The runtime sets up the banner and
  embeds once per full page load.
- In `astro dev`, a `<ConsentEmbed>` with an unlisted service is reported in the dev server's
  terminal and the page returns an error.

## Development

See `CLAUDE.md` for the rules and the test commands.

## Rollout tool

`ci/rollout/` is the repo tool that wires a Vision Media site to this package and takes it through
review, merge and a live check. It is **not shipped**: `package.json` `files` is
`["src", "services.json"]`, so sites never install it, and it is not part of any release. Run it
from a checkout of this repo with `npx tsx`:

```bash
npx tsx ci/rollout/run.ts detect <site dir> --domain <host> [--domain <host>]...
npx tsx ci/rollout/run.ts wire   <site dir> [--dry-run]
npx tsx ci/rollout/run.ts verify <site dir>
npx tsx ci/rollout/run.ts verify --demo <dist dir>      # a built demo, no git/npm/Docker
npx tsx ci/rollout/run.ts pr     <site dir> --shots-dir <path> --shots-base <url> [--issue <url>]...
npx tsx ci/rollout/run.ts live   <site dir> baseline | post-merge [--sha <merge commit>]
npx tsx ci/rollout/run.ts merge  <site dir> <pr number>
npx tsx ci/rollout/run.ts help
```

- `detect` reads the site and writes the report; `wire` plans every edit and either prints the
  diff (`--dry-run`, writes nothing) or applies it all on branch `consent-banner` with one commit;
  `verify` runs the build and browser checks; `pr` opens the PR; `live baseline` records the live
  site before the merge; `merge` re-verifies if `main` moved, merges, waits for Coolify and runs
  `live post-merge`.
- **State** lives in `<site dir>/.rollout/` (`report.json`, `verify.json`, `live-baseline.txt`,
  `live-baseline-hosts.json`, `apps.json`, screenshots), which `detect` adds to the checkout's `.git/info/exclude`, so stages
  can be rerun one at a time and nothing of it is committed. `verify --demo` writes to a temp folder.
- **Exit codes:** `0` ok (for `live baseline` also the expected RED), `1` error, a failed verify
  step or a live/merge STOP, `2` usage, `3` the wire plan was refused (dry run or not; nothing was
  written).
- If `wire` fails after it switched to `consent-banner`, it leaves the checkout uncommitted and
  says how to retry: `git reset --hard && git clean -fd && git switch main && git branch -D
  consent-banner`, or re-clone. It also refuses to commit when anything besides the planned files,
  `package.json` and `package-lock.json` changed.
- `verify` checks the working tree but records the result for `HEAD`, so it refuses uncommitted
  or untracked files: commit, then rerun. If its own `npm ci` or build leaves files behind, it
  fails a final `clean` step: add them to the site's `.gitignore` on the branch. It never pushes over a `consent-banner` on GitHub that it
  did not push itself, and `wire` refuses to start when origin already has that branch; `pr`
  refuses an open PR from it with another title. Find out whose it is and clean up by hand.
- `verify` step 1 allows only astro-consent's own lockfile entries, the root's dependency on it and
  the `ALLOWLIST` in `ci/rollout/lib/lockfile.ts`. One more root change is allowed: `engines`, when
  the new value is exactly the branch `package.json`'s (main's lockfile was stale and npm resynced it).
- For server output, `verify` finds pages by crawling links from `/` and the sitemap. A linked path
  that answers 2xx with anything but HTML (an endpoint serving a PDF without an extension) is a
  file, not a page. A broken link is still checked. Links under `/cdn-cgi/` are skipped: Cloudflare answers
  those itself (email obfuscation), so they never have the banner.
- The browser checks open each page up to its `load` event, then wait up to 10 s for the network to
  go quiet. A looping background video, polling or a websocket never lets it, so the checks carry on.
- `verify` step 5 also hit-tests every visible banner button at each width: if something else is on
  top of it (a site's fixed mobile call bar), the button is reported as covered.
- `live baseline` covers `report.domains` and every host of the Coolify apps that follow `main`,
  and records them in `live-baseline-hosts.json`. If `merge` stops because an app that follows
  `main` serves a host the baseline did not record (an app started following `main` since), rerun
  `live <site dir> baseline` and then `merge`. Never re-run `detect` on the wired branch.
- Every check browser answers Umami (any `script[data-website-id]` src, any `/api/send` and any
  non-page URL with `umami` in its host or path) with an empty 204, live included, so the tool
  creates no pageviews or events.
- Coolify is only read, with `COOLIFY_READ_TOKEN` and `COOLIFY_URL` from `~/sites/vision-books/.env`.
- CI runs `verify --demo demo/dist-consent` after the consent demo build, which covers the browser
  checks with every registry and log host stubbed.
- `ci/rollout/pool.ts` and `ci/rollout/select.ts` scan the site pool and draw the rollout batch;
  their output holds client data and is never committed.

## Releasing

CI green on `main` **including the `starter-install` job** (repo variable `STARTER_INSTALL=true` and
secret `STARTER_READ_TOKEN`), then tag `vX.Y.Z` and push the tag. A pushed tag is live for every site
on `semver:^1.0.0` at its next install. Raise `CONSENT_VERSION` in `src/config.ts`
when the banner wording changes, so every visitor is asked again. Never add a script named `prepare`,
`preinstall`, `install`, `postinstall`, `prepack` or `build`, or a `workspaces` field, to
`package.json`.
