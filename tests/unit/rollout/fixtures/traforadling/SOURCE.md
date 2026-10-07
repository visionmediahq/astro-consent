# traforadling

Copied from the pilot consent PR as test data for `ci/rollout/`. Every file has a `.txt` suffix.

- Repo: `visionmediahq/traforadling` (private)
- PR: #32 (squash-merged)
- before_sha: `46fb691813d4a757163a74bbd35ffe0790fd1494` (first parent of the merge commit)
- merged_sha: `9409f767b8c4c09c882d9de0f2f3cda72f9a439e`

Two footers (`FooterLevene`, `FooterSkaraborg`); the portal index (`HomeSplash`) has no client footer, so the PR put PrivacyLinks in a strip above VisionFooter.

## Files

Copied as they are, except as noted:

- `astro.config.ts`
- `package-lock.json` (only `lockfileVersion` and the `packages` entries for astro, tailwindcss, daisyui, zod, lightningcss* and @visionmediahq/astro-consent)
- `package.json` (only `dependencies` and `devDependencies`)
- `src/components/ContactFormSection.astro` (reduced, see below)
- `src/components/FooterLevene.astro`
- `src/components/FooterSkaraborg.astro`
- `src/components/HomeSplash.astro` (reduced, see below)
- `src/components/VisionFooter.astro`
- `src/data/privacy.json` (merged only: added by the PR)
- `src/layouts/Base.astro`
- `src/pages/404.astro`
- `src/pages/index.astro` (reduced, see below)
- `src/pages/kontakt-levene.astro` (reduced, see below)
- `src/pages/kontakt.astro` (reduced, see below)
- `src/styles/global.css`

## Reduced files

Pages and components that hold a footer, an iframe or a map embed, reduced the same way in `before/` and `merged/`: the frontmatter, tags, attributes, `{…}` expressions, comments and `script`/`style` blocks are kept; every text node outside `<footer>`, `<iframe>` and `<ConsentEmbed>` is replaced with `Text.`.

- `src/components/ContactFormSection.astro`
- `src/components/HomeSplash.astro`
- `src/pages/index.astro`
- `src/pages/kontakt.astro`
- `src/pages/kontakt-levene.astro`

## Replacements

None. The contact details in these files are the business's own.

## Secret scan

`npx tsx ci/rollout/scan-secrets.ts tests/unit/rollout/fixtures`: 0 hits.

## Detect

`detect(before, 'traforadling', ['traforadling.se'])`, pinned by `tests/unit/rollout/__snapshots__/detect.test.ts.snap`:

- Classification: `maps`
- Reasons: none
- Trackers: none
- Banners: none
- reCAPTCHA: true
- Already wired: none

The map is a component prop (`ContactFormSection.astro`) passed by two pages; every call site resolves to a Google Maps URL, so the iframe is `expression` with `callSites` and the site is `maps`. Both `pb=` URLs are invented (`inventedMaps`), a site finding only.
