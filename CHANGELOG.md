# Changelog

## Unreleased: repo tool

Not part of the package (`files` is unchanged) and not a release.

- `ci/rollout/`: the rollout tool, `tsx ci/rollout/run.ts detect | wire | verify | pr | live |
  merge`, with its state in `<site dir>/.rollout/`. Exit codes: 0 ok, 1 error or STOP, 2 usage, 3
  a refused wire plan. See README, "Rollout tool".
- `wire` stops uncommitted, with recovery steps, when anything fails after the branch switch or
  when the install changed paths outside the plan, `package.json` and `package-lock.json`.
- `merge` reads the last 50 Coolify deployments per app and stops before merging when an app that
  follows `main` serves a host that is not in the report's domains (it has no live baseline).
- CI: the `e2e` job runs `verify --demo demo/dist-consent` after the consent demo build.

## 1.0.2

- Fix: the banner and map buttons failed WCAG AA contrast on light or saturated primary colours
  (seen on three pilot sites). Inside the banner and `<ConsentEmbed>` only, `.btn-primary` text is
  now black or white, whichever the primary's WCAG relative luminance calls for (black above 0.1791,
  where black and white contrast equally; checked against every daisyUI theme and the pilot and
  pool themes, all AA). Browsers without relative-colour support keep the
  theme's own colour. Neka and Acceptera alla stay identical.
- Change: the map button reads "Visa {name}" (e.g. "Visa Google Maps") instead of repeating the
  embed's title, may wrap, and is described by the placeholder text through `aria-describedby`.
- Test: a consent-terms guard ties the banner and category wording and each service's category,
  vendor and description to `CONSENT_VERSION`. `CONSENT_VERSION` is unchanged (1): no visitor is
  asked again.

## 1.0.1

- Fix: the "Öppna i Google Maps" link for "Embed a map" URLs (`/maps/embed?pb=…`) opened the
  visitor's own location, because Google ignores `pb=` outside an iframe. It now searches for the
  place name in `pb` (`!1m2!1s…!2s<name>`), falls back to its coordinates (`!3d`/`!2d`), and to
  plain Google Maps when it has neither. Found in the live pilot, where most embeds use `pb=`.

## 1.0.0

First release.

- `consent()` Astro integration: validates `src/data/privacy.json`, serves it to components and the
  browser through one virtual module, injects the runtime once per page, and fails the build when a
  `<ConsentEmbed>` names a service that is not listed.
- `<ConsentBanner />`: Swedish, themed by the site's DaisyUI theme. Consent mode (Acceptera alla /
  Neka / Inställningar) when the site uses registry services, notice mode (OK) when it uses none.
- `<ConsentEmbed>`: click-to-load iframe with a placeholder, a per-service "Visa alltid" choice and a
  link that works without JavaScript.
  The link for Maps Embed API URLs is rebuilt from their parameters and never carries the API key.
- `<PrivacyLinks />`: footer link that reopens the settings, plus the policy link when configured.
- Script API: `hasConsent`, `onConsent`, `openSettings`; events `vm:consent-ready` and
  `vm:consent-changed`. A target the site has not declared in `privacy.json` logs one warning and is
  never granted. A service read through `hasConsent` counts as loaded, so withdrawing it reloads the
  page. The script API type-checks inside a site's own `tsc` / `astro check`.
- The build-time check follows embeds imported under another name and reads live markup only, so a
  commented-out embed does not fail a build.
- Service registry: Google Maps, Google Analytics, Google Ads, Meta Pixel.
- Withdrawal deletes the withdrawn services' first-party cookies and reloads once; other tabs follow.
- Optional `log_endpoint` beacon for a future central consent log.

Not supported: Astro view transitions (`<ClientRouter />`).
