# DIFF: expected/ vs merged/ (aspomad)

`expected/` is `before/` with spec C2's edits applied by hand (Task 15), the oracle for `planWire`.
`merged/` is what the pilot PR merged. Each entry below is one difference between them, with a
verdict: **acceptable** (the rule's output is fine; the pilot made a hand decision) or **rule gap**
(the rule's output is worse than the pilot's on this site: a finding for the rollout).

**Out of scope:** `package.json` and `package-lock.json`. The npm install runs at apply time
(`applyWire`), not in the plan, so `expected/` keeps both exactly as in `before/`. The pilot's
dependency and lockfile changes in `merged/` are checked by verify step 1 (lockfile allowlist), not
by this oracle, and are not listed below.

**Detect input** (`detect(before, 'aspomad', ['aspomad.se'])`): `maps`; no `integrations` in the config;
layout `Base.astro` with footer reference `Footer`; one footer, `src/components/Footer.astro`,
`textClass: text-neutral-content`, centred; footerless: none (the 404 renders the layout's footer);
no policy page; one Google Maps iframe in `ContactMap.astro` whose `src` comes from
`src/data/kontakt.json` (`height="100%"`, no classes, no inline filter).

Identical in both: the config import, the CSS `@source` line, `<ConsentBanner />` before `<Footer />`,
and `src/data/privacy.json`.

## Differences

1. **`astro.config.ts`: `integrations: [consent()],` is the last property of `defineConfig`** (after
   `vite`); the pilot put it first. **Acceptable**: property order does not matter.
2. **`Base.astro`: the ConsentBanner import comes after `import '../styles/global.css'`**; the pilot put
   it before the two CSS imports. **Acceptable**: import order only (see munkfors entry 2).
3. **`Footer.astro`: the PrivacyLinks import comes after the last import (`../lib/hours`)**; the pilot
   put it between `kontakt.json` and `../lib/hours`. **Acceptable**: import order only.
4. **`Footer.astro`: `<PrivacyLinks class="text-neutral-content" />` is the last child of `<footer>`**,
   below the centred bottom bar; the pilot put `<PrivacyLinks class="text-neutral-content/80 mt-2" />`
   inside the bar under ©. **Acceptable**: the footer is centred, so the links are centred under the bar
   in the footer's own text colour; the difference is opacity and spacing.
5. **`ContactMap.astro`: the map box.** Expected puts `<div class="grid h-[100%]">` with `aspect="auto"`
   inside the unchanged `<section class="w-full h-[500px] relative">`; the pilot added `grid` to the
   section itself. **Acceptable**: the same 500 px box either way.
6. **`ContactMap.astro`: no `href`, no placeholder slot, no `address`/`mapsLink` constants**; the pilot
   added all three. **Acceptable**: C8 lists `href` workarounds and placeholder text as hand decisions;
   the component's default link (de-embedded `src`) and default text are used.
7. **`ContactMap.astro`: the scoped `<style>` (`iframe { filter: grayscale(0.2) }` and its `:hover`)
   is left as is**; the pilot rewrote it to `section :global(iframe)`. **Rule gap**: C2 carries only a
   filter on the iframe's own `style`; a filter in a scoped style rule that targets the iframe silently
   stops applying, because the iframe is now rendered by `ConsentEmbed`, outside this component's
   scope. Detect should report scoped `iframe` rules (or wire should rewrite them with `:global`), or
   the site needs a human. Verify's `filterKept` check would catch it.
8. **`ContactMap.astro`: the ConsentEmbed import comes after `kontakt.json`**; the pilot put it before.
   **Acceptable**: import order only.
9. **`ContactMap.astro`: one-line `<div …><ConsentEmbed … /></div>`**, the pilot's multi-line element.
   **Acceptable**: formatting only.
