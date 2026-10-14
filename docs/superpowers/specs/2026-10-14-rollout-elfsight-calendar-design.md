# Rollout tool: wire Elfsight and Google Calendar (#24, #19): design

Date: 2026-10-14. Status: decisions agreed 2026-10-14; plan next. Issue: #24 (checklist comment), #19.
Package side shipped in v1.1.0 (`elfsight`, `google-calendar`, `<ConsentWidget>`).
This is a repo-tool change (`ci/rollout/`), not a package release.

## Purpose

Today `detect` sends every Elfsight or Calendar site to `needs-human`:

```text
elfsight         -> banners += 'elfsight'                      (BANNERS /elfsight/i)
                 -> trackers += 'elfsight'                     (HOST_PATTERNS: elfsightcdn.com, elfsight.com)
google-calendar  -> "iframe service google-calendar is not wired by this batch"   (classify.iframeReason)
```

After this change `detect` → `wire` → `verify` take those sites through consent mode like a maps
site, and refuse (with a reason) every form they don't recognise. Success: each recognised widget
and Calendar iframe is wrapped, `privacy.json` lists the services, `verify` passes on a real pool
site of each variant, and nothing from either service loads before a grant.

Out of scope: wiring sites (a rollout after this PR, site-factory#232); any package change.
Precondition for a live rollout (not for merging this PR): #27 merged, because most pool sites
are on Astro 6.

## Markup variants (from the pool survey)

Surveyed 2026-10-14: every pool repo's default branch (git grep on shallow clones, deleted after).
15 pool sites use Elfsight; no pool site embeds Google Calendar.

```text
all 15: in an .astro file (11 components, 5 inline in a page; one site has both)
        one widget per page, script once per page
        script: <script src=… async> , 12 of 15 also is:inline, attribute order varies
                none has data-use-service-core, defer or type
        div:    <div class="elfsight-app-<uuid>" data-elfsight-app-lazy></div>, empty, nothing else
        none in a layout/<head>, .md/CMS content, set:html, .ts/.js, or injected by JS
        most have an HTML comment before it: <!-- Elfsight Instagram Feed | … -->

V1  (10) script directly before the div, siblings
          <script src="https://elfsightcdn.com/platform.js" async></script>
          <div class="elfsight-app-<uuid>" data-elfsight-app-lazy></div>
V2  (3)  script at the component's top level, div nested inside <section>; script before the
         section on one site, after it on two; on one the div spans several lines
V3  (1)  older loader https://static.elfsight.com/platform/platform.js, otherwise V1
V4  (1)  class built from import.meta.env.PUBLIC_ELFSIGHT_WIDGET_ID, div before script, both in a
         <Fragment> inside a ternary with a static fallback -> needs-human

Calendar: only on one pilot site that already has the package (3 iframes from a .map() with
  src={cal.src}); not a wire target. It is hand-wired outside this PR.
```

So pairing by adjacency would miss V2. Pairing is by file: one script and its divs in the same
`.astro` file.

## Report (`ci/rollout/types.ts`)

```text
Classification = 'consent' | 'notice' | 'needs-human'          // 'maps' goes (Decision 1)
Report += services: ServiceSlug[]       // sorted, unique: registry iframe services ∪ widget services
                                        //   ∪ services of already wired ConsentWidgets
Report += widgets: WidgetInfo[]

WidgetInfo:
  file                       // the .astro file holding the widget div
  start, end                 // the div element, where wire splices
  service: 'elfsight'
  script: string             // the loader URL as written (one of LOADERS)
  scriptAt: { start, end }   // the <script> element in the same file, which wire removes
  pages: string[]            // page files that render `file`: itself, a layout's pages, or the
                             // files that import the component (lib/site-imports), each mapped the
                             // same way (a page itself, a layout through layouts[].pages), for verify
```

## `detect`

Misreading goes one way: anything the reader is unsure of is a reason naming the file, so the
site goes to a human. Every Elfsight occurrence must be accounted for, not just every file.

```text
scripts.ts:
  BANNERS -= [/elfsight/i, 'elfsight']
  WIDGET_ONLY = Set(['elfsight'])            // like IFRAME_ONLY: widgets.ts is its only reporter
  all three tracker paths skip WIDGET_ONLY slugs: HOST_PATTERNS, the parsed-URL loop in
    trackersInText, and trackersInScript

widgets.ts (new) detectWidgets(files) -> { widgets, reasons, parseErrors }

  LOADERS = { 'https://elfsightcdn.com/platform.js',
              'https://static.elfsight.com/platform/platform.js' }   // narrowed by the probe
  ELFSIGHT = /elfsight(?:cdn)?\.com/i        // host occurrences
  APP      = /elfsight-app-/                 // class occurrences

  per .astro file under src/ (lib/astro-ast; parse error -> parseErrors, and the file's raw text
  is swept with nothing skipped):
    wired   = package <ConsentWidget> elements (resolved like the scan does: default import of
              @visionmediahq/astro-consent/components/ConsentWidget.astro); the WHOLE element is
              covered (its script prop and the div inside); their `service` goes into `wired`;
              they are neither widgets nor reasons
              // makes detect idempotent: a wired tree re-detects as consent (services include the
              // wired ones), no reasons
    scripts = <script> elements whose src attribute contains ELFSIGHT
    divs    = elements with a class attribute (any kind) containing APP, not in `wired`
    a script is recognised when:
      src is a quoted literal in LOADERS; other attributes only async, is:inline
      it is not inside an expression ({…}, a ternary, .map) – ancestry check, since elements()
        walks into expressions
    a div is recognised when:
      class is a quoted literal with exactly one token /^elfsight-app-[0-9a-f-]{36}$/
      other attributes only data-elfsight-app-lazy
      children are only whitespace text   // a multi-line empty div is fine
      not inside an expression
    the file has exactly one recognised script and >= 1 recognised divs, and no unrecognised
      script or div  -> one WidgetInfo per div; the script's src span and each div are covered
    otherwise one reason per problem, e.g.
      "elfsight: <file>: elfsight script with no widget div"
      "elfsight: <file>: widget div with no elfsight script"   // also: script in a layout, div in a page
      "elfsight: <file>: two elfsight scripts"
      "elfsight: <file>: script attribute defer not understood"
      "elfsight: <file>: loader <url> not recognised"
      "elfsight: <file>: widget div class is not a literal" / "… inside an expression" / "… has <x>"

  occurrence sweep, every ELFSIGHT or APP match must be covered:
    .astro: matches inside the parser's comment nodes are skipped (HTML comments; the AST already
            drops JS comments inside expressions); every other match outside a covered span -> reason
            "elfsight: <file>: elfsight outside a recognised widget"
    every other text file under src/ and public/, and astro.config.*: nothing is stripped, any
            match -> the same reason      // a commented snippet in .ts goes to a human: safe side
    exception: public/_headers lines that are a Content-Security-Policy header value are not
            loads (one pool site names elfsightcdn.com in its CSP)
  package.json dependencies, astro.config imports and frontmatter import specifiers matching
    /elfsight/i -> reason "elfsight: package <name>" / "elfsight: import <spec> in <file>"
    // replaces what BANNERS caught: an Elfsight wrapper package or island

classify.ts:
  iframeReason: service 'google-calendar' -> null (wired like google-maps)
  widget reasons added as they are
  classification: needs-human if reasons; 'consent' if services non-empty; else 'notice'

report line (run.ts, pool.ts): "<site> (<domains>): consent (elfsight, google-maps)" | "…: notice"

stored reports written before this PR (pool.json rows, <site>/.rollout/report.json, the demo report):
  normaliseReport: classification 'maps' -> 'consent'; widgets missing -> []; services missing ->
    from iframes; applied by every reader (run.ts, pr.ts, live.ts, merge.ts, select.ts, pool.ts)
  pool rows written before this PR are re-detected on the next pool run (a row without
    `services`), because old rows carry banners ['elfsight'], which normalising cannot undo

select.ts strata 'consent' / 'notice': consent = any registry iframe whatever its srcKind (as today
  for maps), or any widget
```

## `wire`

```text
embeds.ts (iframes): no change in logic. A literal google-calendar iframe goes through the maps
  path: <ConsentEmbed service="google-calendar" src=… title=…/>, box rules unchanged.

widgets.ts (new) wireWidgets(planner, report):
  per file with widgets:
    wireImport(planner, file, 'ConsentWidget')       // PackageComponent += 'ConsentWidget'
    each div -> 
      <ConsentWidget service="elfsight" script="<w.script>" title="Innehållet">   // Decision 2
      <the div's text exactly as written, lines unchanged>
      </ConsentWidget>
      the opening and closing tags take the div's indentation; the div is not re-indented
    the file's script element is removed, and its line when the line holds only it
  a div or script not found at its offset -> refusal

privacy.ts: services = report.services. An existing privacy.json (left alone today) that lacks a
  service in report.services -> refusal "privacy.json exists without <slug>"; the build would
  fail on it otherwise (fails closed, but late)

index.ts: INSTALL_SPEC = 'github:visionmediahq/astro-consent#semver:^1.1.1'
  parts: [wireConfig, wireCss, wireLayout, wireLinks, wirePrivacy, wireEmbeds, wireWidgets]
```

## Older loader (V3) and `data-use-service-core`

The probe below also loads a second widget div after the loader has run (two widgets in one
file share one script). The spec records results without real widget ids.


No pool site uses `data-use-service-core`, so `loadScript` not copying attributes costs nothing;
`detect` refuses any script attribute beyond src/async/is:inline anyway. `static.elfsight.com`
already belongs to `elfsight` in the registry (`elfsight.com` suffix), so `<ConsentWidget>`
accepts the URL as written.

```text
probe (before code), real browser, one page with the V3 div:
  load https://static.elfsight.com/platform/platform.js the way loadScript does (async, appended
  to <head> after load)
  -> renders: wire keeps the URL as written
  -> doesn't: wire writes https://elfsightcdn.com/platform.js instead (probe that it renders the
     same div); neither renders -> V3 is refused
```

Probe result (2026-10-14, Chromium 1200x900, headless, real Elfsight hosts; the page was served from
a made-up https origin, the loader script was appended to `<head>` with `async` after `load`, as
`loadScript` does; the widget div had `data-elfsight-app-lazy`):

| Loader | First div gets children | Second div added afterwards |
|---|---|---|
| `https://static.elfsight.com/platform/platform.js` | renders (about 1.0 s) | renders (about 1.8 s) |
| `https://elfsightcdn.com/platform.js` | renders (about 0.8 s) | renders (about 1.5 s) |

Outcome: the static loader renders, so `wire` keeps the URL as written for V3, and both loaders
stay in `LOADERS`. A second widget div added after the loader has run also renders, so the
"exactly one widget div per file" fallback is not needed.

```text
Not taken (both loaders render): static loader dropped -> V3 is refused ("loader … not recognised");
           second div does not render -> a file must have exactly one widget div (two -> reason)
```

## `verify`

```text
consent-paths.ts, one-off Visa check: unchanged (clicks the first embed; asserts exactly one
  active, no foreign requests, nothing after reload).
filter reading (#24 checklist): filterRoutes returns route -> service of the filtered iframe
  (expectFilter(path) -> ServiceSlug | null)
  first embed is of that service -> its reading as today
  otherwise, after the reload step: click the first [data-consent-embed=<that service>]'s Visa and
    read its iframe's filter
  no embed of that service on the page -> filterKept null, note "filter: no <service> embed on the page"
  // today a widget or unfiltered calendar above a filtered map reads 'none' and step 4 FAILs

embedRoutes (was mapRoutes) = iframe routes ∪ routes of each widget's `pages`
step 4 no-embed branch: `classification !== 'maps'` -> `!== 'consent'`
demo: a page with a widget above a filtered map, in EMBED_PAGES and in demo-report.json
```

## Rollout note (not tool code)

One Elfsight site has a `_headers` Content-Security-Policy that names `elfsightcdn.com`. Moving the
script from markup to `loadScript` does not change which hosts load, so the CSP is unaffected;
`verify` renders the widget after a grant on the preview, which would show a CSP block.

## `pr`

```text
pr-body.sv.md: today {{#maps}} speaks of Google Maps only.
templateKind(privacy.json) -> 'consent' | 'notice'    // consent when services is non-empty
the consent block names the services from privacy.json with their Swedish registry names
  (Google Maps, Google Kalender, Elfsight) and the "Visa <name>" button text per service
```

## Tests (each failing first)

```text
fixtures (tests/unit/rollout/fixtures/, .txt, scanned with scan-secrets.ts): one per variant,
  copied from a pool site with ids replaced
detect:
  V1, V2 (script before and after the section, multi-line div), V3 -> one widget each, no banner,
    no tracker, classification 'consent'
  V4 (env-built class in a ternary) -> needs-human, reason names the file
  script with no div / div with no script / two scripts in a file / script with defer /
    elfsight in .md / in set:html -> needs-human, reason names the file
  calendar iframe -> no reason, classification 'consent'
  a second loader in the same file as a recognised widget (inline script, src={x}, <head> slot)
    -> reason (per-occurrence sweep)
  an elfsight package dependency or import -> reason
  a commented snippet: in .astro HTML comment -> nothing; in a .ts comment -> reason
  public/_headers CSP naming elfsightcdn.com -> nothing
  an already wired tree (div inside a package ConsentWidget) -> consent, no reasons
  widget in a component -> WidgetInfo.pages lists the importing pages
  BANNERS no longer lists elfsight; a real banner (cookiebot) still does
wire:
  every Report/Classification consumer: 'consent' + services; an old 'maps' report reads as
    consent (google-maps)
  each variant -> exact expected output (golden), import added once, script removed once
  calendar iframe (synthetic fixture: no pool site has one) -> ConsentEmbed with src/title as
    written, box rules as for maps
  privacy.json lists elfsight / google-calendar
  an existing privacy.json without elfsight -> refusal
  wiring the expected tree plans nothing (idempotence)
  INSTALL_SPEC pinned to ^1.1.1
verify:
  consent-paths: widget above a filtered map -> filterKept true (was a FAIL)
  unfiltered calendar above a filtered map -> the map's reading (filterKept true)
  filter expected but no embed of that service -> filterKept null with the note
  the one-off check still sees exactly one active embed when a map click follows
pr:
  privacy.json with elfsight + google-maps -> consent block names both
end to end: `verify --demo` on the consent demo still passes (it has /flode and /nastlad)
```

## Decisions (agreed 2026-10-14)

1. **Classification:** `'consent' | 'notice' | 'needs-human'` plus `Report.services`. The report
   line names the services, so the technician sees what will be gated. The tool can tell a map,
   a calendar and an Elfsight widget apart by service; it cannot tell what an Elfsight widget shows
   (feed, reviews, form: the markup is the same empty div).
2. **Widget title:** `title="Innehållet"` for every wired widget ("Innehållet hämtas från
   Elfsight."); a technician can change it in the PR.
3. **Calendar:** keep the small generic change (classify stops blocking it, `embeds.ts` wraps a
   literal iframe) with a synthetic test. The pilot site's `.map()` calendars are hand-wired in its
   own repo. `wire` does not learn `src={…}` expressions.

Related, out of scope: #36 (detect flags third-party `<script src>` hosts outside the registry).
