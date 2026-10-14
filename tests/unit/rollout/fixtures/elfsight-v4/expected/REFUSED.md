# Expected: wire refuses (elfsight-v4)

`detect(before, 'elfsight-v4', ['elfsight-v4.se'])` classifies the site `needs-human`: the widget's
class is built from `import.meta.env.PUBLIC_ELFSIGHT_WIDGET_ID`, and the div and the loader sit in a
`<Fragment>` inside a ternary with a static fallback. `planWire` refuses the whole plan and nothing
is written. The refusal reasons are exactly the lines below, verbatim from `report.reasons`:

- elfsight: src/components/InstagramFeed.astro: elfsight script inside an expression
- elfsight: src/components/InstagramFeed.astro: widget div class is not a literal
- elfsight: src/components/InstagramFeed.astro: widget div inside an expression
- elfsight: src/components/InstagramFeed.astro: elfsight outside a recognised widget
