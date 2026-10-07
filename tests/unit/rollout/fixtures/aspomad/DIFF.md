# DIFF: expected/ vs merged/ (aspomad)

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

**Detect input** (`detect(before, 'aspomad', ['aspomad.se'])`): `maps`; no `integrations` in the config;
layout `Base.astro` with footer reference `Footer`; one footer, `src/components/Footer.astro`,
`textClass: text-neutral-content`, with a `text-center` bottom bar (no `justify-start!`); footerless:
none (the 404 renders the layout's footer); no policy page; one Google Maps iframe in
`ContactMap.astro` whose `src` comes from `src/data/kontakt.json` (`height="100%"`, not fixed under
Ruling 22; no classes). Its scoped `<style>` has `iframe { filter: … }` and `iframe:hover { filter: … }`.

Identical in both: the config import, the CSS `@source` line, `<ConsentBanner />` before `<Footer />`,
and `src/data/privacy.json`.

## Differences

1. **`astro.config.ts`: `integrations: [consent()],` is the last property of `defineConfig`** (after
   `vite`); the pilot put it first. **Acceptable**: property order does not matter.
2. **`Base.astro`: the ConsentBanner import comes after `import '../styles/global.css'`**; the pilot put
   it before the two CSS imports. **Acceptable**: import order only (see munkfors entry 2).
3. **`Footer.astro`: the PrivacyLinks import comes after the last import (`../lib/hours`)**; the pilot
   put it between `kontakt.json` and `../lib/hours`. **Acceptable**: import order only.
4. **`Footer.astro`: `<PrivacyLinks class="text-neutral-content" />` is the last child of
   `<div class="container mx-auto px-4">`**, below the bottom bar; the pilot put
   `<PrivacyLinks class="text-neutral-content/80 mt-2" />` inside the bar under ©. **Acceptable
   (Ruling 17)**: `<footer>`'s only child is that container, so the links sit centred inside its
   padding, in the footer's own text colour; the difference is opacity and spacing.
5. **`ContactMap.astro`: the map box.** Expected is a plain `<div><ConsentEmbed … /></div>` with the
   default `16 / 9` aspect inside the unchanged `<section class="w-full h-[500px] relative">`; the pilot
   made the section `grid` and used `aspect="auto"` to fill all 500 px. **Acceptable (Ruling 22)**:
   `height="100%"` is not a fixed height. The map is as tall as 16 / 9 of the width (500 px at about
   890 px wide), so on narrower screens it leaves empty section below. Nothing is clipped.
6. **`ContactMap.astro`: no `href`, no placeholder slot, no `address`/`mapsLink` constants**; the pilot
   added all three. **Acceptable**: C8 lists `href` workarounds and placeholder text as hand decisions;
   the component's default link (de-embedded `src`) and default text are used.
7. **`ContactMap.astro`: the scoped filter rules become `div :global(iframe)` and
   `div:hover :global(iframe)`**; the pilot wrote `section :global(iframe)` and
   `section:hover :global(iframe)` and added a comment. **Acceptable (Ruling 19)**: the selectors had no
   ancestor part, so the rule scopes them under the wrapper `div` (the component's only `div`, so
   Astro's scoping limits it to this map) and moves `:hover` from the iframe to the wrapper, as the
   pilot did with the section. Same filter, same hover behaviour.
8. **`ContactMap.astro`: the ConsentEmbed import comes after `kontakt.json`**; the pilot put it before.
   **Acceptable**: import order only.
9. **`ContactMap.astro`: one-line `<div><ConsentEmbed … /></div>`**, the pilot's multi-line element.
   **Acceptable**: formatting only.
