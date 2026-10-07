# DIFF: expected/ vs merged/ (vasshallakatthotell)

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

**Detect input** (`detect(before, 'vasshallakatthotell', ['vasshallakatthotell.se'])`): `maps`; layout
`Base.astro` with footer reference `VisionFooter`; one footer, `src/components/Footer.astro`,
`textClass: null` (its colour is the inline `color: rgba(255,255,255,0.6)`); its last-child chain
ends in the `justify-between` bottom bar, so `justify-start!` is added (Ruling 18); footerless:
`404.astro`; one literal Google Maps iframe in `ContactSection.astro` (`height="100%"`, which is not a
fixed height under Ruling 22; no classes, no filter). The policy page `src/pages/gdpr.astro` was added
to the fixture in this amendment (reduced, see SOURCE.md). Under Ruling 21 detect (once Task 16
changes it) reports it as `policyPage`, which gives `policy_url`.

Identical in both: the config import, the CSS `@source` line, `<ConsentBanner />` before
`<VisionFooter />`, the PrivacyLinks and ConsentEmbed imports, and `src/data/privacy.json`, including
`"policy_url": "https://vasshallakatthotell.se/gdpr"` (Ruling 21).

## Differences

1. **`astro.config.ts`: `consent()` is the last element of `integrations`**; the pilot put it first.
   **Acceptable**: order does not matter; appending keeps the comment block attached to `sitemap()`.
2. **`Base.astro`: the ConsentBanner import comes after `import '../styles/global.css'`**; the pilot put
   it before. **Acceptable**: import order only (see munkfors entry 2).
3. **`Footer.astro`: `<PrivacyLinks class="justify-start!" />` is the last child of
   `<div class="max-w-7xl mx-auto px-6 lg:px-8 pt-16 pb-8">`**, below the split bottom bar; the pilot put
   `<PrivacyLinks class="text-white/70" />` inside the bar, between © and "Webbplats av". **Acceptable
   (Ruling 23)**: the `aria-hidden` `absolute inset-0` paw-print layer doesn't count, so `<footer>` has
   one element child and the descent continues into the padded container (Ruling 17). The links sit
   inside its padding, left-aligned like the split bar (Ruling 18).
4. **`Footer.astro`: no colour class**, the pilot's `text-white/70`. **Acceptable**: per C2 the links
   inherit; the footer's inline `color: rgba(255,255,255,0.6)` is readable on its dark background.
5. **`404.astro`: `<PrivacyLinks />` at the end of the centred box** (the only child of `<main>`); the
   pilot put it there too, with `mt-8 text-base-content/70`. **Acceptable (Ruling 16)**: same position;
   the links inherit `text-base-content`.
6. **`ContactSection.astro`: the map box.** Expected is a plain `<div><ConsentEmbed … /></div>` (no
   classes, so no class attribute) with the default `16 / 9` aspect, inside the unchanged
   `<div … style="height: clamp(260px, 50vw, 380px);">`. The pilot dropped that inline height and used
   `aspect="4 / 3"`. **Acceptable (Ruling 22)**: `height="100%"` is not a fixed height. The 16 / 9 box
   fits inside the 260–380 px frame at the column widths this layout has, leaving empty frame below it
   on narrow screens. If the placeholder grows taller than the frame at 320 px, the frame's
   `overflow-hidden` clips it, and verify's screenshots must show that.
7. **`ContactSection.astro`: title `Karta till Vasshalla Katthotell i Gånghester`** (as on the iframe);
   the pilot shortened it to `Karta till Vasshalla Katthotell`. **Acceptable**: C8 lists shortened titles
   as hand decisions; the script never invents a title. Button clipping is checked by verify step 5.
8. **`ContactSection.astro`: no placeholder slot**; the pilot added `<Fragment slot="placeholder">` with
   the place name. **Acceptable**: the component's default placeholder text (from `sv.json`) is used.
9. **`ContactSection.astro`: one-line `<div><ConsentEmbed … /></div>`**, the pilot's multi-line element.
   **Acceptable**: formatting only.
