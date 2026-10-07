# DIFF: expected/ vs merged/ (munkforstradgardstjanst)

`expected/` is `before/` with spec C2's edits applied by hand (Task 15), the oracle for `planWire`.
`merged/` is what the pilot PR merged. Each entry below is one difference between them, with a
verdict: **acceptable** (the rule's output is fine; the pilot made a hand decision) or **rule gap**
(the rule's output is worse than the pilot's on this site: a finding for the rollout).

**Out of scope:** `package.json` and `package-lock.json`. The npm install runs at apply time
(`applyWire`), not in the plan, so `expected/` keeps both exactly as in `before/`. The pilot's
dependency and lockfile changes in `merged/` are checked by verify step 1 (lockfile allowlist), not
by this oracle, and are not listed below.

**Detect input** (`detect(before, 'munkforstradgardstjanst', ['munkforstradgardstjanst.se'])`):
`notice`; layout `Base.astro` with footer reference `VisionFooter` (the client `Footer` is rendered by
`index.astro`); one footer, `src/components/Footer.astro`, `textClass: text-neutral-content`, not
centred; footerless: `404.astro`; no policy page.

Identical in both: the config import, the CSS `@source` line, `<ConsentBanner />` before
`<VisionFooter />`, the PrivacyLinks imports, and `src/data/privacy.json` (`{"services": []}`).

## Differences

1. **`astro.config.ts`: `consent()` is the last element of `integrations`** (after `sitemap(),`); the
   pilot put it first, above the comments. **Acceptable**: integration order does not matter here, and
   appending keeps the comment block attached to `sitemap()`.
2. **`Base.astro`: the ConsentBanner import comes after `import '../styles/global.css'`**; the pilot put
   it before. **Acceptable**: frontmatter import order only; the package's `contrast.css` lands after
   the site CSS, which is the order its override is meant for.
3. **`Footer.astro`: `<PrivacyLinks>` is the last child of `<footer>`**, below the bottom bar; the pilot
   put it at the end of the last column (hours) with `mt-5`. **Acceptable**: spec C2 says the rule does
   not reproduce munkfors' hand placement; the links are still in the footer, in the footer's colour.
4. **`Footer.astro`: the links sit outside `<div class="max-w-6xl mx-auto px-4 md:px-6">`**, so with
   `justify-start!` they start at the footer's left edge with no side padding. **Rule gap**: "last
   child of `<footer>`" lands outside the padded inner container on footers whose padding lives on a
   wrapper; the rule should insert into the footer's last-child container (the chain detect follows for
   `centred`) or give the links the container's padding.
5. **`Footer.astro`: class `text-neutral-content justify-start!`**, the pilot's `text-neutral-content
   mt-5 justify-start!`. **Acceptable**: same colour and alignment; `mt-5` was spacing for the hand
   placement.
6. **`404.astro`: `<PrivacyLinks />` is the last child of `<main>`**; the pilot put it inside the centred
   box under the back button. **Rule gap**: this `<main>` is `flex items-center justify-center` (a row),
   so its last child sits beside the 404 box, not under it. C2's premise ("under the back button, which
   is the end of `<main>`") does not hold: the back button ends `<main>`'s last child, not `<main>`.
7. **`404.astro`: no class**, the pilot's `mt-8 text-base-content/70`. **Acceptable**: C2's footerless
   rule has no class source; the links inherit `text-base-content`, which is readable on `bg-base-100`.
