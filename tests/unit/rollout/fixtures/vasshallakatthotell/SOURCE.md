# vasshallakatthotell

Copied from the pilot consent PR as test data for `ci/rollout/`. Every file has a `.txt` suffix.

- Repo: `visionmediahq/vasshallakatthotell` (private)
- PR: #32 (squash-merged)
- before_sha: `e7c598e27aba559949797f470c026f6ee3377da1` (first parent of the merge commit)
- merged_sha: `ad40778a56c69ffb99265bb0f3635e6d86c01441`

`src/components/OmOssContent.astro` holds a `<footer>` inside a `<blockquote>`: not a site footer.

## Files

Copied as they are, except as noted:

- `astro.config.ts`
- `package-lock.json` (only `lockfileVersion` and the `packages` entries for astro, tailwindcss, daisyui, zod, lightningcss* and @visionmediahq/astro-consent)
- `package.json` (only `dependencies` and `devDependencies`)
- `src/components/ContactSection.astro` (reduced, see below)
- `src/components/Footer.astro`
- `src/components/OmOssContent.astro` (reduced, see below)
- `src/components/VisionFooter.astro`
- `src/data/privacy.json` (merged only: added by the PR)
- `src/layouts/Base.astro`
- `src/pages/404.astro`
- `src/pages/gdpr.astro` (reduced, see below): the site's policy page, added in Task 15's amendment so detect can find the `/gdpr` route (Ruling 21); the PR left it unchanged
- `src/pages/hitta-hit-kontakt.astro` (reduced, see below)
- `src/pages/index.astro` (reduced, see below)
- `src/pages/om-oss.astro` (reduced, see below)
- `src/styles/global.css`

## Reduced files

Pages and components that hold a footer, an iframe or a map embed, reduced the same way in `before/` and `merged/`: the frontmatter, tags, attributes, `{…}` expressions, comments and `script`/`style` blocks are kept; every text node outside `<footer>`, `<iframe>` and `<ConsentEmbed>` is replaced with `Text.`.

- `src/components/ContactSection.astro`
- `src/components/OmOssContent.astro`
- `src/pages/index.astro`
- `src/pages/gdpr.astro` (a policy page, reduced the same way)
- `src/pages/hitta-hit-kontakt.astro`
- `src/pages/om-oss.astro`

## Replacements

- `src/components/Footer.astro` (before and merged): the owner's name in the copyright line replaced with `Text.`.
- `src/components/OmOssContent.astro` (before and merged): the owner's name in the quote's `<cite>` replaced with `Text.`, and the name in the HTML comment above the quote replaced with "the owner's".
- Kept as business contact details: the business phone number and `info@` address.

## Secret scan

`npx tsx ci/rollout/scan-secrets.ts tests/unit/rollout/fixtures`: 0 hits.

## Detect

`detect(before, 'vasshallakatthotell', ['vasshallakatthotell.se'])`, pinned by `tests/unit/rollout/__snapshots__/detect.test.ts.snap`:

- Classification: `maps`
- Reasons: none
- Trackers: none
- Banners: none
- reCAPTCHA: true
- Already wired: none
