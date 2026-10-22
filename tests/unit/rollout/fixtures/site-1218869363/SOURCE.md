# site-1218869363

Sites are named by GitHub repo ID (`gh api repositories/<id>`).

Copied from the pilot consent PR as test data for `ci/rollout/`. Every file has a `.txt` suffix.

- Repo: GitHub repo ID `1218869363` (private)
- PR: #12 (squash-merged)
- before_sha: `bd855040023d1f794f373782695817faa1860102` (first parent of the merge commit)
- merged_sha: `ed4e50d5a9b5cb65b4b0dbe2480e599f15469c41`

The map URL lives in `src/data/kontakt.json`; the primary colour in `src/styles/tokens.css`.

## Files

Copied as they are, except as noted:

- `astro.config.ts`
- `package-lock.json` (only `lockfileVersion` and the `packages` entries for astro, tailwindcss, daisyui, zod, lightningcss* and @visionmediahq/astro-consent)
- `package.json` (only `dependencies` and `devDependencies`)
- `src/components/ContactMap.astro` (reduced, see below)
- `src/components/Footer.astro`
- `src/components/VisionFooter.astro`
- `src/data/kontakt.json`
- `src/data/privacy.json` (merged only: added by the PR)
- `src/layouts/Base.astro`
- `src/pages/404.astro`
- `src/pages/kontakt.astro` (reduced, see below)
- `src/styles/global.css`
- `src/styles/tokens.css`

## Reduced files

Pages and components that hold a footer, an iframe or a map embed, reduced the same way in `before/` and `merged/`: the frontmatter, tags, attributes, `{…}` expressions, comments and `script`/`style` blocks are kept; every text node outside `<footer>`, `<iframe>` and `<ConsentEmbed>` is replaced with `Text.`.

- `src/components/ContactMap.astro`
- `src/pages/kontakt.astro`

## Replacements

- Business, people's and place names, street addresses, phone numbers, e-mail addresses, domains, social-media handles, map coordinates and calendar IDs are replaced with neutral placeholders (`Exempel …`, `Exempelgatan 1`, `08-123 45 67`, `site-<id>.se`), the same way in `before/`, `merged/` and `expected/`, so the wiring is unchanged. The repo name is `site-<id>`.
- `src/data/kontakt.json` (before, expected and merged): the mobile number in `phone` replaced with `070-000 00 00`; it may be a person's own number.

## Secret scan

`npx tsx ci/rollout/scan-secrets.ts tests/unit/rollout/fixtures`: 0 hits.

## Detect

`detect(before, 'site-1218869363', ['site-1218869363.se'])`, pinned by `tests/unit/rollout/__snapshots__/detect.test.ts.snap`:

- Classification: `maps`
- Reasons: none
- Trackers: none
- Banners: none
- reCAPTCHA: false
- Already wired: none

The map `src` comes from `src/data/kontakt.json` (`data-file`). Its `pb=` URL is invented (`inventedMaps`), a site finding only.
