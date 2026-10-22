# Expected: wire refuses (site-1271984151)

Sites are named by GitHub repo ID (`gh api repositories/<id>`).

`detect(before, 'site-1271984151', ['site-1271984151.se'])` classifies the site `needs-human`, so `planWire` refuses the
whole plan (`ok: false`) and nothing is written (spec C2: "It refuses whenever
`report.classification === 'needs-human'`"; all or nothing). The refusal reasons must include every
line below, verbatim from `report.reasons`:

- unresolved iframe src in src/components/KontaktMap.astro
- existing banner: home-made gate: localStorage 'maps-consent' in src/components/KontaktMap.astro
