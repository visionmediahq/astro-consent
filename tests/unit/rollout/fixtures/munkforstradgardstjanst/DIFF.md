# DIFF: expected/ vs merged/ (munkforstradgardstjanst)

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

**Detect input** (`detect(before, 'munkforstradgardstjanst', ['munkforstradgardstjanst.se'])`):
`notice`; layout `Base.astro` with footer reference `VisionFooter` (the client `Footer` is rendered by
`index.astro`); one footer, `src/components/Footer.astro`, `textClass: text-neutral-content`; its
last-child chain ends in the `justify-between` bottom bar, so `justify-start!` is added (Ruling 18);
footerless: `404.astro`; no policy page.

Identical in both: the config import, the CSS `@source` line, `<ConsentBanner />` before
`<VisionFooter />`, the PrivacyLinks imports, and `src/data/privacy.json` (`{"services": []}`).

## Differences

1. **`astro.config.ts`: `consent()` is the last element of `integrations`** (after `sitemap(),`); the
   pilot put it first, above the comments. **Acceptable**: integration order does not matter here, and
   appending keeps the comment block attached to `sitemap()`.
2. **`Base.astro`: the ConsentBanner import comes after `import '../styles/global.css'`**; the pilot put
   it before. **Acceptable**: frontmatter import order only; the package's `contrast.css` lands after
   the site CSS, which is the order its override is meant for.
3. **`Footer.astro`: `<PrivacyLinks class="text-neutral-content justify-start!" />` is the last child
   of `<div class="max-w-6xl mx-auto px-4 md:px-6">`**, below the bottom bar; the pilot put it at the
   end of the last column (hours) with `mt-5`. **Acceptable (Ruling 17)**: `<footer>`'s only child is
   that container, so the links sit inside its padding, left-aligned like the split bar; C2 does not
   reproduce munkfors' hand placement, and `mt-5` was spacing for it.
4. **`404.astro`: `<PrivacyLinks />` with no class**, the pilot's `mt-8 text-base-content/70`, both at
   the end of the centred box under the back button. **Acceptable (Ruling 16)**: same position (the
   only child of `<main>`); C2's footerless rule has no class source, and the links inherit
   `text-base-content`, which is readable on `bg-base-100`.
