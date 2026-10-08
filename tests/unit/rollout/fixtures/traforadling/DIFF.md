# DIFF: expected/ vs merged/ (traforadling)

`expected/` is `before/` with spec C2's edits applied by hand (Task 15), the oracle for `planWire`.
`merged/` is what the pilot PR merged. Each entry below is one difference between them, with a
verdict: **acceptable** (the rule's output is fine; the pilot made a hand decision) or **rule gap**
(the rule's output is worse than the pilot's on this site: a finding for the rollout).

**Out of scope:** `package.json` and `package-lock.json`. The npm install runs at apply time
(`applyWire`), not in the plan, so `expected/` keeps both exactly as in `before/`. The pilot's
dependency and lockfile changes in `merged/` are checked by verify step 1 (lockfile allowlist), not
by this oracle, and are not listed below.

**Rulings applied** (the controller's amendments to spec C2, 2026-10-07):
- 16: footerless pages and the 404 get the links as the last child of `<main>`'s only element child, if it has exactly one.
- 17: footer links go into the first element, going down from `<footer>`, that has more than one element child.
- 18: `justify-start!` only when the footer's last-child chain has `justify-between`, `justify-start` or `text-left`.
- 19: a scoped `<style>` rule that targets the iframe is rewritten to `:global(iframe)` under the wrapper.
- 20: PrivacyLinks contrast is verify's job.
- 21: `gdpr*` and `dataskydd*` count as policy pages.
- 22: only `height="N"`/`"Npx"`/`"Nrem"` or `h-<n>`/`h-[<n>px|rem|em|vh]` count as a fixed height.
- 23 (amends 17): decoration children don't count: `aria-hidden="true"`, a class with `absolute`, `fixed` or `pointer-events-none`, or an `<svg>`/`<img>` with empty alt.
- 24 (amends 19): the original style rule stays as it was; a new `:global(iframe)` rule after it carries only its `filter` and `transition` declarations.
- 25 (supersedes Ruling 22's "`%`/`h-full` are not fixed"): an iframe that fills its parent (`height="100%"` or `h-full`) inside a parent of definite height becomes `<div class="grid h-full …"><ConsentEmbed … aspect="auto" /></div>`. If the parent's height is unknown, it is refused.

**Detect input** (`detect(before, 'traforadling', ['traforadling.se'])`): `maps`; layout `Base.astro`
with footer reference `VisionFooter`; two footers, `FooterLevene.astro` and `FooterSkaraborg.astro`,
both `textClass: null`. Each `<footer>` has two element children (`.footer-inner`, `.footer-bottom`),
and its last-child chain has no alignment utility (the bar is centred by scoped CSS), so there is no
`justify-start!` (Ruling 18). Footerless: `404.astro` and `index.astro` (the portal splash has no
client footer). No policy page. One Google Maps iframe in `ContactFormSection.astro` whose `src` is a
ternary expression (two call sites), `height="320"` (fixed under Ruling 22), title an expression, no
classes, no filter.

Identical in both: the config import, the CSS `@source` line, `<ConsentBanner />` before
`<VisionFooter />`, the PrivacyLinks and ConsentEmbed imports in the footers and the map component,
and `src/data/privacy.json`.

## Differences

1. **`astro.config.ts`: `consent()` is the last element of `integrations`**; the pilot put it first.
   **Acceptable**: order does not matter; appending keeps the comment block attached to `sitemap()`.
2. **`Base.astro`: the ConsentBanner import comes after `import '../styles/global.css'`**; the pilot put
   it before. **Acceptable**: import order only (see munkfors entry 2).
3. **`FooterLevene.astro`: `<PrivacyLinks />` is the last child of `<footer>`**, after `.footer-bottom`;
   the pilot put it inside the bar between © and the portal link. **Acceptable (Rulings 17, 18)**:
   `<footer>` has two element children, so the links go at its end. They stay centred (no
   `justify-start!`), directly under the bar. The footer has no bottom padding of its own, so they sit
   close to its bottom edge: cosmetic only.
4. **`FooterLevene.astro`: no colour class**, the pilot's `text-base-content`. **Acceptable**: the
   footer's scoped CSS sets `color: var(--color-base-content)`, which the links inherit: the same colour.
5. **`FooterSkaraborg.astro`: `<PrivacyLinks />` is the last child of `<footer>`**, after
   `.footer-bottom`; the pilot put it between the two `footer-copy` lines. **Acceptable (Rulings 17,
   18)**: as entry 3.
6. **`FooterSkaraborg.astro`: no colour class**, the pilot's `text-base-content`. **Acceptable**: as
   entry 4.
7. **`FooterSkaraborg.astro`: the PrivacyLinks import comes after the lucide import (the last one)**;
   the pilot put it between the two. **Acceptable**: import order only.
8. **`index.astro`: `<PrivacyLinks />` is the last child of `<Base>`**, after `<HomeSplash />`; the
   pilot left `index.astro` alone and added a `bg-neutral pt-3` strip with
   `<PrivacyLinks class="text-neutral-content" />` after `</main>` in `HomeSplash.astro`.
   **Acceptable (Ruling 16)**: the page template has no `<main>` of its own (it is in `HomeSplash`), so
   the links go last in the outermost template element. They render in the layout's slot right after
   the splash, above VisionFooter, in the body's text colour; the strip was a hand design.
9. **`404.astro`: `<PrivacyLinks />` at the end of the centred box** (the only child of `<main>`); the
   pilot put it there too, with `mt-8 text-base-content/70`. **Acceptable (Ruling 16)**: same position;
   the links inherit `text-base-content`.
10. **`ContactFormSection.astro`: the map box.** Expected puts `<div class="grid h-[320px]">` with
    `aspect="auto"` inside the unchanged `<div class="map-frame overflow-hidden">`; the pilot added
    `grid h-[320px]` to `.map-frame` itself. **Acceptable (Ruling 22)**: `height="320"` is fixed; the
    same 320 px box either way.
11. **`ContactFormSection.astro`: `src` is the original ternary expression, copied as is**; the pilot
    moved the two URLs into `LEVENE_MAP` / `SKARABORG_MAP` constants. **Acceptable**: C8 lists the
    constants as a hand decision; the expression is unchanged.
12. **`ContactFormSection.astro`: `title` is the original expression**; the pilot shortened the
    Skaraborg branch to `Karta till Skaraborgs`. **Acceptable**: C8 lists shortened titles as hand
    decisions; the button-clip check in verify step 5 decides whether it fits.
13. **`ContactFormSection.astro`: no `href`, no placeholder slot, no `address`/`mapsQuery`/`mapsLink`
    constants**; the pilot added them. **Acceptable**: C8 lists `href` workarounds and placeholder text
    as hand decisions.
14. **`ContactFormSection.astro`: `<div …><ConsentEmbed … /></div>` on the iframe's lines** (the `src`
    expression keeps its own line breaks), the pilot's multi-line element. **Acceptable**: formatting
    only.
