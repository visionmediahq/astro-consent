# Elfsight and Google Calendar (v1.1.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sites can gate Elfsight widgets and Google Calendar iframes behind consent, released as
v1.1.0 with one `CONSENT_VERSION` bump.

**Architecture:** Two registry rows (`google-calendar`, `elfsight`). Calendar uses the existing
`<ConsentEmbed>`. Elfsight gets a new `<ConsentWidget>`: the same placeholder and DOM contract as an
embed plus `data-script`; `client.ts` injects that script once when the element activates. The
build-time scan and a pure `widgetError()` reject unlisted services, foreign script hosts and
`<script>` in the slot.

**Tech Stack:** Astro 6/7 components, TypeScript strict, Tailwind 4 + daisyUI 5, vitest (unit,
build), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-10-13-elfsight-calendar-design.md`

**Notation:** pseudocode throughout. Exact values (strings, hosts, selectors, file paths, version
numbers) are written in `code` or quotes and must be used as written; everything else is the
implementer's to express in the surrounding code's idiom.

## Global Constraints

- Read `CLAUDE.md` first; its rules apply to every task.
- No `prepare`/`preinstall`/`install`/`postinstall`/`prepack`/`build` script, no `workspaces`.
- Fail closed: nothing matching `src/services.ts` is requested before a valid grant, with or
  without JS. A one-off "Visa" activates only the clicked element.
- `client.ts` never writes `vm_consent` on page load or when adopting another tab's change.
- `client.ts`, `store.ts`, `services.ts`, `embed-url.ts`, `src/widget.ts` and components never
  import `src/config.ts`.
- Visible strings live in `src/text/sv.json`; registry `description_sv` stays in `services.ts`.
- `CONSENT_VERSION` 1 → 2 exactly once; add `"2"` to `tests/unit/consent-terms.json`, never edit `"1"`.
- Elfsight vendor: `Elfsight, SL`.
- TypeScript only. Failing test first. Tests never reach Google, Elfsight, Meta or a real log host.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branch `feat/elfsight-calendar`; Jörgen merges and tags.

## Review Focus

1. `<script>` in the `ConsentWidget` slot, both plain (Astro-processed) and `is:inline`: build
   fails on a prerendered page (on an SSR page the request fails; documented). → Task 5, build test.
2. Script URL with another host in its query (`https://evil.test/x.js?u=elfsightcdn.com`):
   rejected, matching uses origin + path only. → Task 5, unit.
3. Two widgets, same script, Visa on each in turn: one script tag, both render. → Task 6, e2e.
4. Cross-tab grant while widgets are placeholders: they activate, script loads, this tab writes
   nothing. → Task 6, e2e.
5. `ConsentWidget` imported under another name / commented out: reported / skipped. → Task 3, unit.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/services.ts`, `services.json` | modify | two registry rows |
| `src/config.ts`, `tests/unit/consent-terms.json` | modify | `CONSENT_VERSION = 2` + terms entry |
| `src/scan.ts` | modify | recognise `ConsentWidget` |
| `src/widget.ts` | create | pure `widgetError()` |
| `src/components/EmbedPlaceholder.astro` | create | placeholder shared by embed and widget |
| `src/components/ConsentEmbed.astro` | modify | uses `EmbedPlaceholder` |
| `src/components/ConsentWidget.astro` | create | click-to-load script widget |
| `src/client.ts` | modify | `loadScript()` from `activate()` |
| `demo/privacy.consent.json`, `demo/src/pages/flode.astro`, `scripts/demo-copy.ts` | modify/create | demo page |
| `tests/e2e/helpers.ts`, `tests/e2e/widget.spec.ts` | modify/create | fake `platform.js`, widget e2e |
| `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `package.json` | modify | docs, DOM contract, 1.1.0 |

---

### Task 1: Browser probe

Already known (curl of `https://elfsightcdn.com/platform.js`, 2026-10-13): references
`core.service.elfsight.com`, `apps.elfsight.com`; runs a `MutationObserver` on `childList`/`subtree`.

**Files:** modify the spec's "Probe results" section.
**Produces:** the final `elfsight` match list (Task 2); confirmation that Task 6's fake script
(MutationObserver-based) mirrors the real one.

- [ ] **Step 1: Hosts.**
  ```
  load the claude-in-chrome skill
  open the live site of a notice-mode Elfsight site from #24 (e.g. roingegarden) in a new tab
  scroll the widget into view (lazy mode); wait until the feed renders
  hosts = distinct hosts from read_network_requests
  ```
