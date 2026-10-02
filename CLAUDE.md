# CLAUDE.md — astro-consent

Read this before changing anything.

## What this repo is

`@visionmediahq/astro-consent`: the consent banner, click-to-load embeds and consent script API used
by Vision Media's Astro sites. Sites install it straight from this GitHub repo. It ships **raw
`.ts` and `.astro` source**; there is no build step.

## Rules that must not be broken

- **No script named `prepare`, `preinstall`, `install`, `postinstall`, `prepack` or `build`, and no
  `workspaces` field in `package.json`.** Any of them makes npm install this repo's devDependencies
  (Playwright included) inside every site's Coolify build. `tests/unit/package.test.ts` pins this.
- **Fail closed.** Nothing matching a pattern in `src/services.ts` may be requested before a valid
  grant, with or without JavaScript. A one-off "Visa" activates only the element that was clicked.
- **`client.ts` never writes `vm_consent` on page load or when adopting another tab's change.**
  Writes come only from the banner or an embed checkbox. This is what keeps cross-tab sync loop-free.
- **Browser-safe imports.** `src/config.ts` uses `node:crypto` and zod: `client.ts`, `store.ts`,
  `services.ts`, `embed-url.ts` and the components must not import from it at all. Shared types live
  in the node-free `src/types.ts`. A site that imports the script API type-checks `client.ts` and
  everything it imports as part of its own program (`tests/build/site-typecheck.test.ts` pins this).
- **Every visible string lives in `src/text/sv.json`.** No Swedish in components or `client.ts`.
  Raise `CONSENT_VERSION` in `src/config.ts` when the wording changes: every visitor is asked again.
- **Neka is as visible and easy as Acceptera alla**: identical classes (`btn btn-primary btn-sm`),
  same row, one click. Nothing is pre-ticked, the banner is not modal and never takes focus on its
  own. A test compares the two buttons' classes and computed colours.
- **TypeScript only, strict.** No `.js`/`.mjs`, scripts and CI helpers included.
- **DaisyUI 5:** `form-control` no longer exists and `.label` does not wrap and dims its text. Use
  plain flex rows for anything descriptive.
- **Never stub `window.umami`** outside tests. Call `window.umami?.track(...)`.

## DOM contract (components render it, `client.ts` queries it)

```
[data-consent-banner][data-mode=notice|consent][data-view=main|settings][hidden]
  [data-consent-main]   form[data-consent-settings]        (consent mode only)
  [data-consent-action=notice_ok|all|none|settings|back|custom]
  [data-consent-category=<category>] input[name=<category>]
  [data-consent-service=<slug>][hidden] input[name="service:<slug>"]
[data-privacy-links] [data-consent-open]
[data-consent-embed=<slug>] template[data-payload] [data-placeholder] [data-load] [data-remember] a[data-open]
  + [data-active] once the iframe is in
```

## Layout

| Path | Purpose |
|---|---|
| `src/services.ts`, `services.json` | Service registry; `npm run gen` regenerates the JSON (CI fails if stale) |
| `src/config.ts` | `privacy.json` schema, `consentVersion` (Node only) |
| `src/store.ts` | Pure consent-record logic, unit-tested |
| `src/integration.ts`, `src/scan.ts` | The Astro integration and the build-time embed scan |
| `src/client.ts` | Browser runtime |
| `src/components/`, `src/text/sv.json` | Markup and strings |
| `demo/` | Demo site the tests build in two modes (`privacy.consent.json`, `privacy.notice.json`) |
| `scripts/` | `demo-copy`, `build-demo`, `pack-install`, `gen-services` |
| `ci/wire-starter.ts` | Applies the site wiring to an astro-starter checkout (CI and rollout tool) |

## Tests

```bash
npm run check                 # tsc
npm test                      # unit
npm run test:build            # astro build on temp copies of the demo
npm run demo:build -- consent && npm run demo:build -- notice
npm run test:e2e              # Playwright; needs both demo builds
npm run test:pack -- 6.1.6 10.0.4   # tarball install into a real node_modules, Astro 6
npm run test:pack -- 7.3.5 11.1.6   # ... and Astro 7
```

Playwright routes every registry host and the demo log host to stubs. Tests must never reach Google,
Meta or a real log endpoint. Write the failing test first.

The scan reads `.astro` files from disk inside a Vite `transform` hook, because Astro compiles them
before plugins added through `updateConfig` run.

**The scan must never fail a build on valid code.** It can be wrong in two directions, and they are
not equal. Missing a real embed is acceptable: `ConsentEmbed.astro` checks its own `service` when it
renders, so nothing loads without consent either way. Reporting an embed that is not live (commented
out, inside a string, in a script block) blocks a technician on a site that is fine. So
`findEmbedServices` is a one-pass reader that skips whenever it is unsure: the frontmatter, HTML
comments, JS comments and strings inside `{…}` expressions, and the content of `script`, `style`,
`textarea` and `is:raw` elements. It is not an Astro parser and should not grow into one. When you
change it, add the case to `tests/unit/scan.test.ts` and run it over real sites' `.astro` files:
every hit on a site that does not use the embed is a bug.

## Releasing

Before tagging, the repo variable `STARTER_INSTALL` must be `true` (with the secret
`STARTER_READ_TOKEN`) and the `starter-install` job must be green on `main`: it is the only proof of
the real install path, a git dependency resolved without git inside astro-starter's Docker build. A
tag is public the moment it is pushed and sites on `semver:^1.0.0` pick it up at their next install;
the `release-guard` job only flags a tag pushed without that proof, it cannot take it back.

Then `git tag -a vX.Y.Z -m "…"` and push the tag. Sites depend on
`github:visionmediahq/astro-consent#semver:^1.0.0`. Update `CHANGELOG.md`.
