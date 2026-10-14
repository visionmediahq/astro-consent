# Rollout tool: Elfsight and Google Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `detect` → `wire` → `verify` → `pr` take Elfsight sites (and literal Google Calendar
iframes) through consent mode, and send every form they don't recognise to a human.

**Architecture:** A new `detect/widgets.ts` recognises Elfsight widgets per file (one loader
script plus its divs) and accounts for every Elfsight occurrence on the site; anything unaccounted
for is a needs-human reason. The classification becomes `'consent' | 'notice' | 'needs-human'`
with `Report.services`; stored reports from before are normalised on read. A new
`wire/widgets.ts` wraps each div in `<ConsentWidget>` and removes the script. `verify` reads the
filter from the first iframe embed and knows widget routes; `pr` names each service.

**Tech Stack:** TypeScript (strict), vitest, the repo's `lib/astro-ast`, `lib/ts-ast`, `lib/site-imports`; Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-rollout-elfsight-calendar-design.md` (read it whole; this plan argues from it)

Plans in this repo are pseudocode by the user's choice: each step names files, behaviour and test
cases; the implementer writes TypeScript in the style of the surrounding file.

## Global Constraints

- CLAUDE.md is binding: TypeScript only; fixtures are `.txt` under `tests/unit/rollout/fixtures/`, scanned with `npx tsx ci/rollout/scan-secrets.ts` before commit; tests never reach real hosts; failing test first; every commit leaves `npm run check && npm test` green.
- Public repo: no client names in any new tracked file: no repo names, domains, business names, `astro.config` `site:` values, package `name`s, or names inside `<!-- Elfsight … | <name> -->` comments. New fixture dirs: `elfsight-v1`, `elfsight-v2-before`, `elfsight-v2-after`, `elfsight-v3`, `elfsight-v4`, `calendar-literal`; widget ids replaced with `00000000-0000-0000-0000-00000000000N`.
- Stage files by path; `c24.md`, `g.md`, `h.md` in the repo root are the user's and stay untracked.
- `INSTALL_SPEC = 'github:visionmediahq/astro-consent#semver:^1.1.1'`.
- Widget title: `title="Innehållet"`.
- `Classification = 'consent' | 'notice' | 'needs-human'`; stored reports with `'maps'` still load.
- `LOADERS = { 'https://elfsightcdn.com/platform.js', 'https://static.elfsight.com/platform/platform.js' }`, narrowed by Task 0.
- Recognised script: `src` quoted literal in LOADERS; other attributes only `async`, `is:inline`; not inside an expression. Recognised div: `class` quoted literal with exactly one `elfsight-app-<uuid>` token; other attributes only `data-elfsight-app-lazy`; children only whitespace text; not inside an expression.
- Every Elfsight occurrence (`/elfsight(?:cdn)?\.com/i`, `/elfsight-app-/`) must fall in a covered span; `.astro` HTML comment nodes are skipped; nothing is stripped in any other file; CSP header lines in `public/_headers` are not loads.
- Out of scope: #36, `src={…}` Calendar expressions, the pilot site's calendars.

## Review Focus

1. Loader in a **layout**, divs in pages → two reasons ("script with no widget div", "div with no script"); never half-wired. Task 2.
2. **Same widget id on two pages**, each with its own script → both wired, each script removed. Task 4.
3. **Old stored reports** (`'maps'`, no `services`/`widgets`) in `.rollout/report.json` → every command still runs; old pool rows are re-detected. Task 3.
4. **A second Elfsight load in a file that also holds a recognised widget** (inline script, `src={url}`, a `<head>` slot) → reason. Task 2.
5. **Widget above a filtered map**, and the one-off check still sees exactly one active embed. Task 6.

---

### Task 0: Probe the loaders

**Files:** the spec's "Older loader (V3)" section only.