- [ ] **Step 2: Late widget.**
  ```
  javascript_tool:
    d = new div with the className of the first [class*="elfsight-app-"]
    append d to body
    after 5 s: console.log('[probe] late widget children:', d.childElementCount)
  read_console_messages(pattern '\[probe\]')   expect > 0
  ```
- [ ] **Step 3: Calendar top-level.**
  ```
  open https://calendar.google.com/calendar/embed?src=en.swedish%23holiday%40group.v.calendar.google.com&ctz=Europe%2FStockholm
  expect: the calendar renders as a page
  ```
- [ ] **Step 4: Decide.**
  ```
  match(elfsight) = ['elfsightcdn.com', 'elfsight.com']
    + any other host the page itself requests for Elfsight, except Instagram/Meta CDNs
  note: 'elfsight.com' as a bare host also makes detect report a plain elfsight.com link in site
    text as a tracker; acceptable (detect fails toward a human), say so in the probe results
  if step 2 prints 0 or step 3 doesn't render:
    STOP, write the result into the spec, ask Jörgen   // spec's client / deEmbed sections change
  ```
- [ ] **Step 5: Record and commit.**
  ```
  git checkout -b feat/elfsight-calendar
  spec "Probe results" := hosts with role, late-widget result, calendar result, date
  commit "docs: Elfsight/Calendar probe results"
  ```

---

### Task 2: Registry rows, CONSENT_VERSION 2, Calendar open link

**Files:** `src/services.ts`, `services.json`, `src/config.ts`, `tests/unit/consent-terms.json`,
`ci/rollout/detect/scripts.ts`; tests `tests/unit/services.test.ts`, `tests/unit/embed-url.test.ts`,
`tests/unit/store.test.ts`, `tests/unit/config.test.ts`, `tests/unit/scan.test.ts`,
`tests/build/build.test.ts`, `tests/unit/rollout/detect-iframes.test.ts`, its snapshot.
**Produces:** `ServiceSlug` gains `'google-calendar' | 'elfsight'`;
`matchesRegistry('https://elfsightcdn.com/platform.js') == 'elfsight'`,
`matchesRegistry('https://calendar.google.com/calendar/embed?src=x') == 'google-calendar'`.

- [ ] **Step 1: Failing tests.**
  ```
  services.test, "matchesRegistry classifies known URLs" += 
    calendar.google.com/calendar/embed?src=x&ctz=…   -> 'google-calendar'
    elfsightcdn.com/platform.js                      -> 'elfsight'
    core.service.elfsight.com/p/boot/?w=abc          -> 'elfsight'
    apps.elfsight.com/p/platform.js                  -> 'elfsight'
  services.test, new test:
    scontent.cdninstagram.com/…, scontent-arn2-1.xx.fbcdn.net/…  -> null
  embed-url.test, new test:
    deEmbed(calendar embed URL with src and ctz) == the same URL
  ```
- [ ] **Step 2: Run** `npx vitest run tests/unit/services.test.ts tests/unit/embed-url.test.ts`.
  Expect: the matchesRegistry tests FAIL (null); the deEmbed test already PASSES (it pins
  existing behaviour, intended).
- [ ] **Step 3: Registry.**
  ```
  ServiceSlug = 'google-maps' | 'google-calendar' | 'google-analytics' | 'google-ads' | 'meta-pixel' | 'elfsight'
  SERVICES['google-calendar'] (after google-maps) = {
    name 'Google Kalender' (Swedish: shown in the banner and placeholder; README, CHANGELOG, comments and the slug stay English 'Google Calendar' / google-calendar),
    vendor 'Google Ireland Ltd', category 'external',
    match ['calendar.google.com'], description_sv 'Kalendrar från Google.' }
  SERVICES['elfsight'] (last) = {
    name 'Elfsight', vendor 'Elfsight, SL', category 'external',
    match <from Task 1>, description_sv 'Flöden från sociala medier, till exempel Instagram, via Elfsight.' }
  ```
- [ ] **Step 4: Run** `npm run gen`, then the two test files. Expect PASS.
- [ ] **Step 5: Version.**
  ```
  run consent-terms.test -> 'unchanged' FAILS, prints "Current hash: H"
  src/config.ts: CONSENT_VERSION = 2
  consent-terms.json += "2": H
  ```
