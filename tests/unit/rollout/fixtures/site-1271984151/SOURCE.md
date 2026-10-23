# site-1271984151

Sites are named by GitHub repo ID (`gh api repositories/<id>`).

Copied from the pilot consent PR as test data for `ci/rollout/`. Every file has a `.txt` suffix.

- Repo: GitHub repo ID `1271984151` (private)
- PR: #31 (squash-merged)
- before_sha: `68243eb95a921d14176b365056eb900ab9160cd8` (first parent of the merge commit)
- merged_sha: `7c9a0bb2e9e7566578926b7226ac11c0e87a2ae1`

## Files

Copied as they are, except as noted:

- `astro.config.ts`
- `package-lock.json` (only `lockfileVersion` and the `packages` entries for astro, tailwindcss, daisyui, zod, lightningcss* and @visionmediahq/astro-consent)
- `package.json` (only `dependencies` and `devDependencies`)
- `src/components/Footer.astro`
- `src/components/KontaktMap.astro` (reduced, see below)
- `src/components/VisionFooter.astro`
- `src/data/privacy.json` (merged only: added by the PR)
- `src/layouts/Base.astro`
- `src/pages/404.astro`
- `src/pages/index.astro` (reduced, see below)
- `src/pages/kontakt.astro` (reduced, see below)
- `src/styles/global.css`

## Reduced files

Pages and components that hold a footer, an iframe or a map embed, reduced the same way in `before/` and `merged/`: the frontmatter, tags, attributes, `{…}` expressions, comments and `script`/`style` blocks are kept; every text node outside `<footer>`, `<iframe>` and `<ConsentEmbed>` is replaced with `Text.`.

- `src/components/KontaktMap.astro`
- `src/pages/index.astro`
- `src/pages/kontakt.astro`

## Replacements

- Business, people's and place names, street addresses, phone numbers, e-mail addresses, domains, social-media handles, map coordinates and calendar IDs are replaced with neutral placeholders (`Exempel …`, `Exempelgatan 1`, `08-123 45 67`, `site-<id>.se`), the same way in `before/`, `merged/` and `expected/`, so the wiring is unchanged. The repo name is `site-<id>`.
- `src/components/Footer.astro` (before and merged): the second, mobile phone number (the `tel:` href and its visible text) replaced with `070-000 00 00`; it may be a person's own number.

## Secret scan

`npx tsx ci/rollout/scan-secrets.ts tests/unit/rollout/fixtures`: 0 hits.

## Detect

`detect(before, 'site-1271984151', ['site-1271984151.se'])`, pinned by `tests/unit/rollout/__snapshots__/detect.test.ts.snap`:

- Classification: `needs-human`
- Reasons:
  - unresolved iframe src in src/components/KontaktMap.astro
  - existing banner: home-made gate: localStorage 'maps-consent' in src/components/KontaktMap.astro
- Trackers: none
- Banners: `home-made gate: localStorage 'maps-consent' in src/components/KontaktMap.astro`
- reCAPTCHA: true
- Already wired: none

The map iframe has no `src`: a script sets it after a home-made `localStorage` consent click, so the iframe is `unresolved` and the gate is an existing banner. The `pb=` URL is invented (`inventedMaps`), a site finding only.
