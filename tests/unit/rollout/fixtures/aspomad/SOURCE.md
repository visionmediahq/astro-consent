# aspomad

Copied from the pilot consent PR as test data for `ci/rollout/`. Every file has a `.txt` suffix.

- Repo: `visionmediahq/aspomad` (private)
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

None. The contact details in these files are the business's own.

## Secret scan

`npx tsx ci/rollout/scan-secrets.ts tests/unit/rollout/fixtures`: 0 hits.
