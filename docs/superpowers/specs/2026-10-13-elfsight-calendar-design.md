# Elfsight and Google Calendar: design

Date: 2026-10-13. Status: spec approved 2026-10-13, not built. Issues: #24 (Elfsight), #19 (Google Calendar).
Release: v1.1.0, one `CONSENT_VERSION` bump (1 → 2).

## Purpose

Sites can gate Elfsight widgets and Google Calendar iframes, so the sites that shipped in notice
mode because of them can move to consent mode. Success: nothing from either service is requested
before a grant (with or without JavaScript), a one-off "Visa" activates only the clicked element,
and the build fails on a widget or embed whose service is not in `privacy.json`.

Out of scope: wiring the client sites (a rollout after the release) and the `detect`/`wire` change
(a separate tool PR, see "Rollout tool").

## Step 0: browser probe (before any code)

```text
open a site that has an Elfsight widget in a real browser, network panel recording
record every host contacted from page load until the widget has rendered
  -> the hosts the page itself loads (script, widget API, assets) become `match`
  -> hosts only the rendered widget loads (Instagram/Facebook image CDNs) are noted, not matched
add a second .elfsight-app-<id> div to the DOM after platform.js has run
  -> does it render?  yes: no re-init needed.  no: find Elfsight's re-init hook (record its name)
open a calendar.google.com/calendar/embed?src=…&ctz=… URL as a top-level page
  -> does it render the calendar?  (expected: yes, so deEmbed passes it through)
write the results into this spec under "Probe results" before step 1
```

## Registry (`src/services.ts`)

```text
ServiceSlug += 'google-calendar' | 'elfsight'

'google-calendar': {
  name: 'Google Calendar', vendor: 'Google Ireland Ltd', category: 'external',
  match: ['calendar.google.com'],
  description_sv: <purpose: show a calendar from Google>,
}
'elfsight': {
  name: 'Elfsight', vendor: 'Elfsight, SL'   // contracting party per elfsight.com/terms-of-service, checked 2026-10-13, category: 'external',
  match: <hosts from the probe, e.g. 'elfsightcdn.com', 'elfsight.com'>,
  description_sv: <purpose: show a social media feed (e.g. Instagram) via Elfsight>,
}
```

- `match` never lists `cdninstagram.com` or `fbcdn.net`: `matchesRegistry` returns one slug per URL,
  and those hosts also serve unrelated Meta content. They are only reached after the widget is
  active, so gating the script gates them. The purpose text names Instagram.
- `npm run gen` regenerates `services.json`.
- `CONSENT_VERSION = 2`; add `"2": "<hash>"` to `tests/unit/consent-terms.json` (never edit "1").

## `ConsentWidget.astro` (new)

Click-to-load for services that load by `<script>` instead of an iframe. Generic, checked against
the registry.

```text
props:
  service: ServiceSlug
  script: string            // the provider's script URL, exactly as the provider gives it
  title: string
  id?: string
  minHeight?: string        // placeholder box; no aspect ratio, the active widget sizes itself
  slot (default): the widget markup, e.g. <div class="elfsight-app-…" data-elfsight-app-lazy></div>

at render (build/SSR), each failure throws with file path and a fix hint:
  if service not in config.services            -> scanError(...)       // same as ConsentEmbed
  url = parse(script)                           -> error if not https:
  if matchesRegistry(script) != service         -> error "script host does not belong to <service>"
  markup = await Astro.slots.render('default')
  if /<script\b/i in markup                     -> error "no <script> in ConsentWidget; use the script prop"

render:
  <div id data-consent-embed={service} data-script={script} style="min-height: …">
    <template data-payload>{markup}</template>
    <EmbedPlaceholder service title infoId />     // Visa, remember, info; no "open" link
  </div>
```

- `EmbedPlaceholder.astro` is extracted from `ConsentEmbed.astro` (Visa button, remember checkbox,
  info text, optional open link). `ConsentEmbed` renders it with the open link, `ConsentWidget`
  without. Its markup and classes stay identical, so existing e2e and contrast tests still apply.
- No new strings: it reuses `sv.embed.info`, `sv.embed.show`, `sv.embed.remember`.

## DOM contract (CLAUDE.md)

```text
[data-consent-embed=<slug>][data-script=<url>]? template[data-payload] [data-placeholder] [data-load] [data-remember] a[data-open]?
  + [data-active] once the payload is in
```

A widget is an embed with `data-script` and without `a[data-open]`. Everything that already keys
on `data-consent-embed` (grants, one-off Visa, remember, cross-tab adoption, `active` set) applies
unchanged.

## `client.ts`

