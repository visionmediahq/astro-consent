# elfsight-v4

A pool site with an Elfsight widget, variant V4: the class is built from
`import.meta.env.PUBLIC_ELFSIGHT_WIDGET_ID`, the div comes before the loader, and both sit in a
`<Fragment>` inside a ternary with a static fallback. Wire refuses it: see `expected/REFUSED.md`.

## Files

Copied from the site's default branch (2026-10-14), except as noted. Every file has a `.txt` suffix.

- `package-lock.json`: only `lockfileVersion` and the `packages` entries for astro, tailwindcss, daisyui and zod
- `package.json`: only `dependencies` and `devDependencies`
- `astro.config.ts`
- `src/components/Footer.astro` (reduced; image names and alt texts replaced)
- `src/components/InstagramFeed.astro` (reduced): the widget, unchanged apart from text nodes
- `src/components/VisionFooter.astro`
- `src/layouts/Base.astro`: the site's Google Tag Manager blocks removed, so the reasons are
  Elfsight's only
- `src/pages/index.astro`: reduced to the Base props and the component uses
- `src/styles/global.css`

Reduced files keep the frontmatter, tags, attributes, `{…}` expressions, comments and
`script`/`style` blocks; every text node is replaced with `Text.`.

## Replacements

As the other Elfsight fixtures: names, contact details and page props replaced with neutral values.
The widget id is an environment variable here, so there is none to replace.

## Secret scan

`npx tsx ci/rollout/scan-secrets.ts tests/unit/rollout/fixtures`: 0 hits.

## Detect

`detect(before, 'elfsight-v4', ['elfsight-v4.se'])`: `needs-human`, the four Elfsight reasons in
`expected/REFUSED.md`.
