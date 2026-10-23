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

4. The footer (in the starter, the `VisionFooter` aside, which is always dark):

   ```astro
   ---
   import PrivacyLinks from '@visionmediahq/astro-consent/components/PrivacyLinks.astro'
   ---
   <PrivacyLinks class="text-white/70" />
   ```

5. `src/data/privacy.json`

   ```json
   { "services": ["google-maps"], "policy_url": "https://kund.se/integritet" }
   ```

## `src/data/privacy.json`

| Field | Required | Meaning |
|---|---|---|
| `services` | yes | Registry slugs the site uses: `google-maps`, `google-calendar` (ConsentEmbed), `elfsight` (ConsentWidget), `google-analytics`, `google-ads`, `meta-pixel`. An empty list gives notice mode. |
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

### `<ConsentWidget>`

Click-to-load for widgets that need a `<script>` (Elfsight). Same placeholder, one-off "Visa" and
"Visa alltid innehåll från …" as `<ConsentEmbed>`; the script is requested only once the visitor activates the
widget, and only once per page.

```astro
---
import ConsentWidget from '@visionmediahq/astro-consent/components/ConsentWidget.astro'
---
<ConsentWidget service="elfsight" script="https://elfsightcdn.com/platform.js" title="Vårt Instagramflöde">
  <div class="elfsight-app-<id>" data-elfsight-app-lazy></div>
</ConsentWidget>
```

