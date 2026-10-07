# DIFF: expected/ vs merged/ (vasshallakatthotell)

`expected/` is `before/` with spec C2's edits applied by hand (Task 15), the oracle for `planWire`.
`merged/` is what the pilot PR merged. Each entry below is one difference between them, with a
verdict: **acceptable** (the rule's output is fine; the pilot made a hand decision) or **rule gap**
(the rule's output is worse than the pilot's on this site: a finding for the rollout).

**Out of scope:** `package.json` and `package-lock.json`. The npm install runs at apply time
(`applyWire`), not in the plan, so `expected/` keeps both exactly as in `before/`. The pilot's
dependency and lockfile changes in `merged/` are checked by verify step 1 (lockfile allowlist), not
by this oracle, and are not listed below.

**Detect input** (`detect(before, 'vasshallakatthotell', ['vasshallakatthotell.se'])`): `maps`; layout
`Base.astro` with footer reference `VisionFooter`; one footer, `src/components/Footer.astro`,
`textClass: null` (its colour is the inline `color: rgba(255,255,255,0.6)`), not centred (split bottom
bar); footerless: `404.astro`; no policy page; one literal Google Maps iframe in `ContactSection.astro`
(`height="100%"`, no classes, no filter).

Identical in both: the config import, the CSS `@source` line, `<ConsentBanner />` before
`<VisionFooter />`, the PrivacyLinks and ConsentEmbed imports, and the `services` list.

## Differences

1. **`astro.config.ts`: `consent()` is the last element of `integrations`**; the pilot put it first.
   **Acceptable**: order does not matter; appending keeps the comment block attached to `sitemap()`.
2. **`Base.astro`: the ConsentBanner import comes after `import '../styles/global.css'`**; the pilot put
   it before. **Acceptable**: import order only (see munkfors entry 2).
3. **`Footer.astro`: `<PrivacyLinks class="justify-start!" />` is the last child of `<footer>`**; the
   pilot put `<PrivacyLinks class="text-white/70" />` inside the split bottom bar, between © and "Webbplats
   av". **Rule gap**: the last child of this `<footer>` is outside `<div class="max-w-7xl mx-auto px-6
   lg:px-8 pt-16 pb-8">`, so the links start at the footer's left edge with no side padding and sit on
   its bottom edge (same gap as munkfors entry 4).
4. **`Footer.astro`: no colour class**, the pilot's `text-white/70`. **Acceptable**: per C2 the links
   inherit; the footer's inline `color: rgba(255,255,255,0.6)` is readable on its dark background.
5. **`404.astro`: `<PrivacyLinks />` is the last child of `<main>`**; the pilot put it under the back
   button with `mt-8 text-base-content/70`. **Rule gap**: `<main>` is a row flex container, so the links
   sit beside the 404 box (see munkfors entry 6).
6. **`ContactSection.astro`: the map box.** Expected wraps the embed in `<div class="grid h-[100%]">`
   with `aspect="auto"` inside the original `<div … style="height: clamp(260px, 50vw, 380px);">`; the
   pilot dropped that inline height and used `aspect="4 / 3"`. **Acceptable**: the rule keeps the site's
   box size; the placeholder fills a 260–380 px box. Vertical fit at 320 px wide is for verify's
   screenshots (C3 step 5 measures horizontal overflow only).
7. **`ContactSection.astro`: title `Karta till Vasshalla Katthotell i Gånghester`** (as on the iframe);
   the pilot shortened it to `Karta till Vasshalla Katthotell`. **Acceptable**: C8 lists shortened titles
   as hand decisions; the script never invents a title. Button clipping is checked by verify step 5.
8. **`ContactSection.astro`: no placeholder slot**; the pilot added `<Fragment slot="placeholder">` with
   the place name. **Acceptable**: the component's default placeholder text (from `sv.json`) is used.
9. **`ContactSection.astro`: one-line `<div …><ConsentEmbed … /></div>`**, the pilot's multi-line
   element. **Acceptable**: formatting only.
10. **`src/data/privacy.json`: no `policy_url`**; the pilot set `"policy_url":
    "https://vasshallakatthotell.se/gdpr"`. **Rule gap**: C1's policy-page patterns (`integritet*`,
    `privacy*`, `cookie*`, `personuppgift*`) miss a `/gdpr` route, so the site's policy link is lost.
    Add `gdpr*` to the patterns. (The fixture does not carry the page either; it is not a structural
    file.)
