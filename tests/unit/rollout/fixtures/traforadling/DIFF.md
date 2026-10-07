# DIFF: expected/ vs merged/ (traforadling)

`expected/` is `before/` with spec C2's edits applied by hand (Task 15), the oracle for `planWire`.
`merged/` is what the pilot PR merged. Each entry below is one difference between them, with a
verdict: **acceptable** (the rule's output is fine; the pilot made a hand decision) or **rule gap**
(the rule's output is worse than the pilot's on this site: a finding for the rollout).

**Out of scope:** `package.json` and `package-lock.json`. The npm install runs at apply time
(`applyWire`), not in the plan, so `expected/` keeps both exactly as in `before/`. The pilot's
dependency and lockfile changes in `merged/` are checked by verify step 1 (lockfile allowlist), not
by this oracle, and are not listed below.

**Detect input** (`detect(before, 'traforadling', ['traforadling.se'])`): `maps`; layout `Base.astro`
with footer reference `VisionFooter`; two footers, `FooterLevene.astro` and `FooterSkaraborg.astro`,
both `textClass: null` and not centred (their `.footer-bottom` is centred by scoped CSS, which detect
does not read); footerless: `404.astro` and `index.astro` (the portal splash has no client footer); no
policy page; one Google Maps iframe in `ContactFormSection.astro` whose `src` is a ternary expression
(two call sites), `height="320"`, title an expression, no classes, no filter.

Identical in both: the config import, the CSS `@source` line, `<ConsentBanner />` before
`<VisionFooter />`, the PrivacyLinks and ConsentEmbed imports in the footers and the map component,
and `src/data/privacy.json`.

## Differences

1. **`astro.config.ts`: `consent()` is the last element of `integrations`**; the pilot put it first.
   **Acceptable**: order does not matter; appending keeps the comment block attached to `sitemap()`.
2. **`Base.astro`: the ConsentBanner import comes after `import '../styles/global.css'`**; the pilot put
   it before. **Acceptable**: import order only (see munkfors entry 2).
3. **`FooterLevene.astro`: `justify-start!`** on the links; the pilot used none. **Rule gap**: the
   footer's bottom bar is centred by its scoped CSS (`.footer-bottom { align-items: center;
   text-align: center }`, a split row from `md`), which detect's class-based `centred` does not see, so
   the rule left-aligns links the pilot kept centred.
4. **`FooterLevene.astro`: `<PrivacyLinks>` is the last child of `<footer>`**, after `.footer-bottom`;
   the pilot put it inside the bar between © and the portal link. **Rule gap**: the footer has no side
   or bottom padding of its own (`.footer-bottom` and `.footer-inner` do), so the links sit in the
   footer's bottom-left corner (same gap as munkfors entry 4).
5. **`FooterLevene.astro`: no colour class**, the pilot's `text-base-content`. **Acceptable**: the
   footer's scoped CSS sets `color: var(--color-base-content)`, which the links inherit: the same colour.
6. **`FooterSkaraborg.astro`: `justify-start!`**; the pilot used none. **Rule gap**: as entry 3
   (`.footer-bottom` centred by scoped CSS).
7. **`FooterSkaraborg.astro`: `<PrivacyLinks>` is the last child of `<footer>`**, after `.footer-bottom`;
   the pilot put it between the two `footer-copy` lines. **Rule gap**: as entry 4 (no padding on the
   footer itself).
8. **`FooterSkaraborg.astro`: no colour class**, the pilot's `text-base-content`. **Acceptable**: as
   entry 5.
9. **`FooterSkaraborg.astro`: the PrivacyLinks import comes after the lucide import (the last one)**;
   the pilot put it between the two. **Acceptable**: import order only.
10. **`index.astro`: `<PrivacyLinks />` is the last child of `<Base>`**, after `<HomeSplash />`; the
    pilot left `index.astro` alone and added a `bg-neutral pt-3` strip with
    `<PrivacyLinks class="text-neutral-content" />` after `</main>` in `HomeSplash.astro`.
    **Acceptable**: the page template has no `<main>` of its own (it is in `HomeSplash`), so C2's
    fallback applies: the last child of the outermost element. The links render in the layout's slot
    right after the splash, above VisionFooter, in the body's text colour; the strip was a hand design.
11. **`404.astro`: `<PrivacyLinks />` is the last child of `<main>`**; the pilot put it under the back
    button with `mt-8 text-base-content/70`. **Rule gap**: `<main>` is a row flex container, so the
    links sit beside the 404 box (see munkfors entry 6).
12. **`ContactFormSection.astro`: the map box.** Expected puts `<div class="grid h-[320px]">` with
    `aspect="auto"` inside the unchanged `<div class="map-frame overflow-hidden">`; the pilot added
    `grid h-[320px]` to `.map-frame` itself. **Acceptable**: the same 320 px box either way.
13. **`ContactFormSection.astro`: `src` is the original ternary expression, copied as is**; the pilot
    moved the two URLs into `LEVENE_MAP` / `SKARABORG_MAP` constants. **Acceptable**: C8 lists the
    constants as a hand decision; the expression is unchanged.
14. **`ContactFormSection.astro`: `title` is the original expression**; the pilot shortened the
    Skaraborg branch to `Karta till Skaraborgs`. **Acceptable**: C8 lists shortened titles as hand
    decisions; the button-clip check in verify step 5 decides whether it fits.
15. **`ContactFormSection.astro`: no `href`, no placeholder slot, no `address`/`mapsQuery`/`mapsLink`
    constants**; the pilot added them. **Acceptable**: C8 lists `href` workarounds and placeholder text
    as hand decisions.
16. **`ContactFormSection.astro`: `<div …><ConsentEmbed … /></div>` on the iframe's lines** (the `src`
    expression keeps its own line breaks), the pilot's multi-line element. **Acceptable**: formatting
    only.
