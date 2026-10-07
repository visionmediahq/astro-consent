# DIFF: expected/ vs merged/ (nhrk)

`expected/` holds only `REFUSED.md`: the site is `needs-human` (unresolved calendar iframe `src` in
`src/pages/kalendrar.astro`), so `wire` plans no edits and the site is wired by hand. `merged/` is the
pilot's hand wiring. Verdicts: **acceptable** (the rules are fine here) or **rule gap** (the rules
fall short of the pilot on this site).

**Rulings applied:** none of Rulings 16–24 changes the outcome here: the site is still
`needs-human`, and `wire` refuses before any of those rules runs.

1. **Every change in `merged/`** (config, CSS `@source`, banner, footer and 404 links,
   `privacy.json`) is absent from `expected/`. **Acceptable**: refusing is the rule's intended output
   for a `needs-human` site; a human checks the Google Calendar iframes (not in the registry) before
   anything is wired.