- [ ] **Step 6: Tests that used `'elfsight'` as the unknown slug.** It is a real slug now, so they
  would pass for the wrong reason or fail:
  ```
  tests/unit/store.test.ts:79    services ['elfsight']  -> ['not-a-service']
  tests/unit/config.test.ts:33   services ['elfsight']  -> ['not-a-service']
  tests/build/build.test.ts:67   services ['elfsight']  -> ['not-a-service']
  tests/build/build.test.ts:47   consentVersion /^1:/   -> /^2:/
  tests/unit/scan.test.ts        scanError example slug 'elfsight' -> 'not-a-service'
  ```
- [ ] **Step 7: Registry-driven rollout detect.** `ci/rollout/detect/scripts.ts` builds
  `HOST_PATTERNS` from every bare-host registry pattern, and `detect/iframes.ts` classifies iframes
  with `matchesRegistry`. New rows therefore change detect output. Keep it deliberate and minimal
  (the full Elfsight detect/wire change stays in the tool PR):
  ```
  scripts.ts: IFRAME_SERVICES = {'google-maps', 'google-calendar'}
    line ~101: text match skips iframe tags for slug in IFRAME_SERVICES (today: google-maps only)
    line ~105: parsed-URL check skips slug in IFRAME_SERVICES (today: google-maps only)
  run npm test; expected, intended changes:
    tests/unit/rollout/detect-iframes.test.ts:135  nhrk Calendar iframe service null -> 'google-calendar'
    tests/unit/rollout/__snapshots__/detect.test.ts.snap  nhrk entry: iframe service 'google-calendar'
      (update with vitest -u only after reading the diff: no other site's entry may change except
       Elfsight sites gaining tracker 'elfsight' next to banner 'elfsight')
  classification stays needs-human for both kinds of site (Calendar iframe: iframeReason;
    Elfsight: existing banner) until the tool PR
  ```
  Record in the commit body: "detect now names google-calendar and elfsight; wiring them is the tool PR".
- [ ] **Step 8: Run** `npm run check && npm test`. Expect PASS.
- [ ] **Step 9: Commit** "feat: google-calendar and elfsight in the registry; CONSENT_VERSION 2 (#19, #24)".

---

### Task 3: Scan recognises ConsentWidget

**Files:** `src/scan.ts` (`EMBED_FILE`, `embedNames`, header comment, `scanError` wording); test
`tests/unit/scan.test.ts`.
**Produces:** `findEmbedServices` reports `service` literals of `<ConsentEmbed>` and
`<ConsentWidget>` and their default-import aliases. `scanError(file, slug, allowed)` unchanged in
signature; message names `<ConsentEmbed>/<ConsentWidget>`.

- [ ] **Step 1: Failing tests.**
  ```
  WIDGET = <ConsentWidget service="elfsight" script="https://elfsightcdn.com/platform.js" title="Instagram"><div class="elfsight-app-a"></div></ConsentWidget>
  findEmbedServices(WIDGET)                                            == ['elfsight']
  findEmbedServices(import Feed from '…/components/ConsentWidget.astro' + <Feed service="elfsight" …/>) == ['elfsight']
  findEmbedServices(WIDGET in: frontmatter string, HTML comment, {/* */}, {"…"} string, <script>)  == []
  findEmbedServices(import ConsentWidget from './MyConsentWidget.astro' + WIDGET + <ConsentWidgets service="x"/>) == []
  findEmbedServices(<iframe src="https://calendar.google.com/calendar/embed?src=x">)  == []
  ```
- [ ] **Step 2: Run** `npx vitest run tests/unit/scan.test.ts`. Expect: the first two FAIL; the rest
  PASS (they pin existing skips).
- [ ] **Step 3: Implement.**
  ```
  EMBED_FILE = /(?:^|\/)Consent(?:Embed|Widget)\.astro$/
  COMPONENT_NAMES = ['ConsentEmbed', 'ConsentWidget']

  embedNames(frontmatter):
    names = {}; takenByOthers = {}
    for each default import (name, specifier) in frontmatter without JS comments:
      if EMBED_FILE matches specifier: names += name
      else if name in COMPONENT_NAMES: takenByOthers += name
    for name in COMPONENT_NAMES not in takenByOthers: names += name
    return names

  scanError message: '<ConsentEmbed service=…>' -> '<ConsentEmbed>/<ConsentWidget> service="…"'
  doc comments (line 1, above embedNames): name both components
  ```
