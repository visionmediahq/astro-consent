# elfsight-v2-after

A pool site with an Elfsight widget, variant V2: the widget div spans several lines inside
`<section>`, and the loader `<script>` is the last line of the component, after `</section>`.
The component is used on two pages. Astro 7.

## Files

Copied from the site's default branch (2026-10-14), except as noted. Every file has a `.txt` suffix.

- `package-lock.json`: only `lockfileVersion` and the `packages` entries for astro, tailwindcss, daisyui and zod
- `package.json`: only `dependencies` and `devDependencies`
- `astro.config.ts`: the `site` host replaced; the site's own `securityHeaders()` integration
  (its `SECURITY_HEADERS` list trips the secret scan) and the adapter's `staticHeaders` option
  removed
- `src/components/FacebookFeed.astro` (reduced): the widget
- `src/components/Footer.astro` (reduced)
- `src/components/VisionFooter.astro`
- `src/layouts/Base.astro`
- `src/pages/index.astro` (reduced; the Base props and schema replaced)
- `src/pages/nyheter.astro` (reduced; the Base and PageHero props replaced)
- `src/styles/global.css`

Reduced files keep the frontmatter, tags, attributes, `{…}` expressions, comments and
`script`/`style` blocks; every text node is replaced with `Text.`.

## Replacements

Business names, domains, phone numbers, e-mail and street addresses, social-media handles, image
names and page props (`title`, `description`, `canonical`, `ogImage`, schema) are replaced with
neutral values (`Text.`, `Firma`, `placeholder@example.invalid`, `+46000000000`, `https://<fixture>.se/`).
The widget id is replaced with `00000000-0000-0000-0000-00000000000N`.

## Secret scan

`npx tsx ci/rollout/scan-secrets.ts tests/unit/rollout/fixtures`: 0 hits.

## Detect

`detect(before, 'elfsight-v2-after', ['elfsight-v2-after.se'])`: `consent (elfsight)`, no reasons;
one widget in `src/components/FacebookFeed.astro`, pages `src/pages/index.astro` and
`src/pages/nyheter.astro`.

## Expected

`expected/` is `before/` with the wire rules applied by hand: the spec's `wire` section for the
widget (the loader `<script>` removed with its line, the div wrapped in
`<ConsentWidget service="elfsight" script="<loader as written>" title="Innehållet">` at its indent,
the `ConsentWidget` import) and `privacy.json`. The parts this change does not touch (config,
CSS `@source`, banner, footer links) are the output of the pilot-tested parts, checked by eye. `package.json` and the lockfile are unchanged: the install
of `github:visionmediahq/astro-consent#semver:^1.1.1` runs at apply time, not in the plan.

Removing the script's line leaves the blank line before it, so the file ends in `</section>` and an
empty line.
