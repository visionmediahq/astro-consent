# Expected: wire refuses (site-1277834673)

Sites are named by GitHub repo ID (`gh api repositories/<id>`).

`detect(before, 'site-1277834673', ['site-1277834673.se'])` classifies the site `needs-human`, so `planWire` refuses the
whole plan (`ok: false`) and nothing is written (spec C2: "It refuses whenever
`report.classification === 'needs-human'`"; all or nothing). The refusal reasons must include every
line below, verbatim from `report.reasons`:

- unresolved iframe src in src/pages/kalendrar.astro