```text
activate(el):
  template = el.querySelector('template[data-payload]'); if none return
  remove placeholder; append template content; remove template
  el.dataset.active = ''
  active.add(slug)
  if el.dataset.script:
    loadScript(el.dataset.script)
    if probe says re-init is needed and the script was already loaded: call the provider hook   // only if needed

loadScript(src):                 // once per URL per page
  if document has script[src=src] or loaded.has(src): return
  loaded.add(src)
  s = createElement('script'); s.src = src; s.async = true
  document.head.append(s)
```

- Only `activate` loads scripts, and `activate` only runs from a grant in the record or a click on
  that element's Visa. Fail closed is unchanged.
- No writes added: `vm_consent` is still written only by the banner and `loadEmbed` with remember.
- A widget activated by a one-off Visa loads the provider script. Other widgets of the same service
  stay in their templates, so the script cannot reach their markup (it is not in the DOM).
- `client.ts` gets no Elfsight-specific code unless the probe shows a re-init is needed; then the
  hook lives in a small per-slug map, not inline.

## `embed-url.ts`

```text
deEmbed('https://calendar.google.com/calendar/embed?src=X&ctz=Europe/Stockholm')
  == same URL, unchanged          // the embed page works top-level (probe confirms)
```

No code change is expected: none of the Maps rules match `/calendar/embed`. A unit test pins it.

## Scan (`src/scan.ts`)

```text
EMBED_FILE = /(?:^|\/)Consent(?:Embed|Widget)\.astro$/
component names = default imports of either file, plus the bare names ConsentEmbed and ConsentWidget
  unless the file imports that name from somewhere else
findEmbedServices: reads `service` from <ConsentWidget …> exactly as from <ConsentEmbed …>
```

Same skip rules (frontmatter, comments, strings, script/style/textarea/is:raw). New cases in
`scan.test.ts`: live widget reported; widget in an HTML comment, a JS string, frontmatter and a
script block skipped; `MyConsentWidget.astro` not matched; raw Calendar iframes not reported (the
scan never reported raw iframes; pin it). Run it over the real sites' `.astro` files, including
the Elfsight sites: any hit on a site that doesn't use the component is a bug.

## Demo

```text
demo/privacy.consent.json: services += google-calendar, elfsight
demo/src/pages/widget.astro (new):
  <ConsentEmbed service="google-calendar" src="https://calendar.google.com/calendar/embed?src=…" title=…/>
  <ConsentWidget service="elfsight" script="https://<elfsight host>/platform.js" title="Instagram A">
    <div class="elfsight-app-aaaa" data-elfsight-app-lazy></div>
  </ConsentWidget>
  <ConsentWidget …title="Instagram B"> <div class="elfsight-app-bbbb" …></div> </ConsentWidget>
```

The notice demo stays without these services.

## Tests (each written failing first)

```text
unit:
  services: new slugs, categories, matchesRegistry on each probed host, services.json fresh
  consent-terms: new entry "2"
  embed-url: Calendar URL passes through, src and ctz intact
  scan: cases above
build (tests/build):
  ConsentWidget with service not in privacy.json        -> build fails, message names the file
  script on a host of another service / http: URL        -> build fails
  <script> in the slot                                   -> build fails
  valid widget page                                      -> builds; output has template + data-script
  site-typecheck: a site importing ConsentWidget type-checks
e2e (Playwright stubs the probed hosts; fake platform.js fills every .elfsight-app-* div present
     when it runs and on a re-init call, and records how often it loaded):
  before consent: zero requests to elfsight hosts and calendar.google.com
  no JS: zero requests to them (nojs.spec)
  one-off Visa on widget A: A renders, B stays placeholder, script loaded once, no vm_consent
  then Visa on B: B renders, script still loaded once
  remember on A: both widgets active, record grants elfsight
  banner "Acceptera alla" / external category: calendar and both widgets active
  withdraw: next page load has none of them
  calendar: iframe after Visa; open link equals the embed URL
  a11y + contrast specs include the widget page
```

## Rollout tool (separate PR, after the release)

```text
detect/scripts.ts: remove [/elfsight/i, 'elfsight'] from BANNERS; report elfsight as a service
wire: wrap <script src=".../platform.js"> + <div class="elfsight-app-…"> into <ConsentWidget>,
      add 'elfsight' to privacy.json; refuse (with a reason) any variant it doesn't recognise
```

Uses the real markup variants from the Elfsight pool sites; tests use fixtures under
`tests/unit/rollout/fixtures/` (`.txt`, scanned with `ci/rollout/scan-secrets.ts`).

## Release

```text
README: ConsentWidget section (props, the no-script-in-slot rule, Elfsight example), registry table
CHANGELOG: 1.1.0: google-calendar, elfsight, ConsentWidget; CONSENT_VERSION 2 re-asks every visitor
before tag: STARTER_INSTALL=true and starter-install green on main
git tag -a v1.1.0; push tag
```

Sites on `semver:^1.0.0` pick it up at their next install. Every visitor on every site is asked
again (accepted in #19 and #24).

## Probe results

(Filled in by step 0.)