- `script` must be `https:` on the service's own host, or the build fails.
- Do not put a `<script>` in the slot (the build fails); pass its URL as `script`.
- `id` is an optional element id.
- `minHeight` (default `12rem`) sizes the placeholder only.
- The checks fail the build on prerendered pages. On SSR pages they cannot, so the request fails with a 500.
- Google Calendar is a `<ConsentEmbed>` (service `google-calendar`); its button reads "Visa Google Kalender".

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
- **Not handled by this package:** scripts from jsdelivr and reCAPTCHA still load on sites that
  use them. Google Fonts are not the banner's job either: the rollout tool self-hosts them on the
  site itself (`wire` does by default, `fonts` for a site already live; see "Rollout tool").
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
npx tsx ci/rollout/run.ts wire   <site dir> [--dry-run] [--no-fonts]
npx tsx ci/rollout/run.ts fonts  <site dir> [--dry-run]   # Google Fonts alone, on branch fonts-selfhost
npx tsx ci/rollout/run.ts fonts-files <site dir> --url <css/css2 url> [--entry <css file>] [--dry-run]   # files only, see below
npx tsx ci/rollout/run.ts verify <site dir>
npx tsx ci/rollout/run.ts verify --demo <dist dir>      # a built demo, no git/npm/Docker
npx tsx ci/rollout/run.ts pr     <site dir> --shots-dir <path> --shots-base <url> [--issue <url>]...
npx tsx ci/rollout/run.ts live   <site dir> baseline | post-merge [--sha <merge commit>]
npx tsx ci/rollout/run.ts merge  <site dir> <pr number>
npx tsx ci/rollout/run.ts help
```

- `detect` reads the site and writes the report; `wire` plans every edit and either prints the
  diff (`--dry-run`, writes nothing) or applies it all on branch `consent-banner`: one commit for
  the banner and, when the site loads Google Fonts the tool can self-host, a second one for them
  (`--no-fonts` skips it; below);
  `verify` runs the build and browser checks; `pr` opens the PR; `live baseline` records the live
  site before the merge; `merge` re-verifies if `main` moved, merges, waits for Coolify and runs
  `live post-merge`.
- **Flows.** `verify`, `pr`, `merge` and `live` read the clone's current branch and run its flow
  (`FLOWS` in `ci/rollout/flows.ts`); any other branch is refused. `consent-banner` (from `wire`):
  the banner, plus the fonts commit unless `--no-fonts`. `fonts-selfhost` (from `fonts`): the
  Google Fonts commit alone, for a site whose banner is live. Each flow has its PR title and body
  (`pr-body.sv.md`, `pr-body.fonts.sv.md`) and its verify steps. One flow at a time per site:
  `wire` refuses while origin has a `fonts-selfhost` branch main does not contain or an open
  `fonts-selfhost` PR, `fonts` the same for `consent-banner`, and `pr` and `merge` refuse the
  same (the other flow's unmerged branch on origin or open PR).
- **State** lives in `<site dir>/.rollout/`: `report.json`, and per flow `verify.json`,
  `pushed.txt`, `evidence/`, `shots/`, `pr-body.md`, `live-baseline.txt`,
  `live-baseline-hosts.json`, `apps.json` and `live-<mode>.json`. `consent-banner` uses exactly
  these names (the operator's scripts read them); `fonts-selfhost` adds its branch to each
  (`verify-fonts-selfhost.json`, `evidence-fonts-selfhost/`, …), so a fonts run never reads or
  overwrites the banner's. `detect` adds `.rollout/` to the checkout's `.git/info/exclude`, so
  stages can be rerun one at a time and nothing of it is committed. `verify --demo` writes to a
  temp folder.
- **Tool commit.** `report.json`, every `verify*.json` and every `live-*.json` record `tool:
  { sha, dirty }`: the HEAD of the astro-consent checkout the tool ran from, and whether its
  tracked files had uncommitted changes (both `null` when git failed; untracked files are ignored).
  `verify` and `live` print it first (`tool: astro-consent @ <short sha>`), each evidence file
  starts with that line, the PR body names it under "Kontroller", and `merge` prints the one of the
  verify it merged on.
- **Exit codes:** `0` ok (for `live baseline` also the expected RED), `1` error, a failed verify
  step or a live/merge STOP, `2` usage, `3` the wire (or fonts) plan was refused (dry run or not; nothing was
  written).
- If `wire` fails after it switched to `consent-banner`, it leaves the checkout uncommitted and
  says how to retry: `git reset --hard && git clean -fd && git switch main && git branch -D
  consent-banner`, or re-clone. It also refuses to commit when anything besides the planned files,
  `package.json` and `package-lock.json` changed.
- After its `npm install`, `wire` puts back the lockfile entries npm pruned that main had and
  nothing requires: marked `optional` (or `devOptional`) on main, and nothing outside them lists
  them as a dependency or a non-optional peer (vite 8 sites still had esbuild 0.28.2 and its
  `@esbuild/*` builds, which vite lists only as an optional peer). It prints what it kept. Any
  other removal is left to `verify` step 1, which refuses it.
- `verify` checks the working tree but records the result for `HEAD`, so it refuses uncommitted
  or untracked files: commit, then rerun. If its own `npm ci` or build leaves files behind, it
  fails a final `clean` step: add them to the site's `.gitignore` on the branch. It never pushes over a `consent-banner` on GitHub that it
  did not push itself, and `wire` refuses to start when origin already has that branch; `pr`
  refuses an open PR from it with another title. Find out whose it is and clean up by hand.
- `verify` step 1 allows only astro-consent's own lockfile entries, the root's dependency on it and
  the `ALLOWLIST` in `ci/rollout/lib/lockfile.ts`. Root fields npm copies from `package.json`
  (`name`, `version`, `engines`, `license`, `bin`, `funding`) may change only to exactly the branch
  `package.json`'s value: main's lockfile was stale (another `engines`, astro-starter's `name`) and
  npm resynced it. daisyUI 5 (`REQUIRED`) may be added to `dependencies` where main had none: the
  banner needs it, so a site without it gets it in its own commit (a client site). daisyUI's base
  styles then reach the whole site, so add it like this, with the primary set to the site's colour:

  ```css
  @plugin "daisyui" { themes: light --default; exclude: scrollbar; }
  @plugin "daisyui/theme" {
    name: "light";
    default: true;
    --color-primary: #1B4070;
    --color-primary-content: #FFFFFF;
  }
  /* daisyUI paints :root with --root-bg (white); keep the site background */
  :root { --root-bg: var(--color-surface-0); }
  ```

  `exclude: scrollbar` keeps daisyUI's `scrollbar-color` off `:root`, which restyles every
  scrollbar on Windows and Linux. `--root-bg` takes the variable behind the site's own page background.
- For server output, `verify` finds pages by crawling links from `/` and the sitemap. A linked path
  that answers 2xx with anything but HTML (an endpoint serving a PDF without an extension) is a
  file, not a page. A broken link is still checked. Links under `/cdn-cgi/` are skipped: Cloudflare answers
  those itself (email obfuscation), so they never have the banner.
- The browser checks open each page up to its `load` event, then wait up to 10 s for the network to
  go quiet. A looping background video, polling or a websocket never lets it, so the checks carry on.
- `verify` step 5 also hit-tests every visible banner button at each width: if something else is on
  top of it (a site's fixed mobile call bar), the button is reported as covered.
- `verify` step 5 also compares the computed `scrollbar-color`, `scrollbar-width`,
  `scrollbar-gutter` and `background-color` of `html`, and `body`'s background, on `/` with main. Any
  difference fails: it shows on every page, and the screenshots cannot show a scrollbar (a client site).
  A page that scrolls sideways fails only if it is wider than on main at that width, so a site's
  own overflow is noted with main's width, not blamed on the banner.
- `verify` step 5 also measures each embed placeholder against the registry iframe it replaced on
  main, paired per service in page order, at 360 and 1280 px: a placeholder more than 10 % shorter
  fails (a client site: an in-flow wrapper in a padding-ratio box left the map 320px tall with an
  empty band below). Where main and the branch have different counts of a service on a page (a map
  main built in a script) that service is noted, not compared.
- `verify` step 6 measures the placeholder of every embed that has not loaded too: its info text,
  Visa button, "Visa alltid" label and "Öppna i" link. A dark theme that sets `--color-base-content`
  but not `--color-base-200` leaves light text on the light placeholder (a client site, about 1.2:1).
  `live post-merge` runs the same contrast check, so live sites are measured as well.
- A background that is one gradient of colours (a client footer: two brand blues) is
  measured, not reported indeterminate. Each segment between two stops is searched for its worst
  point (a grid, refined around every local minimum), alpha composited over what is beneath:
  `5.25:1 ok (gradient, worst stop)`. sRGB segments are interpolated by the tool; any other method
  (`in oklch`, `in hsl longer hue`, the oklab default for oklch stops) is mixed by the page with
  `color-mix()` in the same method, and the line names it. Several gradients that show
  (a faint radial glow over a dark linear gradient, seen on a client footer) are bounded:
  bottom-up, per channel, the lowest and highest value each layer can composite to over the range
  below it (its stops; in another method, the extremes of the page's mixes, found by the same
  sampled search; and the range below wherever the layer has translucent stops or may not cover
  the box), then the text against the worst point of that range. Each layer other than an opaque
  colour or an opaque sRGB gradient that covers the box widens the range by one 8-bit level past
  rounding outward: the canvas reads colours back in 8 bits (alpha 0.15 as 38/255 = 0.149) and the
  page rounds each layer it paints. That client footer's lightest point is 8.70:1; its line reads
  `8.50:1 ok (2 gradients, bound over all stops)`. Compositing and luminance only grow with each
  channel, so with sRGB layers the bound is not above any pixel the page paints; with another
  method it is as good as the sampled search for each segment's extremes. A brute-force unit test
  checks it against random stacks. A `url()` image that shows, or a stop or mix the page cannot
  resolve stays indeterminate. One gradient and plain colours report the worst point as read,
  which is exact for opaque text on opaque colours. Chromium dithers a gradient per channel, a level
  off the mix between two stops (never outside their range), and rounds each translucent layer or
  text it blends, so the painted pixel can be a level or more past that point (near 4.5, about 0.1
  in the ratio with several layers). So `ok`
  allows for that (#96): the point is widened by a level per translucent layer and one for a
  gradient, translucent text's own blend by one more (over several gradients too), and text that
  passes only without that margin reads `4.53:1 FAIL (within the 8-bit margin of 4.5)`. The ratio
  and colours shown do not move. The margin is strict: most rows it fails at 4.50–4.62 paint just
  above 4.5.
- Effects the colours do not show are indeterminate: `background-blend-mode`, `background-clip:
  text`, `opacity` on an element with a background or above it, `mix-blend-mode` or a filter that
  changes something (`grayscale(0)` does not) on the text or any ancestor, and `backdrop-filter`
  below the first opaque background. Opacity on the text or a background-less wrapper (`opacity-70`
  on the links) fades the text colour and is measured.
- A positioned `::before`/`::after` that paints (a background colour or image, a visible border, or a
  `backdrop-filter`), on the text or any ancestor, counts only when its box overlaps the text's
  (a client footer's 1px hairline and a width-0 link underline do not). A `box-shadow` with a
  visible colour (Tailwind's resting `0 0 #0000` is not), an outline, a filter that changes
  something (drop-shadow, blur) or any `content` other than `""` (text, glyphs, a url() image)
  reaches outside the box and always counts. A fixed one counts on any horizontal overlap, wherever
  the text is scrolled. Its box is computed when its containing block is its own element
  (positioned, not scrolled, not an inline element broken over lines, and neither it nor any
  ancestor scaled, rotated, zoomed or on an `offset-path`) or the viewport (fixed, no ancestor with a
  transform, `translate`, `scale`, `rotate`, `zoom`, `offset-path`, any filter, `preserve-3d`,
  `contain`, `content-visibility` or a matching `will-change` capturing it); any other containing
  block, a transform, individual transform property, `zoom` or `offset-path` on the pseudo-element,
  or `direction: rtl` on it is indeterminate.
