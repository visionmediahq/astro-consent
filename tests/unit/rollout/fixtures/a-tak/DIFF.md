# DIFF: expected/ vs merged/ (a-tak)

`expected/` holds only `REFUSED.md`: the site is `needs-human` (a home-made `localStorage` map gate
whose script sets the iframe `src`), so `wire` plans no edits and the site is wired by hand.
`merged/` is the pilot's hand wiring. Verdicts: **acceptable** (the rules are fine here) or
**rule gap** (the rules fall short of the pilot on this site).

**Rulings applied:** none of Rulings 16–22 changes the outcome here: the site is still
`needs-human`, and `wire` refuses before any of those rules runs.

1. **Every change in `merged/`** (config, CSS `@source`, banner, footer and 404 links,
   `privacy.json`, and `KontaktMap.astro` rewritten from the home-made gate to `ConsentEmbed`) is
   absent from `expected/`. **Acceptable**: removing an existing consent gate and its script is a
   judgement call the spec leaves to a human; refusing is the rule's intended output.
