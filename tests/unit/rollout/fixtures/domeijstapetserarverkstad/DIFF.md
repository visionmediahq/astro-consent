# DIFF: expected/ vs merged/ (domeijstapetserarverkstad)

`expected/` is `before/` with spec C2's edits applied by hand (Task 15), the oracle for `planWire`.
`merged/` is what the pilot PR merged. Each entry below is one difference between them, with a
verdict: **acceptable** (the rule's output is fine; the pilot made a hand decision) or **rule gap**
(the rule's output is worse than the pilot's on this site: a finding for the rollout).

**Out of scope:** `package.json` and `package-lock.json`. The npm install runs at apply time
(`applyWire`), not in the plan, so `expected/` keeps both exactly as in `before/`. The pilot's
dependency and lockfile changes in `merged/` are checked by verify step 1 (lockfile allowlist), not
by this oracle, and are not listed below.

**Detect input** (`detect(before, 'domeijstapetserarverkstad', ['domeijstapetserarverkstad.se'])`):
`maps`; layout `Base.astro` with no footer reference (the one-page `index.astro` renders `Footer`
itself), so `<ConsentBanner />` goes before `</body>`; one footer, `src/components/Footer.astro`,
`textClass: null`, not centred; footerless: `404.astro`; no policy page; one literal Google Maps iframe
in `Contact.astro` (`height="100%"`, no classes, inline style without a filter).

Identical in both: the config import, the CSS `@source` line, the ConsentBanner import and
`<ConsentBanner />` before `</body>`, the ConsentEmbed import, and `src/data/privacy.json`.

## Differences

1. **`astro.config.ts`: `consent()` is the last element of `integrations`**; the pilot put it first.
   **Acceptable**: order does not matter; appending keeps the comment block attached to `sitemap()`.
2. **`Footer.astro`: the PrivacyLinks import directly after `---`**; the pilot added a blank line after
   it. **Acceptable**: formatting only (the frontmatter had no imports).
3. **`Footer.astro`: `<PrivacyLinks class="justify-start!" />` is the last child of `<footer>`**, below
   the three-column grid; the pilot put it under © in the right column with `justify-start!
   md:justify-end!`. **Acceptable**: spec C2 names domeij's placement under © as a hand decision; the
   footer's own `px-8 md:px-12` keeps the links off the edge.
4. **`Footer.astro`: no colour class**, the pilot's `text-white/70`. **Rule gap**: the footer has no
   text colour class and no inline `color` (each text element is coloured in the scoped `<style>`), so
   the links inherit the body's `--color-base-content` (dark grey) on the footer's `#0e0a06`
   background: unreadable. "No text colour class → inherit" is only safe when the footer sets its own
   colour; otherwise detect should flag it, and verify's contrast step should cover PrivacyLinks too.
5. **`404.astro`: `<PrivacyLinks />` is the last child of `<main>`**; the pilot put it under the back
   button with `mt-8 text-base-content/70`. **Rule gap**: `<main>` is a row flex container, so the links
   sit beside the 404 box (see munkfors entry 6).
6. **`Contact.astro`: the map box.** Expected puts `<div class="grid h-[100%]">` with `aspect="auto"`
   inside the unchanged `<div class="map-wrap">`; the pilot made `.map-wrap` itself `display: grid`.
   **Acceptable**: `.map-wrap` is `height: 100%; min-height: 480px` in a grid cell, so the wrapper
   resolves to the same box; verify's screenshots confirm the height on mobile.
7. **`Contact.astro`: the iframe's inline `display:block; width:100%; min-height:480px` is dropped**.
   **Acceptable**: `ConsentEmbed`'s iframe fills its box, and `.map-wrap` keeps the 480 px minimum.
8. **`Contact.astro`: the scoped `<style>` (`.map-wrap iframe { filter: sepia(…) … }` and its
   `:hover`) is left as is**; the pilot rewrote it to `.map-wrap :global(iframe)` and dropped the size
   rules. **Rule gap**: the filter lives in a scoped style rule, not the iframe's `style`, so C2 does not
   carry it and it silently stops applying (see aspomad entry 7).
9. **`Contact.astro`: title `Karta till Domeijs tapetserarverkstad, Ångpannegatan 2E, Göteborg`** (as on
   the iframe); the pilot shortened it to `Karta till Domeijs`. **Acceptable**: C8 lists shortened
   titles as hand decisions; the button-clip check in verify step 5 decides whether it fits.
10. **`Contact.astro`: no placeholder slot**; the pilot added the address. **Acceptable**: the default
    placeholder text is used.
11. **`Contact.astro`: one-line `<div …><ConsentEmbed … /></div>`**, the pilot's multi-line element.
    **Acceptable**: formatting only.