- [ ] Step 1: Scratch Playwright script in the scratchpad (never in the repo). Serve a page via `route.fulfill` with one `<div class="elfsight-app-<a real id from the survey file>" data-elfsight-app-lazy></div>`; after load, append `<script src=LOADER async>` to `<head>` as `client.ts` `loadScript` does; wait up to 20 s for children in the div. Elfsight hosts pass through: this probe reaches real hosts on purpose; it is not a test.
- [ ] Step 2: Run it for each LOADER. Then, with the loader already run, append a second div with another real id from the survey and wait again.
- [ ] Step 3: Write the results in the spec WITHOUT the ids: per loader `renders` / `doesn't`, and the second-div result, date. Apply the spec's rule and update this plan before Task 1:
  - static loader renders → keep (WIRED count in Task 4 = 10).
  - only elfsightcdn renders the V3 div → Task 4 writes `script="https://elfsightcdn.com/platform.js"` for V3 (count 10).
  - neither → drop it from LOADERS; `elfsight-v3/expected/REFUSED.md` "loader … not recognised"; the V3 detect test becomes a reason case (count 9).
  - second div does not render → "exactly one widget div per file": the two-div tests in Tasks 2 and 4 become reason/refusal cases.
- [ ] Step 4: `git add` the spec; commit `docs: Elfsight loader probe`.

### Task 1: Classification `consent`, `Report.services`, `Report.widgets`

**Files:**
- Modify: `ci/rollout/types.ts`, `ci/rollout/detect/classify.ts`, `ci/rollout/detect/index.ts`, `ci/rollout/verify.ts` (`!== 'maps'`)
- Create: `ci/rollout/lib/report.ts`
- Modify tests that build Reports or use `'maps'`: `tests/unit/rollout/detect.test.ts`, `wire-parts.test.ts`, `wire-config.test.ts`, `select.test.ts`, `pr.test.ts`, `verify.test.ts`, `live.test.ts`, `__snapshots__/*`, `fixtures/demo-report.json`

**Interfaces:**
- Produces:
  ```text
  type Classification = 'consent' | 'notice' | 'needs-human'
  interface WidgetInfo { file: string; start: number; end: number; service: 'elfsight';
                         script: string; scriptAt: { start: number; end: number }; pages: string[] }
  Report += services: ServiceSlug[]; widgets: WidgetInfo[]
  lib/report.ts:
    servicesOf(r: Pick<Report,'iframes'|'widgets'>, wired: ServiceSlug[] = []): ServiceSlug[]
      // sorted, unique: iframes with srcKind !== 'unresolved' && service !== null, ∪ widgets' service ∪ wired
    normaliseReport(raw: unknown): Report
      // 'maps' -> 'consent'; widgets missing -> []; services missing -> servicesOf
  ```

- [ ] Step 1: Failing tests (`detect.test.ts`): classify expectations `'maps'` → `'consent'`; `clean({ iframes: [frame({ service: 'google-calendar' })] })` → `{ classification: 'consent', reasons: [] }`; `servicesOf` (maps + calendar + widget → sorted; unresolved and own iframes left out); `normaliseReport` of an old `'maps'` report → consent, `services: ['google-maps']`, `widgets: []`.
- [ ] Step 2: `npx vitest run tests/unit/rollout/detect.test.ts` → FAIL.
- [ ] Step 3: Implement: types; `lib/report.ts`; `classify` (`iframeReason` null for google-calendar; consent when `servicesOf(findings)` non-empty; `Findings` gains `widgets`); `detect()` sets `widgets: []` (Task 2 fills it) and `services`; `verify.ts` `!== 'maps'` → `!== 'consent'`. Add `services`/`widgets` to every test Report builder and `demo-report.json`; `'maps'` → `'consent'` in tests. `pr.ts` `kind`/`templateKind` stay `'maps' | 'notice'` until Task 5 (they key on privacy.json, not the classification).
- [ ] Step 4: Update snapshots (`npx vitest run -u tests/unit/rollout/detect.test.ts`) and read the diff: only `classification`, `services`, `widgets` may change.
- [ ] Step 5: `npm run check && npm test` → PASS. Commit `rollout: classification consent with Report.services`.

### Task 2: `detect/widgets.ts`