- [ ] **Step 4: Run** the scan tests and `npm run check`. Expect PASS (update any existing
  `scanError` assertion tied to the old exact wording, keeping its intent).
- [ ] **Step 5: Real sites.**
  ```
  for site in (every Elfsight site from #24) + 3 sites without Elfsight:
    shallow clone into the scratchpad (or use ~/sites/consent-rollout/<site>)
    for each src/**/*.astro: print file if findEmbedServices(content) != []
    expect: no output for sites not using the components; a hit = bug -> add test case, fix
    delete the clone
  ```
  Command shape:
  `npx tsx -e "<glob dir/src/**/*.astro, print hits>" -- <site dir>` (read the dir with `process.argv.at(-1)`).
- [ ] **Step 6: Commit** "feat: the build-time scan covers ConsentWidget".

---

### Task 4: Extract EmbedPlaceholder (no behaviour change)

**Files:** create `src/components/EmbedPlaceholder.astro`; modify `src/components/ConsentEmbed.astro`.
Guarded by the existing build, embed, nojs, a11y and contrast tests.
**Produces:** `<EmbedPlaceholder service title infoId openHref?>`; default slot = info text,
fallback `sv.embed.info`. Renders `[data-placeholder]` with `[data-load]`, `[data-remember]`, and
`a[data-open]` only when `openHref` is set.

- [ ] **Step 1: Baseline.**
  ```
  build both demos; run e2e embed, nojs, a11y, contrast   expect PASS
  save demo/dist-consent/client/karta/index.html to the scratchpad as karta-before.html
  ```
- [ ] **Step 2: EmbedPlaceholder.astro.**
  ```
  props: service, title, infoId, openHref?
  name = SERVICES[service].name
  fill(text, vars) = replace {key} with vars[key]          // moved from ConsentEmbed
  render exactly the current placeholder markup of ConsentEmbed.astro (same classes/attributes):
    div[data-placeholder].flex.flex-1.flex-col.justify-between.gap-3.p-4
      div.text-sm#infoId  <slot> fallback: <p>fill(sv.embed.info, {title, name})</p>
      div.flex.flex-wrap.items-center.gap-3
        button.btn.btn-primary.btn-sm.h-auto.min-h-8.whitespace-normal[data-load][aria-describedby=infoId]  fill(sv.embed.show)
        label > input.checkbox.checkbox-sm[data-remember] + fill(sv.embed.remember)
        if openHref: a.link.text-xs[data-open][target=_blank][rel="noopener noreferrer"]  fill(sv.embed.open)
  ```
- [ ] **Step 3: ConsentEmbed.astro.**
  ```
  remove placeholder markup, fill, sv and SERVICES imports
  if Astro.slots.has('placeholder'):
    <EmbedPlaceholder service title infoId openHref><slot name="placeholder" /></EmbedPlaceholder>
  else:
    <EmbedPlaceholder service title infoId openHref />
  keep the header comment, template, outer div and the privacy.json check
  ```
- [ ] **Step 4: Verify.**
  ```
  npm run check; rebuild both demos; npm run test:build; e2e embed, nojs, a11y, contrast   expect PASS
  diff new karta/index.html vs karta-before.html: only info ids and asset/scope hashes differ
  ```
- [ ] **Step 5: Commit** "refactor: EmbedPlaceholder shared by embeds and (next) widgets".

---

### Task 5: ConsentWidget, render-time checks, demo page

**Files:** create `src/widget.ts`, `src/components/ConsentWidget.astro`,
`demo/src/pages/flode.astro`, `tests/unit/widget.test.ts`; modify `demo/privacy.consent.json`,
`scripts/demo-copy.ts` (`EMBED_PAGES`), `tests/build/build.test.ts`,
`tests/e2e/smoke.spec.ts`.
**Consumes:** `matchesRegistry`, `ServiceSlug` (T2), `scanError` (T3), `EmbedPlaceholder` (T4).
**Produces:**
`widgetError(page: string, service: ServiceSlug, script: string, markup: string): string | null` (`page` = `Astro.url.pathname`);
`<ConsentWidget service script title id? minHeight?>` →
`div[data-consent-embed=<slug>][data-script=<url>] > template[data-payload] + [data-placeholder]`;
demo `/flode` with `#kalender` (ConsentEmbed, google-calendar), `#flode-a`, `#flode-b`
(ConsentWidget, elfsight, script `https://elfsightcdn.com/platform.js`, payloads
`div.elfsight-app-demo-a` / `div.elfsight-app-demo-b` with `data-elfsight-app-lazy`).

