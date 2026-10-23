# DIFF: expected/ vs merged/ (site-1243511314)

Sites are named by GitHub repo ID (`gh api repositories/<id>`).

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

**Detect input** (`detect(before, 'site-1243511314', ['site-1243511314.se'])`):
`maps`; layout `Base.astro` with no footer reference (the one-page `index.astro` renders `Footer`
itself), so `<ConsentBanner />` goes before `</body>`; one footer, `src/components/Footer.astro`,
`textClass: null`. Its last-child chain (`grid … items-end` → `md:text-right` column → `p`) has no
`justify-between`/`justify-start`/`text-left` (alignment `unknown`; the © column is a block row, see entry 4). Footerless:
`404.astro`; no policy page. One literal Google Maps iframe in `Contact.astro` (`height="100%"`,
filling `.map-wrap`, whose scoped CSS gives it `min-height: 480px; height: 100%`: Ruling 25). Its scoped `<style>` has `.map-wrap iframe { filter: …; display; width;
height; min-height; transition }` and `.map-wrap:hover iframe { filter: none }`.

Identical in both: the config import, the CSS `@source` line, the ConsentBanner import and
`<ConsentBanner />` before `</body>`, the ConsentEmbed import, and `src/data/privacy.json`.

## Differences

1. **`astro.config.ts`: `consent()` is the last element of `integrations`**; the pilot put it first.
   **Acceptable**: order does not matter; appending keeps the comment block attached to `sitemap()`.
2. **`Footer.astro`: the PrivacyLinks import directly after `---`**; the pilot added a blank line after
   it. **Acceptable**: formatting only (the frontmatter had no imports).
3. **`Footer.astro`: the links go right after `<p class="footer-copy">©…</p>` in the right column**
   (#47: the grid's last column holds the © line, so that column is the bottom bar); the pilot put them
   under © in the same column too. **Acceptable**: same position.
4. **`Footer.astro`: `justify-start! md:justify-end! mt-2`, as the pilot** (#47 review). The column is
   a block row (not flex), so the links sit on their own line under ©, lined up with its text: left on
   mobile, right from `md` (the column's `md:text-right`). Before the review wire added neither, and
   the links were centred in the column.
5. **`Footer.astro`: `text-white/70`, as the pilot** (#47). The footer has no text colour class; its
   inline `background: var(--color-bg-dark, #0e0a06)` has a literal fallback, on which `text-white/70`
   reads at 4.5:1 or better, so wire adds it. Before #47 the links inherited the body's dark
   `--color-base-content` here (unreadable, left to verify).
6. **`404.astro`: `<PrivacyLinks class="mt-6" />` at the end of the centred box** (the only child of
   `<main>`); the pilot put it there too, with `mt-8 text-base-content/70`. **Acceptable (Ruling 16,
   #47)**: same position, a top margin as the pilot's; the links inherit `text-base-content`.
7. **`Contact.astro`: the map box.** Expected puts `<div class="grid h-full">` around
   `<ConsentEmbed … aspect="auto" />` inside the unchanged `<div class="map-wrap">`; the pilot made
   `.map-wrap` itself `display: grid`, with `aspect="auto"`. **Acceptable (Ruling 25)**: `.map-wrap`
   has a definite height from its scoped CSS (`min-height: 480px`, and `height: 100%` of its
   contact-grid cell), so the map fills it with no beige band, as the pilot's did. One caveat: the
   wrapper's `h-full` relies on `.map-wrap`'s `height: 100%` resolving inside the grid cell, where the
   pilot's grid on `.map-wrap` stretched without it. Verify's mobile screenshot confirms it.
8. **`Contact.astro`: the iframe's inline `display:block; width:100%; min-height:480px` is dropped**.
   **Acceptable**: only a filter is carried from inline style, and `ConsentEmbed`'s iframe fills its box.
9. **`Contact.astro`: the filter rules.** Expected keeps `.map-wrap iframe {…}` and
   `.map-wrap:hover iframe {…}` exactly as they were, and adds `.map-wrap :global(iframe) { filter:
   sepia(15%) contrast(0.92) saturate(0.85); transition: filter 0.3s ease; }` and
   `.map-wrap:hover :global(iframe) { filter: none; }` after them. The pilot rewrote the rules in
   place, using the same two selectors, and deleted the size declarations. **Acceptable (Ruling 24)**:
   the new rules carry only `filter` and `transition`, so `min-height: 480px` no longer reaches
   ConsentEmbed's iframe. Same filter and hover as the pilot; the original rules stay but no longer
   match anything.
10. **`Contact.astro`: title `Karta till Exempel tapetserare, Exempelgatan 1, Exempelstad`** (as
    on the iframe); the pilot shortened it to `Karta till Exempel`. **Acceptable**: C8 lists shortened
    titles as hand decisions; the button-clip check in verify step 5 decides whether it fits.
11. **`Contact.astro`: no placeholder slot**; the pilot added the address. **Acceptable**: the default
    placeholder text is used.
12. **`Contact.astro`: one-line `<div …><ConsentEmbed … /></div>`**, the pilot's multi-line element.
    **Acceptable**: formatting only.
