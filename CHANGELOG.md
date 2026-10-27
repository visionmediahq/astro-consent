# Changelog

## 1.1.5

- Fix: on a phone (below `sm`) the banner's actions are full width (`max-sm:w-full`), and stack.
  astro-starter's mobile full-width rule leaves `.btn-sm` out on purpose, so the notice banner's
  "OK" was 45px wide, a site-factory QA finding on every page of every site (#116). "Neka" and
  "Acceptera alla" keep identical classes.
- Fix: the embed placeholder's "Visa" button is full width below `sm` too, and its info text,
  "Visa alltid" label and "Öppna i" link are `text-base` (16px) there, `text-sm`/`text-xs` from
  `sm` up as before (#117). The box grows in normal flow on a phone, as before.
- Fix: `ConsentEmbed` with `aspect="auto"` renders no `style` attribute (`aspect-ratio: auto` is
  the browser default). A strict CSP that allows no style attributes (Astro's `experimental.csp`)
  blocked it and logged an error on every embed page (#103). Other ratios still render
  `style="aspect-ratio: …"`.
- No wording change: `CONSENT_VERSION` is unchanged and no visitor is asked again.

## 1.1.4

- Fix: the banner's settings toggles have an explicit boundary, `border-base-content/60` unchecked
  (like the placeholder checkbox since 1.1.3) and full `base-content` checked (as DaisyUI's
  uncoloured toggle has it). DaisyUI paints a checked `toggle-primary`'s boundary in the primary
  colour, which on a pale primary is under WCAG 1.4.11's 3:1 against the banner (1.6:1 for
  `#f5c518`). 1.1.3's toggle test measured the unchecked state only; it now measures both states
  on a pale primary (#52).
- Test: the fixed-bar test uses a placeholder phone number, not one copied from a client site.
- README: the contrast notes say z-99 for the banner, as it has been since 1.1.3.
- No wording change: `CONSENT_VERSION` is unchanged and no visitor is asked again.

## 1.1.3

- Fix: the banner's width is `max-w-[42rem]` instead of `max-w-2xl`. Tailwind 4 resolves
  `max-w-2xl` through a site's `--spacing-2xl` when the site defines one, which made the banner
  64px wide on a client site (#64).
- The banner is `z-[99]` instead of `z-50`, so a fixed site bar at z-index 50–98 (a mobile call
  bar on two client sites) no longer covers its buttons (#64). It stays below 100, so
  client sites' focused skip link (`focus:z-[100]`, ahead of the banner in the DOM) is still on
  top when a tall banner reaches the top of a small phone.
- The placeholder's "Öppna i …" link and the banner's "Läs mer" links are `text-base-content`, so
  a site's `a { color }` in `@layer base` can't lower their contrast (a client site, #64). This
  covers a link colour in `@layer base` only: unlayered site CSS still wins over the package's
  utilities. `PrivacyLinks` keeps following the site's footer colour on purpose.
- The placeholder's "Visa alltid" checkbox border is `border-base-content/60`, for WCAG 1.4.11
  (3:1 for a control's boundary). DaisyUI's default measured 1.5:1 on `bg-base-200` in the demo.
  The banner's settings toggles already passed 3:1 and are unchanged; e2e now measures both (#52).
- No wording change: `CONSENT_VERSION` is unchanged and no visitor is asked again.

## 1.1.2

- Fix: on Astro 6, `<ConsentWidget>` rendered its placeholder inside the inert `<template>`, so the
  page showed an empty box with no "Visa" button (the self-closed `<template … />` was left open;
  Astro 7 closed it). The template is now closed explicitly. Found by the rollout tool's `verify` on
  the first Elfsight site; `test:pack` now asserts on both Astro majors that the "Visa" button is
  live markup outside the template. `CONSENT_VERSION` is unchanged: no visitor is asked again.
- Test: pack-install proves the no-`<script>` slot check on Astro 6 and 7 (#27).

## 1.1.1

- A granted embed or widget inside another widget's slot now activates with it, on a grant or a
  one-off "Visa" on the outer one, instead of staying a placeholder until the next change (#28).

## 1.1.0

- New services `google-calendar` (ConsentEmbed; the open link is the embed URL) and `elfsight`
  (vendor Elfsight, SL).
- New `<ConsentWidget>`: same placeholder, one-off "Visa" and remember as ConsentEmbed; the script
  loads once per page. The build fails on an unlisted service, a foreign script host, an empty slot
  or a `<script>` in the slot (on SSR pages the request fails with a 500).
- `CONSENT_VERSION` 2: every visitor on every site is asked again after the site's next install
  (#19, #24).

## Unreleased: repo tool

Not part of the package (`files` is unchanged) and not a release.

- `ci/rollout/`: the rollout tool, `tsx ci/rollout/run.ts detect | wire | verify | pr | live |
  merge`, with its state in `<site dir>/.rollout/`. Exit codes: 0 ok, 1 error or STOP, 2 usage, 3
  a refused wire plan. See README, "Rollout tool".
- `wire` stops uncommitted, with recovery steps, when anything fails after the branch switch or
  when the install changed paths outside the plan, `package.json` and `package-lock.json`.
- `merge` reads the last 50 Coolify deployments per app and stops before merging when an app that
  follows `main` serves a host that is not in the report's domains (it has no live baseline).
- `detect` classifies `consent`, `notice` or `needs-human` (was `maps`; stored reports with `maps`
  still load) and records `services` and `widgets`. Elfsight is a service, recognised as one loader
  script plus empty `elfsight-app-<uuid>` divs in the same `.astro` file; every other Elfsight
  occurrence is a `needs-human` reason. Google Calendar iframes whose `src` resolves (a literal, a constant, a data file, call sites that agree) no longer block a site; a `.map()` or otherwise unresolved `src` is needs-human, 'unresolved iframe src' (#24).
- `wire` wraps Elfsight divs in `<ConsentWidget service="elfsight">`, removes the loader script,
  writes `privacy.json` from `report.services` (an existing one missing a service is refused),
  installs `^1.1.2` (1.1.0 and 1.1.1 render ConsentWidget wrongly on Astro 6), and wraps
  resolvable Google Calendar iframes like maps (#24).
- `pr` names each service in the PR body with its "Visa <name>" step. `verify` maps each route to the
  service of the first iframe on it with a CSS filter, measures the filter on the first embed of that
  service on the page (clicking it after the one-off check if it is not the first), and counts widget pages as embed pages.
- `verify` step 4 (consent-paths) checks "Visa alltid" per service: remembering S must activate S's
  embeds on another page (or a reload when no other page has S) and leave other services inactive.
  The one-off Visa check uses `[data-active]`, so it covers widgets. Maps-only sites behave as before.
- `verify` step 4 (and `live`, which runs the same check) also fails a one-off "Visa" whose loaded
  iframe's layout box is under 100 px wide or tall; widgets are not measured. `wire` refuses a map
  whose grid wrapper keeps a class with a scoped rule setting a `display` other than grid/none or a
  height that is not definite (a client site: `display: block` left the loaded map 0px tall).
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
