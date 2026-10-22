# site-1243511314

Sites are named by GitHub repo ID (`gh api repositories/<id>`).

Copied from the pilot consent PR as test data for `ci/rollout/`. Every file has a `.txt` suffix.

- Repo: GitHub repo ID `1243511314` (private)
- PR: #31 (squash-merged)
- before_sha: `617137f49eb66919ee18e1bea2486a29ae7a90cc` (first parent of the merge commit)
- merged_sha: `d8da2eaf26815071ca319d05c1e09fb7e723183d`

One-page site: `src/pages/index.astro` renders `Contact` (the map) and `Footer` directly.

## Files

Copied as they are, except as noted:

- `astro.config.ts`
- `package-lock.json` (only `lockfileVersion` and the `packages` entries for astro, tailwindcss, daisyui, zod, lightningcss* and @visionmediahq/astro-consent)
- `package.json` (only `dependencies` and `devDependencies`)
- `src/components/Contact.astro` (reduced, see below)
- `src/components/Footer.astro`
- `src/components/VisionFooter.astro`
- `src/data/privacy.json` (merged only: added by the PR)
- `src/layouts/Base.astro`
- `src/pages/404.astro`
- `src/pages/index.astro` (reduced, see below)
- `src/styles/global.css`

## Reduced files

Pages and components that hold a footer, an iframe or a map embed, reduced the same way in `before/` and `merged/`: the frontmatter, tags, attributes, `{…}` expressions, comments and `script`/`style` blocks are kept; every text node outside `<footer>`, `<iframe>` and `<ConsentEmbed>` is replaced with `Text.`.

- `src/components/Contact.astro`
- `src/pages/index.astro`

## Replacements

- Business, people's and place names, street addresses, phone numbers, e-mail addresses, domains, social-media handles, map coordinates and calendar IDs are replaced with neutral placeholders (`Exempel …`, `Exempelgatan 1`, `08-123 45 67`, `site-<id>.se`), the same way in `before/`, `merged/` and `expected/`, so the wiring is unchanged. The repo name is `site-<id>`.
- Business, people's and place names, street addresses, phone numbers, e-mail addresses, domains, social-media handles, map coordinates and calendar IDs are replaced with neutral placeholders (`Exempel …`, `Exempelgatan 1`, `08-123 45 67`, `site-<id>.se`), the same way in `before/`, `merged/` and `expected/`, so the wiring is unchanged. The repo name is `site-<id>`.

## Secret scan

`npx tsx ci/rollout/scan-secrets.ts tests/unit/rollout/fixtures`: 0 hits.

## Detect

`detect(before, 'site-1243511314', ['site-1243511314.se'])`, pinned by `tests/unit/rollout/__snapshots__/detect.test.ts.snap`:

- Classification: `maps`
- Reasons: none
- Trackers: none
- Banners: none
- reCAPTCHA: false
- Already wired: none
