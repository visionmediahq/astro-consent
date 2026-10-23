# site-1286040212

Sites are named by GitHub repo ID (`gh api repositories/<id>`).

Copied from the pilot consent PR as test data for `ci/rollout/`. Every file has a `.txt` suffix.

- Repo: GitHub repo ID `1286040212` (private)
- PR: #29 (squash-merged)
- before_sha: `d38aed1663ed7b7f5ec3041655fff426f0e5328c` (first parent of the merge commit)
- merged_sha: `16f3b348f696a31474b348d3a92ec40fc31080f8`

## Files

Copied as they are, except as noted:

- `astro.config.ts`
- `package-lock.json` (only `lockfileVersion` and the `packages` entries for astro, tailwindcss, daisyui, zod, lightningcss* and @visionmediahq/astro-consent)
- `package.json` (only `dependencies` and `devDependencies`)
- `src/components/Footer.astro`
- `src/components/VisionFooter.astro`
- `src/data/privacy.json` (merged only: added by the PR)
- `src/layouts/Base.astro`
- `src/pages/404.astro`
- `src/pages/index.astro` (reduced, see below)
- `src/styles/global.css`

## Reduced files

Pages and components that hold a footer, an iframe or a map embed, reduced the same way in `before/` and `merged/`: the frontmatter, tags, attributes, `{…}` expressions, comments and `script`/`style` blocks are kept; every text node outside `<footer>`, `<iframe>` and `<ConsentEmbed>` is replaced with `Text.`.

- `src/pages/index.astro`

## Replacements

- Business, people's and place names, street addresses, phone numbers, e-mail addresses, domains, social-media handles, map coordinates and calendar IDs are replaced with neutral placeholders (`Exempel …`, `Exempelgatan 1`, `08-123 45 67`, `site-<id>.se`), the same way in `before/`, `merged/` and `expected/`, so the wiring is unchanged. The repo name is `site-<id>`.
- `src/pages/index.astro` (before and merged): the schema `email`, a Gmail address in a person's name, replaced with `placeholder@example.invalid`.

## Secret scan

`npx tsx ci/rollout/scan-secrets.ts tests/unit/rollout/fixtures`: 0 hits.

## Detect

`detect(before, 'site-1286040212', ['site-1286040212.se'])`, pinned by `tests/unit/rollout/__snapshots__/detect.test.ts.snap`:

- Classification: `notice`
- Reasons: none
- Trackers: none
- Banners: none
- reCAPTCHA: false
- Already wired: none

`recaptcha` is false: `astro.config.ts` only mentions reCAPTCHA in a comment, and the files that load it are not part of this fixture.
