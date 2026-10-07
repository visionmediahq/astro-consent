# munkforstradgardstjanst

Copied from the pilot consent PR as test data for `ci/rollout/`. Every file has a `.txt` suffix.

- Repo: `visionmediahq/munkforstradgardstjanst` (private)
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

- `src/pages/index.astro` (before and merged): the schema `email`, a Gmail address in a person's name, replaced with `placeholder@example.invalid`.
- Kept as business contact details: the business phone number and street address.

## Secret scan

`npx tsx ci/rollout/scan-secrets.ts tests/unit/rollout/fixtures`: 0 hits.
