# site-1243335919

Sites are named by GitHub repo ID (`gh api repositories/<id>`).

Copied from the pilot consent PR as test data for `ci/rollout/`. Every file has a `.txt` suffix.

- Repo: GitHub repo ID `1243335919` (private)
- PR: #32 (squash-merged)
- before_sha: `46fb691813d4a757163a74bbd35ffe0790fd1494` (first parent of the merge commit)
- merged_sha: `9409f767b8c4c09c882d9de0f2f3cda72f9a439e`

Two footers (`FooterSag`, `FooterTra`); the portal index (`HomeSplash`) has no client footer, so the PR put PrivacyLinks in a strip above VisionFooter.

## Files

Copied as they are, except as noted:

- `astro.config.ts`
- `package-lock.json` (only `lockfileVersion` and the `packages` entries for astro, tailwindcss, daisyui, zod, lightningcss* and @visionmediahq/astro-consent)
- `package.json` (only `dependencies` and `devDependencies`)
- `src/components/ContactFormSection.astro` (reduced, see below)
- `src/components/FooterSag.astro`
- `src/components/FooterTra.astro`
- `src/components/HomeSplash.astro` (reduced, see below)
- `src/components/VisionFooter.astro`
- `src/data/privacy.json` (merged only: added by the PR)
- `src/layouts/Base.astro`
- `src/pages/404.astro`
- `src/pages/index.astro` (reduced, see below)
- `src/pages/kontakt-sag.astro` (reduced, see below)
- `src/pages/kontakt.astro` (reduced, see below)
- `src/styles/global.css`

## Reduced files

Pages and components that hold a footer, an iframe or a map embed, reduced the same way in `before/` and `merged/`: the frontmatter, tags, attributes, `{…}` expressions, comments and `script`/`style` blocks are kept; every text node outside `<footer>`, `<iframe>` and `<ConsentEmbed>` is replaced with `Text.`.

- `src/components/ContactFormSection.astro`
- `src/components/HomeSplash.astro`
- `src/pages/index.astro`
- `src/pages/kontakt.astro`
- `src/pages/kontakt-sag.astro`

## Replacements

- Business, people's and place names, street addresses, phone numbers, e-mail addresses, domains, social-media handles, map coordinates and calendar IDs are replaced with neutral placeholders (`Exempel …`, `Exempelgatan 1`, `08-123 45 67`, `site-<id>.se`), the same way in `before/`, `merged/` and `expected/`, so the wiring is unchanged. The repo name is `site-<id>`.
- Business, people's and place names, street addresses, phone numbers, e-mail addresses, domains, social-media handles, map coordinates and calendar IDs are replaced with neutral placeholders (`Exempel …`, `Exempelgatan 1`, `08-123 45 67`, `site-<id>.se`), the same way in `before/`, `merged/` and `expected/`, so the wiring is unchanged. The repo name is `site-<id>`.

## Secret scan

`npx tsx ci/rollout/scan-secrets.ts tests/unit/rollout/fixtures`: 0 hits.

## Detect

`detect(before, 'site-1243335919', ['site-1243335919.se'])`, pinned by `tests/unit/rollout/__snapshots__/detect.test.ts.snap`:

- Classification: `maps`
- Reasons: none
- Trackers: none
- Banners: none
- reCAPTCHA: true
- Already wired: none

The map is a component prop (`ContactFormSection.astro`) passed by two pages; every call site resolves to a Google Maps URL, so the iframe is `expression` with `callSites` and the site is `maps`. Both `pb=` URLs are invented (`inventedMaps`), a site finding only.
