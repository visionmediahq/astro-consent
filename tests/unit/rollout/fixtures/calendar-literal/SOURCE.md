# calendar-literal

Synthetic: no pool site embeds Google Calendar (the one Calendar site is a pilot whose iframes come
from a `.map()` with `src={cal.src}`, out of scope). The site files are `elfsight-v1`'s (config,
CSS, layout, footers, lockfile), without the widget; `src/pages/index.astro` and
`src/pages/kalender.astro` are written for this fixture. Every file has a `.txt` suffix.

`kalender.astro` holds one literal Calendar iframe:
`src="https://calendar.google.com/calendar/embed?src=x%40group.calendar.google.com&ctz=Europe%2FStockholm"`,
`title="Kalender"`, `height="600"`, `style="border:0"`.

## Secret scan

`npx tsx ci/rollout/scan-secrets.ts tests/unit/rollout/fixtures`: 0 hits.

## Detect

`detect(before, 'calendar-literal', ['calendar-literal.se'])`: `consent (google-calendar)`, no
reasons.

## Expected

`expected/` is `before/` with the wire rules applied by hand. The iframe goes through the maps path
unchanged (spec, `wire`: "embeds.ts: no change in logic"): `height="600"` is a fixed height, so
`<div class="grid h-[600px]"><ConsentEmbed service="google-calendar" src=… title="Kalender"
aspect="auto" /></div>`, `src` and `title` copied as written. `privacy.json` lists
`google-calendar`.