**Files:**
- Create: `ci/rollout/detect/widgets.ts`; Test: `tests/unit/rollout/detect-widgets.test.ts` (inline strings through an in-memory `SiteFiles`; NO fixture dirs in this task: `wire-fixtures.test.ts` picks up every dir)
- Modify: `ci/rollout/detect/scripts.ts` (BANNERS, WIDGET_ONLY), `ci/rollout/detect/index.ts`, `ci/rollout/detect/classify.ts`, `ci/rollout/wire/index.ts` (temporary guard)

**Interfaces:**
- Consumes: `WidgetInfo`, `Report.widgets` (Task 1); `astroImports`, `resolveRelative` (`lib/site-imports.ts`) for `pages`
- Produces: `detectWidgets(files: SiteFiles, layouts: Report['layouts']): { widgets: WidgetInfo[]; wired: ServiceSlug[]; reasons: string[]; parseErrors: { file: string; message: string }[] }`; `detect()` sets `services = servicesOf(findings, wired)`

- [ ] Step 1: Failing tests:
  ```text
  V1 script then div, siblings                         -> 1 widget, script, scriptAt, pages ['src/pages/x.astro']
  V1 with is:inline, attributes in another order       -> 1 widget
  V2 script before <section>, div nested               -> 1 widget
  V2 script after </section>, div over 3 lines         -> 1 widget (whitespace children)
  V3 static.elfsight.com loader                        -> 1 widget, script as written
  two divs + one script in one file                    -> 2 widgets, same scriptAt
  widget in src/components/Feed.astro imported by / and /om -> pages = both page files
  widget in a layout                                   -> pages = the layout's pages
  V4 class={`elfsight-app-${id}`} in a ternary         -> 0 widgets, reason "… widget div class is not a literal"
  literal div and script inside {cond ? (…) : …}       -> reason "… inside an expression"
  script, no div in file / div, no script in file      -> the two reasons
  loader in layout, div in page                        -> both reasons (Review Focus 1)
  two loaders in one file                              -> "… two elfsight scripts"
  defer / type / data-use-service-core on the script   -> "… script attribute <x> not understood"
  loader https://apps.elfsight.com/p/platform.js       -> "… loader <url> not recognised"
  div with a child element or another attribute        -> "… widget div has <x>"
  recognised widget + <script is:inline>…elfsightcdn…</script> in the same file -> "… elfsight outside a recognised widget" (Review Focus 4)
  recognised widget + const u = 'https://elfsightcdn.com/platform.js' in frontmatter -> the same
  elfsightcdn in a .md, .ts, .json, set:html string, astro.config.mjs -> the same, per file
  snippet inside <!-- --> in .astro                    -> nothing
  snippet inside // or /* */ in a .ts file             -> reason (nothing stripped outside .astro)
  public/_headers: Content-Security-Policy: … https://elfsightcdn.com … -> nothing
  public/_headers other line naming elfsight           -> reason
  package.json dependency "react-elfsight-widget"      -> "elfsight: package react-elfsight-widget"
  frontmatter import from 'elfsight-…'                 -> "elfsight: import … in <file>"
  a package <ConsentWidget service="elfsight" script="https://elfsightcdn.com/platform.js"> with the div inside
                                                       -> no widget, no reason, wired ['elfsight'] (whole element covered)
  widget in a component imported only by a layout      -> pages = the layout's pages
  .css or scoped <style> rule naming .elfsight-app-…   -> reason (over-refusal accepted; counted separately in Step 5)
  the word "Elfsight" in visible text                  -> nothing
  ```
  And in `detect.test.ts` (inline site): V1 site → `banners: []`, `trackers: []`, `classification: 'consent'`, `services: ['elfsight']`; a cookiebot script still → banner.