- Pseudo-elements that do not count: faint feTurbulence grain (a client site's fixed `body::after`: an SVG
  whose every shape is drawn through a filter, with no other paint), while the grain opacities on a
  row's path add up to 0.2 or less; and a negative z-index above the opaque background with no
  z-index on or between them, which paints beneath it. The grain exemption is a bounded error, not
  proof: up to 0.2 of white grain over a background can lift or lower a borderline ratio (white text
  on #767676 measures 4.54:1 ok under 0.2 white grain that brightens it), so a row within a few
  hundredths of 4.5 on a grain site deserves a look at the screenshot. A higher z-index around the text is not taken as proof that it paints above a
  pseudo-element: a solid fixed overlay counts even under the z-99 banner. Scrolling elsewhere is
  already in both boxes; the pseudo-element's own element scrolled is indeterminate.
- The contrast step scrolls each page through and back (as step 3 does) and waits for finite
  animations to finish: the starter's `[data-animate]` is `opacity: 0` until Motion's `inView` fades
  it in, and about 25 sites wrap an embed in one. An opacity animation still running on the text or
  an ancestor gets one more wait (5 s) and a second reading; after that the row is `animation not
  settled`.
- `verify` stops before any step when the disk holding the site has less than 15 GB free
  (`ROLLOUT_MIN_FREE_GB` changes the threshold; demo mode skips it). Each verify runs `npm ci` and a
  build twice and builds a Docker image, and Docker failed with I/O errors at 2.5 GB free during the
  expansion. After a passing `live post-merge` (which `merge` runs), the tool deletes the clone's
  `node_modules` and `dist`; a stop keeps them for the next verify.
- `verify` serves on three local ports: the Docker container on 4397, main's preview on 4398, the
  branch's on 4399. `ROLLOUT_PORT_BASE` moves all three (e.g. `4417` → 4417–4419), so two verifies
  can run on one machine at once with bases at least 3 apart. A value that is not a port from 1024 to
  65533 stops verify before any step rather than falling back to 4397. The two runs still share CPU
  and disk: each needs the free space above.
- If main's local preview stops answering mid-step (a dropped connection, and nothing answers on
  its port), `verify` restarts it once and checks main again. The step output, the verify file
  (`restarts`) and the summary say so. A second drop, any other error, or a crash of the branch's
  preview fails the step: a branch crash may be the wiring's doing.