- [ ] **Step 1: Failing unit tests** (`tests/unit/widget.test.ts`).
  ```
  OK = 'https://elfsightcdn.com/platform.js'; DIV = '<div class="elfsight-app-a" data-elfsight-app-lazy></div>'
  widgetError(f, 'elfsight', OK, DIV)                                      == null
  widgetError(f, 'elfsight', '/platform.js', DIV)                          =~ /absolute URL/
  widgetError(f, 'elfsight', 'http://elfsightcdn.com/platform.js', DIV)    =~ /https:/
  widgetError(f, 'elfsight', 'https://maps.googleapis.com/maps/api/js', DIV) =~ /google-maps/
  widgetError(f, 'elfsight', 'https://cdn.example.test/w.js', DIV)         =~ /no service/
  widgetError(f, 'elfsight', 'https://evil.test/x.js?u=elfsightcdn.com', DIV) =~ /no service/
  for markup in ['<script src="x"></script>', '<SCRIPT>1</SCRIPT>', '<script type="module" src="/_astro/a.js"></script>']:
    widgetError(f, 'elfsight', OK, DIV + markup)                           =~ /no <script>/
  widgetError('src/pages/kontakt.astro', 'elfsight', 'http://x', DIV)      =~ /src\/pages\/kontakt\.astro.*elfsight/
  ```
- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: src/widget.ts** (node-free; imports only `services.ts`).
  ```
  widgetError(page, service, script, markup):     // page = Astro.url.pathname, like scanError
    where = '[astro-consent] <page>: <ConsentWidget service="<service>">'
    url = parse script            else return where + ': script "<script>" is not an absolute URL.'
    if url.protocol != 'https:'   return where + ': script must use https:, got "<script>".'
    owner = matchesRegistry(url.origin + url.pathname)     // never the query
    if owner != service           return where + ': script "<script>" does not belong to <service> (it matches <owner or "no service">).'
    if /<script\b/i in markup     return where + ": no <script> in the slot, it would run before consent. Pass the provider's script URL as the script prop."
    return null
  ```
  Run unit → PASS.
- [ ] **Step 4: ConsentWidget.astro.**
  ```
  header comment: click-to-load for script widgets; slot inert in <template>; client.ts appends it
    and loads `script` once on Visa or grant; never a <script> in the slot (build fails)
  import contrast.css, virtual config, scanError, widgetError, EmbedPlaceholder
  props: service, script, title, minHeight = '12rem', id?
  if service not in config.services: throw new Error(scanError(Astro.url.pathname, service, config.services))
  markup = await Astro.slots.render('default')
  if (e = widgetError(Astro.url.pathname, service, script, markup)): throw new Error(e)
  header comment also states: on a prerendered page these checks fail the build; on an SSR page
    they fail the request (500), like ConsentEmbed's own check
  infoId = (id or 'consent-embed-' + 8 random hex) + '-info'
  render:
    div#id[data-consent-embed=service][data-script=script]
       class "relative flex min-h-(--consent-min-h) flex-col rounded-box bg-base-200 text-base-content data-active:min-h-0 data-active:bg-transparent"
       style "--consent-min-h: <minHeight>"
      template[data-payload]  set:html=markup
      <EmbedPlaceholder service title infoId />            // no openHref
  ```
- [ ] **Step 5: Demo.**
  ```
  demo/privacy.consent.json services = ['google-maps', 'google-analytics', 'google-calendar', 'elfsight']
  demo/src/pages/flode.astro (prerender, Base title "Flöde", h1 "Kalender och flöde"):
    ConsentEmbed  #kalender  google-calendar  src https://calendar.google.com/calendar/embed?src=demo%40group.calendar.google.com&ctz=Europe%2FStockholm  title "Vår kalender"
    ConsentWidget #flode-a   elfsight  script https://elfsightcdn.com/platform.js  title "Instagram A"  > div.elfsight-app-demo-a[data-elfsight-app-lazy]
    ConsentWidget #flode-b   elfsight  same script                              title "Instagram B"  > div.elfsight-app-demo-b[data-elfsight-app-lazy]
  scripts/demo-copy.ts: EMBED_PAGES += 'src/pages/flode.astro'; comment "Pages with a <ConsentEmbed> or <ConsentWidget>"
  tests/e2e/smoke.spec.ts:9 expected services = the four above
  ```