- [ ] Step 2: `npx vitest run tests/unit/rollout/detect-widgets.test.ts tests/unit/rollout/detect.test.ts` → FAIL.
- [ ] Step 3: Implement per the spec's `detect` section. Ancestry: walk `tree.root` keeping a stack; a node with an `expression` ancestor is "inside an expression". Covered spans: each recognised script's `src` attribute value span, each recognised div, each wired package `ConsentWidget` element whole; then sweep the raw text for both patterns, skipping matches inside `comment` nodes (`.astro` only). `pages`: a page file → itself; a layout → `layouts.find(...).pages`; a component → files whose frontmatter `astroImports` resolve (`resolveRelative`) to it, one level, each mapped as above (a page itself, a layout through `layouts[].pages`); none found → `[]`. `scripts.ts`: remove the BANNERS row; `WIDGET_ONLY`; skip it in all three tracker paths: `HOST_PATTERNS`, the parsed-URL loop in `trackersInText` (scripts.ts:106-109) and `trackersInScript` (:113-120). `classify` adds widget reasons. `wire/index.ts` `planWire`: if `report.widgets.length > 0`, refuse `widgets` "Elfsight wiring lands in the next commit" (removed in Task 4), so no commit can wire a site and leave the raw loader.
- [ ] Step 4: Run → PASS; `npm run check && npm test`.
- [ ] Step 5: Detect over the 15 surveyed sites (list in the scratchpad survey file): shallow clone each into the scratchpad, `npx tsx ci/rollout/run.ts detect <dir>`, note its `astro.config` `site:` host and `package.json` `name` in a scratchpad names list (for Task 4's grep), delete the clone. Expected: V1/V2/V3 sites `consent` or needs-human only for non-Elfsight reasons; the CSP site consent; V4 needs-human with the class reason. Write counts per outcome (no names) into the commit body, with Elfsight-in-CSS refusals as their own line. Any other Elfsight reason on a V1–V3 site is a bug: stop and report it.
- [ ] Step 6: Commit `rollout detect: Elfsight widgets are a service, not a banner`.

### Task 3: Stored reports and `select`

**Files:**
- Modify: `ci/rollout/run.ts` (`readReport`, the `--demo` read at :205), `ci/rollout/pr.ts` (`readJson<Report>`), `ci/rollout/live.ts:218`, `ci/rollout/merge.ts:59`, `ci/rollout/select.ts` (:87 and `strata`/`slots`), `ci/rollout/pool.ts` (resume rule, report line)
- Test: `run.test.ts`, `pr.test.ts`, `live.test.ts`, `select.test.ts`, `pool.test.ts`; a `merge` case where its test file has one

**Interfaces:** Consumes `normaliseReport`, `servicesOf` (Task 1).

- [ ] Step 1: Failing tests:
  ```text
  .rollout/report.json with 'maps', no services/widgets -> runWire dry run plans as before; live and
    merge read it without error (Review Focus 3)
  strata: row with widgets only -> consent; row with an unresolved maps iframe -> consent (as today,
    "whatever its srcKind"); keys consent/notice; slots ties go to consent
  scanPool: an existing row whose report has no `services` is re-detected; one with services is skipped
  report line: "consent (elfsight, google-maps)"
  ```
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement: every Report read goes through `normaliseReport`; `strata` consent = any iframe with `service !== null` (any srcKind) or any widget; rename `maps` → `consent` in `strata`/`slots` and callers; `scanPool` `done` excludes rows whose report lacks `services`; report line in `run.ts`/`pool.ts`.
- [ ] Step 4: Run → PASS; `npm run check && npm test`. Commit `rollout: old reports read as consent; strata consent/notice`.

### Task 4: `wire/widgets.ts`, Calendar, privacy, install spec, fixtures

**Files:**
- Create: `ci/rollout/wire/widgets.ts`
- Modify: `ci/rollout/wire/markup.ts` (`PackageComponent += 'ConsentWidget'`), `ci/rollout/wire/index.ts` (remove Task 2's guard, add `wireWidgets`, INSTALL_SPEC), `ci/rollout/wire/privacy.ts`
- Create fixtures (each `before/` + `expected/`, `SOURCE.md` "pool site, variant Vn", no names): `elfsight-v1`, `elfsight-v2-before`, `elfsight-v2-after` (multi-line div), `elfsight-v3`, `elfsight-v4` (`expected/REFUSED.md`), `calendar-literal` (synthetic page with `<iframe src="https://calendar.google.com/calendar/embed?src=x%40group.calendar.google.com&ctz=Europe%2FStockholm" title="Kalender" height="600" style="border:0" …>`)
- Modify: `tests/unit/rollout/wire-fixtures.test.ts` (counts: WIRED 5 → 10, or 9 if Task 0 refused V3; NEEDS_HUMAN adds `elfsight-v4` (and `elfsight-v3` if refused); `embedTarget` also matches `widget` and `ConsentWidget import` targets), `wire-parts.test.ts`

**Interfaces:**
- Consumes: `Report.widgets`, `WidgetInfo`, `servicesOf`
- Produces: `wireWidgets(planner: Planner, report: Report): void`

- [ ] Step 1: Write each `expected/` by hand from the spec before the code (expected is the oracle, as for the pilot fixtures):
  ```text
  the loader <script> element gone, and its line when alone on it; the comment before it stays
  <ConsentWidget service="elfsight" script="<as written, or per Task 0>" title="Innehållet">
  <the div's text exactly as written, lines unchanged>
  </ConsentWidget>
    opening and closing tags at the div's indentation
  frontmatter gains: import ConsentWidget from '@visionmediahq/astro-consent/components/ConsentWidget.astro'
  src/data/privacy.json: services from report.services (+ policy_url as the other fixtures)
  package.json: "@visionmediahq/astro-consent": "github:visionmediahq/astro-consent#semver:^1.1.1"
  ```
- [ ] Step 2: Failing tests (`wire-parts.test.ts`): two divs + one script → two wrappers, one removal, one import; same widget id in two files, each with its script (Review Focus 2) → both wired; a div offset that doesn't match → refusal "widget div at offset N not found"; existing `privacy.json` without `elfsight` → refusal "privacy.json exists without elfsight"; `INSTALL_SPEC` value. The fixtures test covers golden output and idempotence (re-detect of `expected/` is consent with no reasons, and plans nothing).
- [ ] Step 3: `npx vitest run tests/unit/rollout/wire-fixtures.test.ts tests/unit/rollout/wire-parts.test.ts` → FAIL.
- [ ] Step 4: Implement per the spec's `wire` section; `wirePrivacy` writes `report.services` and refuses an existing file missing one of them.
- [ ] Step 5: Run → PASS; `npm run check && npm test`; scan-secrets on the fixtures; names grep: build the list from the survey file's repo names, the 15 rows' `domains` in `~/sites/consent-rollout/pool.json`, and each cloned site's `astro.config` `site:` host and `package.json` `name` (collected in Task 2 Step 5 into the scratchpad); `git grep -n -i -F -f <that list> -- tests docs ci` finds nothing new.
- [ ] Step 6: Commit `rollout wire: ConsentWidget for Elfsight, Calendar iframes, ^1.1.1`.

### Task 5: `pr` body for consent sites

**Files:** Modify `ci/rollout/pr-body.sv.md`, `ci/rollout/pr.ts`; Test `tests/unit/rollout/pr.test.ts`

**Interfaces:** Produces `templateKind(privacyJson: string): { kind: 'consent' | 'notice'; services: ServiceSlug[] }`; `BodyInput.kind: 'consent' | 'notice'`; `BodyInput.services: ServiceSlug[]`.

- [ ] Step 1: Failing tests:
  ```text
  [google-maps]              -> consent block, "Google Maps", step "Visa Google Maps"
  [elfsight]                 -> "Elfsight", "Visa Elfsight", "Visa alltid innehåll från Elfsight"
  [elfsight, google-maps]    -> both, one numbered step each, registry order
  []                         -> notice block as today
  unknown slug ('youtube')   -> throws "unknown service youtube in privacy.json" (replaces pr.test.ts:279's 'maps' expectation)
  no {{#maps}} left; no unfilled placeholder
  ```
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement: `{{#consent}}` replaces `{{#maps}}`; values `{{serviceNames}}` (Swedish registry names, ", " and " och "), `{{serviceSlugs}}`, `{{consentSteps}}` built from `SERVICES[slug].name` and `src/text/sv.json` `embed.show`/`embed.remember` with the component's `{name}` fill; screenshot line `platshållarna`; drop "1.0" from the body text; `TITLE` unchanged (open PRs are found by it).
- [ ] Step 4: Run → PASS; `npm run check && npm test`. Commit `rollout pr: consent body names each service`.

### Task 6: `verify`: filter on the first iframe embed; widget routes

**Files:**
- Modify: `ci/rollout/checks/consent-paths.ts`, `ci/rollout/verify.ts` (`mapRoutes` → `embedRoutes`)
- Create: `demo/src/pages/karta-efter-widget.astro` (a `ConsentWidget` elfsight, an unfiltered `ConsentEmbed` google-calendar, then a `ConsentEmbed` google-maps inside `<div class="[&_iframe]:grayscale">`); add to `EMBED_PAGES` in `scripts/demo-copy.ts`; add its page, layout and iframe (with the class) to `fixtures/demo-report.json`; the build test that removes `/flode` and `/nastlad` also removes it
- Test: `tests/unit/rollout/verify.test.ts`, `tests/unit/rollout/checks.demo.ts`

- [ ] Step 1: Failing tests:
  ```text
  embedRoutes: widget whose pages are [src/pages/om.astro] -> has /om; component widget -> its pages' routes
  filterRoutes: route -> service of the filtered iframe ('google-maps' for the new page)
  checks.demo /karta-efter-widget, expectFilter -> 'google-maps' -> one-off check passes with exactly
    one active embed (the widget); filterKept true (Review Focus 5)
  a page with an unfiltered calendar above the filtered map -> the map's reading, filterKept true
    (add the calendar to the same demo page, above the map)
  expectFilter -> 'google-maps' on /flode (no map) -> filterKept null, note "filter: no google-maps embed on the page"
  expectFilter null or absent -> no second click, filterKept null as today
  ```
- [ ] Step 2: Run unit + `npm run demo:build -- consent` + the demo checks command named in `checks.demo.ts`'s header → FAIL.
- [ ] Step 3: Implement per the spec's `verify` section: `filterRoutes` → `Map<route, ServiceSlug>`, `expectFilter(path): ServiceSlug | null`; the reading stays as is when the first embed is of that service; otherwise, after the reload step (consent-paths.ts after the `afterReload` measurement) click the first `[data-consent-embed="<service>"]`'s `[data-load]` and read its iframe. `embedRoutes` = iframe routes ∪ widget `pages` routes, used where `mapRoutes` was.
- [ ] Step 4: Run → PASS; `npx tsx ci/rollout/run.ts verify --demo demo/dist-consent` passes; `npm run test:build`.
- [ ] Step 5: Commit `rollout verify: filter on the first iframe embed; widget routes`.

### Task 7: Docs, full suite, PR

**Files:** `README.md` ("Rollout tool"), `CHANGELOG.md` ("Unreleased: repo tool")

- [ ] Step 1: README: classification and `services`, the recognised Elfsight forms, what is refused and why, "Calendar: literal iframes only".
- [ ] Step 2: CHANGELOG: one bullet per user-visible change; replace the "`detect` names … elfsight; wiring them follows in a tool PR" bullet.
- [ ] Step 3: `npm run check && npm test && npm run test:build && npm run demo:build -- consent && npm run demo:build -- notice && npm run test:e2e`; scan-secrets; the names grep from Task 4 Step 5 over the whole diff (`git diff main --name-only` files).
- [ ] Step 4: Commit `docs: rollout tool wires Elfsight and Calendar`; push; open PR "rollout: wire Elfsight widgets and Google Calendar iframes (#24)", body "Closes #24.", Task 2 Step 5 counts, the footer line. Do not merge.
