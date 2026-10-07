# nhrk

Copied from the pilot consent PR as test data for `ci/rollout/`. Every file has a `.txt` suffix.

- Repo: `visionmediahq/nhrk` (private)
- PR: #58 (squash-merged)
- before_sha: `165c61450d8ceb5d58faab850a8f973608beaa24` (first parent of the merge commit)
- merged_sha: `aa455960f49071c19c381effac9df45fb5a9d42f`

`src/pages/kalendrar.astro` embeds Google Calendar iframes directly in the page.

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
- `src/pages/kalendrar.astro` (reduced, see below)
- `src/styles/global.css`

## Reduced files

Pages and components that hold a footer, an iframe or a map embed, reduced the same way in `before/` and `merged/`: the frontmatter, tags, attributes, `{…}` expressions, comments and `script`/`style` blocks are kept; every text node outside `<footer>`, `<iframe>` and `<ConsentEmbed>` is replaced with `Text.`.

- `src/pages/index.astro`
- `src/pages/kalendrar.astro`

## Replacements

None. The contact details in these files are the business's own.

## Secret scan

`npx tsx ci/rollout/scan-secrets.ts tests/unit/rollout/fixtures`: 0 hits.