- [ ] **Step 6: Build tests** (`tests/build/build.test.ts`, new describe "ConsentWidget").
  ```
  widgetPage(body) = page with ConsentWidget default import, prerender, body
  test: consent demo /flode: #flode-a has data-consent-embed=elfsight, data-script=OK,
        template contains 'elfsight-app-demo-a', no a[data-open], no <script src> containing 'elfsight'
  test: privacy.json services ['google-maps'] + widget elfsight      -> build fails, output names bad.astro and elfsight
  test: widget script https://cdn.example.test/w.js                 -> build fails, /does not belong to elfsight/
  for tag in ['<script>console.log(1)</script>', '<script is:inline src="https://elfsightcdn.com/platform.js"></script>']:
    test: tag in the slot                                          -> build fails, /no <script> in the slot/
  the /flode assertion goes INSIDE describe('banner and footer markup') (build.test.ts:240), which
    owns consentBuild; do not move its beforeAll (that would rebuild for every describe)
  "service rows" test: all four slugs; elfsight row inside [data-consent-category="external"]
  build.test.ts:49 expected demo services = the four above
  (no site-typecheck change: that test type-checks client.ts with tsc, which cannot read .astro;
   nothing type-checks components today; out of scope)
  ```
- [ ] **Step 7: Run** `npm run check && npm test && npm run test:build`. Expect PASS.
  If the plain-`<script>` case passes the build (Astro hoisted it out of the rendered slot):
  STOP and report. Prepared fallback to propose: the scan (`findEmbedServices`' pass) also reports a
  `<script` between `<ConsentWidget …>` and its closing tag, and the integration fails the build on it.
- [ ] **Step 8: Commit** "feat: ConsentWidget, click-to-load for script widgets (#24)".

---

### Task 6: client.ts loads the widget script; e2e

**Files:** `src/client.ts` (`activate`); `tests/e2e/helpers.ts` (`stub`); create
`tests/e2e/widget.spec.ts`; extend `nojs.spec.ts`, `a11y.spec.ts`, `contrast.spec.ts`.
**Consumes:** demo `/flode` (T5).
**Produces:** after activating an element with `data-script`, exactly one `script[src=<url>]` in
`document.head`. Fake-script test hook `window.__elfsightLoads`.

- [ ] **Step 1: Fake platform.js** in `stub()`.
  ```
  FAKE_ELFSIGHT (JS string), like the real script:
    window.__elfsightLoads += 1
    render() = for each [class*="elfsight-app-"]:not([data-rendered]): set data-rendered, text 'flöde'
    render(); MutationObserver(render) on body, childList + subtree
  route handler: non-document request whose URL contains 'elfsightcdn.com/platform.js' -> FAKE_ELFSIGHT
                 other non-document -> '/* stub */' (unchanged); documents unchanged
  ```
- [ ] **Step 2: Failing e2e** (`tests/e2e/widget.spec.ts`; every test calls `stub(context)` first).
  ```
  before consent: networkidle; stubs.registry == []; #flode-a [data-load] text 'Visa Elfsight';
                  #flode-a has no a[data-open]; #kalender a[data-open] href =~ calendar.google.com/calendar/embed?src=
  one-off Visa A: click #flode-a [data-load] -> #flode-a [data-rendered] x1, #flode-a[data-active];
                  #flode-b placeholder visible, no .elfsight-app-demo-b in DOM;
                  script[src=OK] x1; every registry request contains 'elfsight'; stored() == null
  Visa A then B:  both rendered; script tag x1; __elfsightLoads == 1
  remember on A:  check #flode-a [data-remember], click Visa -> A and B rendered; #kalender no iframe;
                  stored().services == ['elfsight']
  Acceptera alla: action 'all' -> #kalender iframe src =~ calendar.google.com; A and B rendered; script x1
  cross-tab:      tab P and tab O on /flode; P counts its own localStorage.setItem('vm_consent') calls;
                  O clicks 'all' -> P: A and B rendered; P's write count == 0
  calendar one-off: click #kalender [data-load] -> #kalender iframe src =~ calendar.google.com; widgets untouched; stored() == null
  withdraw:       seed /flode {choice 'all', categories all used}; reload -> calendar + widgets active;
                  open settings, Neka (action 'none'); reload -> placeholders, no registry request
                  after the reload, no script[src=OK]   (follow tests/e2e/withdraw.spec.ts' flow)
  stored without elfsight: seed /flode {choice 'custom', categories ['necessary'], services ['google-calendar']}
                  -> #kalender iframe x1; networkidle; #flode-a placeholder visible; no registry request contains 'elfsight'
  ```
- [ ] **Step 3: Run** `npm run demo:build -- consent && npx playwright test tests/e2e/widget.spec.ts`.
  Expect: "before consent" and "stored without elfsight" PASS; every `[data-rendered]` test FAILS
  (payload appended, script never loaded).
- [ ] **Step 4: client.ts.**
  ```
  loadScript(src):                      // only activate() calls this
    if document has script[src = CSS.escape(src)]: return
    append <script src=src async> to document.head

  activate(el):
    … existing: append payload, remove template, data-active, active.add(slug)
    if el.dataset.script: loadScript(el.dataset.script)
  doc comment: "Swaps an embed's placeholder for its payload, and loads a widget's script."
  ```
- [ ] **Step 5: Run** `npm run check`, rebuild consent demo, e2e widget, embed, crosstab, withdraw.
  Expect PASS.
- [ ] **Step 6: nojs, a11y, contrast.**
  ```
  nojs: JS disabled, /flode, networkidle -> #flode-a and #kalender placeholders visible,
        no [class*="elfsight-app-"] in DOM, stubs.registry == []
  a11y: copy "embed placeholder has no axe violations" as "widget placeholders …" on /flode
  contrast: copy "embed Visa button is AA on a red primary" as "widget Visa button …" on /flode,
            selector '#flode-a [data-load]'
  ```
  Run: build both demos, `npx playwright test`. Expect PASS.
- [ ] **Step 7: Commit** "feat: activating a widget loads its script once (#24)".

---

### Task 7: Docs, version, full verification, PR

**Files:** `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `package.json`.

- [ ] **Step 1: README.**
  ```
  new section "### <ConsentWidget>" after the ConsentEmbed section:
    what it is (click-to-load for <script> widgets, Elfsight), example:
      <ConsentWidget service="elfsight" script="https://elfsightcdn.com/platform.js" title="Vårt Instagramflöde">
        <div class="elfsight-app-<id>" data-elfsight-app-lazy></div>
      </ConsentWidget>
    rules: script https: on the service's own host (build fails otherwise);
           no <script> in the slot (build fails), pass its URL as `script`;
           minHeight (default 12rem) sizes the placeholder only
  registry list += google-calendar (ConsentEmbed), elfsight (ConsentWidget), in that list's format
  ```
- [ ] **Step 2: CLAUDE.md DOM contract**, embed line becomes:
  ```
  [data-consent-embed=<slug>][data-script=<url>]? template[data-payload] [data-placeholder] [data-load] [data-remember] a[data-open]?
    + [data-active] once the payload is in; a widget (data-script, no a[data-open]) also gets its script, once per URL
  ```
- [ ] **Step 3: CHANGELOG + version.**
  ```
  "## 1.1.0" above "## Unreleased: repo tool":
    - new services google-calendar (ConsentEmbed; open link = embed URL) and elfsight (vendor Elfsight, SL)
    - new <ConsentWidget>: same placeholder/one-off/remember as ConsentEmbed; script loads once per page;
      build fails on unlisted service, foreign script host, <script> in the slot
    - CONSENT_VERSION 2: every visitor on every site is asked again after the site's next install (#19, #24)
  package.json version = "1.1.0"
  ```
- [ ] **Step 4: Full verification.**
  ```
  npm run check && npm test && npm run test:build
  npm run demo:build -- consent && npm run demo:build -- notice && npm run test:e2e
  npm run test:pack -- 6.1.6 10.0.4
  npm run test:pack -- 7.3.5 11.1.6
  expect all PASS; keep the summary lines for the PR body
  ```
- [ ] **Step 5: Commit, push, PR.**
  ```
  commit "docs: ConsentWidget, 1.1.0 changelog"
  push feat/elfsight-calendar
  gh pr create  title "1.1.0: Elfsight and Google Calendar, ConsentWidget"
                body: summary, test output, "Closes #19", "Part of #24" (#24 closes with the detect/wire tool PR)
  STOP. Merge and tag are Jörgen's: starter-install green on main with STARTER_INSTALL=true,
  then git tag -a v1.1.0 and push. The detect/wire tool PR is planned separately.
  ```