- Docker I/O errors (`input/output error`, `unable to lease content`): free disk first, then restart
  Docker fully (`docker desktop restart`, or quit Docker Desktop from its menu and start it again).
  No image or volume purge is needed. If a pull still fails, `docker pull` the base image by
  hand once, then rerun verify.
- `verify` step 9 builds the site's Dockerfile with `--build-arg SITE_URL=https://<first domain>`,
  as Coolify passes it: a Dockerfile with `ENV SITE_URL=$SITE_URL` otherwise builds with an empty one.
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
- **Classification and services.** `detect` classifies a site `consent`, `notice` or `needs-human`
  (older stored reports with `maps` still load as `consent`) and lists what it found in
  `report.services` (resolved iframe services such as maps and google-calendar, and elfsight; never trackers, which are a needs-human reason, though a registry service the batch does not wire may appear while the site is needs-human) and `report.widgets`. `wire` writes
  `src/data/privacy.json` from `report.services`; an existing `privacy.json` that lacks one of them
  is refused. Pool rows without `services` are re-detected, and `select` strata are
  `consent`/`notice`.
- **Verify on the two flows.** The steps keep their numbers in both flows: 1 lockfile, 2 build,
  3 requests, 4 consent-paths, 5 clip, 6 contrast, 7 screenshots, 8 fonts, 9 docker. On
  `fonts-selfhost`, 4 and 6 (banner only) are recorded as skipped; step 1 requires `package.json`
  and `package-lock.json` to be exactly main's and allows only the files the fonts commit writes or
  edits (`src/styles/fonts.css`, `public/fonts/**`, the CSS entry, and the files `report.fonts`
  found the loads and CSPs in). A site without the banner on main expects no banner, skips 5,
  and in step 3 notes the registry requests main makes on the same page instead of failing them
  (they are the site's own; any other still fails).
  Step 8 runs on `fonts-selfhost`, and on `consent-banner` whenever the branch has the tool's
  `src/styles/fonts.css` (else it is skipped):
  - no `fonts.googleapis.com` / `fonts.gstatic.com` anywhere in the built `dist/` outside CSS
    and HTML comments (fonts.css's own header names the css2 URL);
  - every page at 360 and 1280 px with every Google Fonts request aborted and counted: none may be
    attempted, and every `/fonts/*.woff2` must answer 200. A CMS admin shell (`/admin`,
    `/admin/…`) is left out and listed as skipped, here, in step 9 and live: its editor (Sveltia
    CMS from unpkg on a client site) loads Google Fonts for its own UI, which visitors never get;
  - every family of fonts.css a visible element renders with has the face CSS font matching picks
    for its weight and style loaded in `document.fonts` (compared with fonts.css, not main: main
    cannot load its fonts with Google blocked);
  - every character the pages show in a family of fonts.css (DOM text, hidden elements included)
    falls in that family's kept unicode-ranges. Verify asks Google's css2 URL (from the header, by
    the tool, not the browser) which ranges Google has: a character no face of Google's has is
    noted, not failed (main showed a fallback too). If that request fails, every uncovered
    character fails. The failure lists the characters and the family. Characters in the strings
    of the shipped JS and JSON (checked in `/`'s body family) are only noted: a library string
    may never be shown, and wire could not change it.
  Step 9 also runs step 8's request check at 1280 px against the container.
  `tests/unit/rollout/fonts-fixtures.demo.ts` (CI e2e job) holds the browser negative controls.
- **Live with the fonts.** `live post-merge` checks, when the merged main has the tool's fonts.css,
  every page of every domain at 360 and 1280 px for zero Google Fonts requests (counted, never
  blocked live), every `/fonts/*.woff2` 200 and every face used loaded, on top of the banner
  checks. On `fonts-selfhost` the banner checks run when main has the package, otherwise only the
  fonts and console errors are checked. `live baseline` checks the fonts too when origin/main
  already has them, and stops if a host fails. `merge` works the same on both flows (the flow's
  verify file, apps recorded per flow, squash, branch deleted, live post-merge).
- **Fonts for a generated site (`fonts-files`).** site-factory's Builder generates new sites, so
  there is no detect report, git branch or markup to cut. `fonts-files <site dir> --url <css or
  css2 URL> [--entry <css file>] [--dry-run]` runs only the fetching half of the plan above and
  writes `public/fonts/*.woff2`, the licences and `src/styles/fonts.css`, byte for byte what `wire`
  writes for the same URL and site text. With `--entry` it adds `@import "./fonts.css";` after
  `@import "tailwindcss"` in that stylesheet; nothing else is edited. An old `css?family=A:400|B`
  URL works as well as `css2`. Refusals (not a Google Fonts URL, `fonts.css` or `public/fonts/`
  already there, a failed request, a missing licence, an entry without exactly one
  `@import "tailwindcss"`, an `--entry` that is absolute or contains `..`) exit 3 and write nothing.
  An IO error (read-only folder or entry, full disk) exits 1 and also leaves nothing behind: the
  font and licence files are written first, `fonts.css` and the entry last, and on any failure
  every file and folder the run created is removed and the entry restored byte for byte, so a
  rerun is never blocked by "already exists". It is also runnable alone:
  `npx tsx ci/rollout/fonts-files.ts ...`. Its imports are node built-ins and relative files only
  (`wire/fonts-host.ts`, `wire/css-imports.ts`, `wire/fonts-css.ts`, `lib/site-files.ts`,
  `wire/engine.ts`, `lib/is-entry.ts`), so a checkout of this repo plus `tsx` is enough, with no `npm install` here;
  `tests/unit/rollout/fonts-files.test.ts` pins that list. Do not add a package import to those files.
- **Self-hosting Google Fonts (`wire`, `fonts`).** When `report.fonts.status` is `wire`, `wire`
  adds a second commit on `consent-banner` ("feat: Google Fonts från sajten själv (self-hosted)")
  unless `--no-fonts`, and a refused fonts plan refuses the whole wire (`--no-fonts` wires the
  banner alone). For a
  site whose banner is already live, `fonts <site dir>` makes the same commit alone on a new branch
  `fonts-selfhost` from origin/main (same checks as `wire`: clean checkout at origin/main, no such
  branch locally or on origin). It also refuses while origin has a `consent-banner` branch that
  main does not contain, or an open `consent-banner` PR: the two would conflict. Everything is
  planned before anything is written. A fresh detect must reproduce `report.fonts` exactly (the
  edits cut at its offsets), otherwise: run `detect` again. A failed request, an unexpected answer,
  an existing `src/styles/fonts.css` or `public/fonts/`, or an edited file that changed on disk
  since planning refuses the whole plan (exit 3). What it does:
  - fetches the css2 URL once with a pinned Chrome User-Agent (`CHROME_UA` in `wire/fonts.ts`),
    so Google answers with woff2 and a unicode-range per subset; anything else is refused;
  - keeps `latin` and `latin-ext`, plus any other subset whose unicode-range covers a character in
    the site's `src/` (literal, HTML entity, JS or CSS escape) that the same family's latin and
    latin-ext do not:
    the only faces a browser could have fetched from Google (an arrow `→` keeps Open Sans
    `symbols` and `math`);
  - writes each woff2 once (a variable font serves several weights) as
    `public/fonts/<family>-<style>-<weight>-<subset>-<sha256:8>.woff2`, each family's licence as
    `public/fonts/LICENSE-<family>.txt` (google/fonts' `ofl/<family>/OFL.txt`, else
    `apache/…/LICENSE.txt` or `ufl/…/UFL.txt`, copyright line included), and
    `src/styles/fonts.css`: a header naming the URL, the date, the subsets and the licences, then
    Google's `@font-face` blocks verbatim with local urls (`font-display: swap` added where absent);
  - adds `@import "./fonts.css";` right after `@import "tailwindcss"` in `report.css.entry`;
  - removes every location as whole lines, leaving no double blank line. A one-line comment right
    above that starts with a fonts phrase ("Google Fonts", "Fonts: …", "Typography: …",
    "Typsnitt"; HTML, or `//` above the const) goes with it; a multi-line comment or one that only
    mentions fonts stays. A `// note` after the const on its line goes with the const;
  - cuts `fonts.googleapis.com` / `fonts.gstatic.com` source tokens from each CSP, refusing if a
    directive (split on `;`, then whitespace) would be left with no source.
- **Google Fonts detection.** `detect` also writes `report.fonts`, separate from the
  banner: it never changes `classification` or `reasons`. `status` is `wire` for literal `fonts.googleapis.com/css2` URLs loaded
  only by `<link rel="stylesheet">`, `<link rel="preload" as="style">` (any attribute order, split
  over lines, `media="print" onload`), a `<noscript>` holding only such links, a frontmatter
  `const` used only as their `href`, or a CSS `@import`, plus preconnect/dns-prefetch links;
  `locations` lists each element or statement with its offsets, `url` the URL. Several URLs (a
  page with its own `<link>`, say) become one when `mergeCss2` can join them: the same `display`
  and other parameters, and per family the same axes (a family without `ital` joins one with it as
  `ital` 0), its tuples unioned and sorted, a range only beside the same range; a URL that is
  not `https://fonts.googleapis.com/css2` is not joined; `urls` keeps
  every URL found. `csp` lists every
  CSP that mentions the Google hosts (a `<meta http-equiv>`, a `_headers` line, a module's directive
  strings). `self-hosted`: no Google reference but local font files, `@font-face`, `@fontsource` or
  the Astro `fonts` config; `none`: neither. Everything else is `needs-human` with `reasons`: an
  expression or env-built URL, several URLs that cannot be joined, the css v1 or icon APIs, `text=`, any other mention
  outside comments (a module string that is not a bare CSP source token, a `<script>`, a data
  file, `public/`, `.env*`, and `.astro`/CSS/module files anywhere outside `node_modules`,
  `dist`, `.astro`, `.rollout` and `scout/`, and `.md`/`.mdx` under `src/` or `public/`, or
  elsewhere when the site can build them: their top folder (a root file: its name) is a
  `glob()` loader's base or is named anywhere in the files read (an import, a path), or a glob
  may reach the project root (loader options not written inline, a computed or `${…}` base,
  base `.` or none with a pattern not starting in a folder, `glob` imported under another name;
  an `import.meta.glob` (type argument or not) whose one literal pattern does not resolve inside
  `src/`; `..` in a loader base or pattern, or `...` in its options), or a built `.mdx` imports it.
  So `docs/`, `README.md` or `CLAUDE.md` that nothing builds are not read. Not seen: a loader
  called under another variable name, or code walking the project itself (`fast-glob`,
  `readdirSync`); verify's request check still covers the built pages), the Web Font Loader (its script or
  `WebFont.load`) or a font-loading dependency (`webfontloader`, `unplugin-fonts`, `astro-font`,
  `*google-fonts*`), an Astro `fonts` config, an existing `src/styles/fonts.css` or `public/fonts/`,
  a CSP whose `font-src` or `style-src` (or `default-src`) lacks `'self'`, or a file with a
  stylesheet location whose relative value imports (followed through `.astro` files and
  modules; not aliases, not `import type`) never reach the Tailwind entry, the Web Font Loader by `WebFontConfig` or its script from any CDN, and
  an `@import` after another rule (browsers ignore it). Every CSP found (meta, `_headers`, each
  module directive string on its own) is checked for `'self'` in `font-src` and `style-src` (else
  `default-src`), whether it names Google or not; `*.googleapis.com`/`*.gstatic.com` count as
  mentions. A file with a NUL byte is binary and skipped, unless it names a Google host (a reason).
  Not read: CSPs in `netlify.toml`, `vercel.json` or nginx config; HTML-entity-encoded hosts;
  symlinks; `dist/` and `.astro/` at any depth; `.html`, `.json`, `.yaml` and `.scss` files outside
  `src/` and `public/`. A `<link>` inside a `<template>` is treated like any other.
- **Script-built embeds.** A Maps or Calendar embed URL (`/maps/embed…`, `/maps/d/embed`,
  `output=embed`, `/calendar/embed`, `/calendar/u/0/embed`) outside an `<iframe>`, in a `<script>`
  or in an HTML element's attribute (``data-map-src={`…&output=embed`}``; not `href`, not a
  component prop), is a home-made click-to-load that ignores the banner: the site is needs-human
  with `script-built embed google-maps in <file> (<attribute> | script)`, for a person to rewire as
  a `ConsentEmbed` (two client sites). When the URL comes through a variable
  (`data-src={mapSrc}`), a `.astro` file whose `<script>` calls `createElement('iframe')` gets
  `(createElement)` if a Maps or Calendar host and an embed marker appear anywhere in the file
  (outside literal `<iframe>` tags) or in a relative non-`.astro` module it imports, even split
  over several literals (two client sites). Other registry URLs in a script stay
  `tracker <service>`.
- **Elfsight.** Recognised only as one loader `<script>` (`https://elfsightcdn.com/platform.js` or
  `https://static.elfsight.com/platform/platform.js`; other attributes only `async` and `is:inline`)
  plus one or more empty `<div class="elfsight-app-<uuid>">` (other attribute only
  `data-elfsight-app-lazy`) in the same `.astro` file. `wire` wraps each div in `<ConsentWidget
  service="elfsight" script=… title="Innehållet">`, removes the site's loader script, and installs
  `^1.1.2`. A `Content-Security-Policy` line in `public/_headers` is not a load and is left alone.
- **Refused as `needs-human`.** Every other Elfsight occurrence: a second loader, an inline script,
  an import or package, an env-built class name, a CSS rule, or a mention in any other file under `src/`, `public/` or `astro.config.*` (plus package dependencies and imports). The tool
  strips nothing it cannot prove is a plain widget, because a leftover loader would request Elfsight
  before consent.
- **Calendar iframes.** Google Calendar iframes whose `src` resolves (a literal, a constant, a data
  file, call sites that agree) are wrapped in `<ConsentEmbed service="google-calendar">` like maps;
  a `.map()` or otherwise unresolved `src` sends the site to a human (needs-human, 'unresolved
  iframe src').
- `pr` names each service from `privacy.json` in the PR body, with its "Visa <name>" step. `verify`
  maps each route to the service of the first iframe on it that has a CSS filter, consent-paths measures the filter on the first embed of that service on the page (clicking it after the one-off check when it is not the first embed), and widget pages count as embed pages.
- `ci/rollout/pool.ts` and `ci/rollout/select.ts` scan the site pool and draw the rollout batch;
  their output holds client data and is never committed. `ci/rollout/exclusions.json` lists the
  repos the pool leaves out by numeric GitHub repo ID (`gh api repositories/<id>` names one), so
  that the public repo names no client. The scan resumes where it stopped and
  skips rows it already has; `--rescan` detects every row again (a site can change after its
  scan) and checks again that each repo is Astro. Every row is saved as it is done, but an
  interrupted `--rescan` starts over from the first repo. `select` refuses a pool.json with rows scanned before `Report.services`, naming them: run
  the scan first.

## Releasing

CI green on `main` **including the `starter-install` job** (repo variable `STARTER_INSTALL=true` and
secret `STARTER_READ_TOKEN`), then tag `vX.Y.Z` and push the tag. A pushed tag is live for every site
on `semver:^1.0.0` at its next install. Raise `CONSENT_VERSION` in `src/config.ts`
when the banner wording changes, so every visitor is asked again. Never add a script named `prepare`,
`preinstall`, `install`, `postinstall`, `prepack` or `build`, or a `workspaces` field, to
`package.json`.
