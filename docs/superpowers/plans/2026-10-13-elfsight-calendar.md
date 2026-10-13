# Elfsight and Google Calendar (v1.1.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sites can gate Elfsight widgets and Google Calendar iframes behind consent, released as v1.1.0 with one `CONSENT_VERSION` bump.

**Architecture:** Two registry rows (`google-calendar`, `elfsight`). Calendar uses the existing `<ConsentEmbed>`. Elfsight gets a new `<ConsentWidget>`: the same placeholder and DOM contract as an embed plus `data-script`; `client.ts` injects that script once when the element activates. The build-time scan and a pure `widgetError()` check reject unlisted services, foreign script hosts and `<script>` in the slot.

**Tech Stack:** Astro 6/7 components (`.astro`), TypeScript strict, Tailwind 4 + daisyUI 5 classes, vitest (unit, build), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-10-13-elfsight-calendar-design.md`

## Global Constraints

- Read `CLAUDE.md` first. Its rules apply to every task.
- No `prepare`/`preinstall`/`install`/`postinstall`/`prepack`/`build` script, no `workspaces` in `package.json`.
- Fail closed: nothing matching `src/services.ts` is requested before a valid grant, with or without JS. A one-off "Visa" activates only the clicked element.
- `client.ts` never writes `vm_consent` on page load or when adopting another tab's change.
- `client.ts`, `store.ts`, `services.ts`, `embed-url.ts`, `src/widget.ts` and components never import `src/config.ts`.
- Every visible string lives in `src/text/sv.json` (registry `description_sv` stays in `services.ts`, as today).
- `CONSENT_VERSION` goes from 1 to 2 exactly once; add `"2"` to `tests/unit/consent-terms.json`, never edit `"1"`.
- Elfsight vendor string: `Elfsight, SL` (contracting party per elfsight.com/terms-of-service, checked 2026-10-13).
- TypeScript only; no `.js`/`.mjs` files. Write the failing test first. Tests never reach Google, Elfsight, Meta or a real log host.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on branch `feat/elfsight-calendar`; Jörgen merges.

## Review Focus

1. **`<script>` in the `ConsentWidget` slot written as plain `<script>` (Astro-processed) and as `<script is:inline>`**: both must fail the build, since either would run regardless of the template. Pinned in Task 5 (build test, both forms).
2. **A script URL whose query string contains another service's host** (`https://evil.test/x.js?u=elfsightcdn.com`): must be rejected; `widgetError` matches on origin + path only. Pinned in Task 5 (unit).
3. **Two widgets with the same script, one-off Visa on each in turn**: the script tag is injected exactly once and both render. Pinned in Task 6 (e2e).
4. **Cross-tab grant arriving while widgets sit in placeholders**: adopting the other tab's record activates them and injects the script, and the adopting tab writes nothing. Pinned in Task 6 (e2e).
5. **`ConsentWidget` imported under another name or commented out**: the scan reports the first and skips the second, like `ConsentEmbed`. Pinned in Task 3 (unit).

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/services.ts`, `services.json` | modify | two registry rows |
| `src/config.ts` | modify | `CONSENT_VERSION = 2` |
| `tests/unit/consent-terms.json` | modify | entry `"2"` |
| `src/scan.ts` | modify | recognise `ConsentWidget` |
| `src/widget.ts` | create | pure `widgetError()` render-time checks |
| `src/components/EmbedPlaceholder.astro` | create | placeholder shared by embed and widget |
| `src/components/ConsentEmbed.astro` | modify | uses `EmbedPlaceholder` |
| `src/components/ConsentWidget.astro` | create | click-to-load script widget |
| `src/client.ts` | modify | `loadScript()` from `activate()` |
| `demo/privacy.consent.json`, `demo/src/pages/flode.astro`, `scripts/demo-copy.ts` | modify/create | demo page with Calendar + two widgets |
| `tests/e2e/helpers.ts` | modify | fake Elfsight `platform.js` in `stub()` |
| `tests/e2e/widget.spec.ts` | create | widget and calendar e2e |
| `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `package.json` | modify | docs, DOM contract, version 1.1.0 |

---

### Task 1: Browser probe

Confirms the spec's assumptions before code. Results so far (curl of `https://elfsightcdn.com/platform.js`, 2026-10-13): it references `core.service.elfsight.com` and `apps.elfsight.com`, and it runs a `MutationObserver` on `childList`/`subtree`, so widgets added later should render with no re-init.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-13-elfsight-calendar-design.md` ("Probe results")

**Interfaces:**
- Produces: the final `match` list for `elfsight` (Task 2) and the confirmation that the fake `platform.js` in Task 6 (MutationObserver-based) mirrors the real one.

- [ ] **Step 1: Record a real Elfsight page.** Use the claude-in-chrome tools (load the `claude-in-chrome` skill first) on a site from issue #24 that is still in notice mode (e.g. roingegarden's live site). Read network requests (`read_network_requests`) from load until the feed renders, scrolling it into view (lazy mode). List every distinct host.

- [ ] **Step 2: Test a widget added late.** With `javascript_tool` on the same page, after the widget rendered:

```js
const d = document.createElement('div')
d.className = document.querySelector('[class*="elfsight-app-"]').className
document.body.append(d)
setTimeout(() => console.log('[probe] late widget children:', d.childElementCount), 5000)
```

Read the console with `read_console_messages` (pattern `\[probe\]`). Expected: a count above 0.

- [ ] **Step 3: Open a Calendar embed top-level.** Navigate a new tab to `https://calendar.google.com/calendar/embed?src=en.swedish%23holiday%40group.v.calendar.google.com&ctz=Europe%2FStockholm`. Expected: the calendar renders as a page.

- [ ] **Step 4: Decide.**
  - `match` for `elfsight` = the hosts the page itself requests that end in `elfsightcdn.com` or `elfsight.com`, reduced to the patterns `elfsightcdn.com` and `elfsight.com` (both are substrings of every such host). Any other non-Instagram/Meta host Elfsight's script requests must be added to the list.
  - If Step 2 prints 0, or Step 3 does not render: **STOP**, write the result into the spec and ask Jörgen; the spec's client and `deEmbed` sections change.

- [ ] **Step 5: Write "Probe results" in the spec** (hosts seen with their role, late-widget result, Calendar result, date) and commit.

```bash
git checkout -b feat/elfsight-calendar
git add docs/superpowers/specs/2026-10-13-elfsight-calendar-design.md
git commit -m "docs: Elfsight/Calendar probe results"
```

---

### Task 2: Registry rows, CONSENT_VERSION 2, Calendar open link

**Files:**
- Modify: `src/services.ts:4` (`ServiceSlug`), `src/services.ts:16-45` (`SERVICES`)
- Modify: `services.json` (generated)
- Modify: `src/config.ts:11`
- Modify: `tests/unit/consent-terms.json`
- Test: `tests/unit/services.test.ts`, `tests/unit/embed-url.test.ts`

**Interfaces:**
- Produces: `ServiceSlug` includes `'google-calendar' | 'elfsight'`; `matchesRegistry('https://elfsightcdn.com/platform.js') === 'elfsight'`; `matchesRegistry('https://calendar.google.com/calendar/embed?src=x') === 'google-calendar'`.

- [ ] **Step 1: Write the failing tests.** In `tests/unit/services.test.ts`, append to `matchesRegistry classifies known URLs`:

```ts
  expect(matchesRegistry('https://calendar.google.com/calendar/embed?src=x&ctz=Europe%2FStockholm')).toBe('google-calendar')
  expect(matchesRegistry('https://elfsightcdn.com/platform.js')).toBe('elfsight')
  expect(matchesRegistry('https://core.service.elfsight.com/p/boot/?w=abc')).toBe('elfsight')
  expect(matchesRegistry('https://apps.elfsight.com/p/platform.js')).toBe('elfsight')
```

and add:

```ts
test('the Instagram and Facebook image CDNs are not claimed by any service', () => {
  expect(matchesRegistry('https://scontent.cdninstagram.com/v/t51/x.jpg')).toBeNull()
  expect(matchesRegistry('https://scontent-arn2-1.xx.fbcdn.net/v/x.jpg')).toBeNull()
})
```

In `tests/unit/embed-url.test.ts` add:

```ts
test('passes a Google Calendar embed URL through unchanged: it works as a top-level page', () => {
  const src = 'https://calendar.google.com/calendar/embed?src=abc%40group.calendar.google.com&ctz=Europe%2FStockholm'
  expect(deEmbed(src)).toBe(src)
})
```

- [ ] **Step 2: Run, expect failures**

Run: `npx vitest run tests/unit/services.test.ts tests/unit/embed-url.test.ts`
Expected: the two `matchesRegistry` tests FAIL (`null` instead of the slug); the Calendar `deEmbed` test PASSES already (it pins existing behaviour; that is intended).

- [ ] **Step 3: Add the rows.** `src/services.ts`:

```ts
export type ServiceSlug = 'google-maps' | 'google-calendar' | 'google-analytics' | 'google-ads' | 'meta-pixel' | 'elfsight'
```

Insert after `'google-maps'`:

```ts
  'google-calendar': {
    name: 'Google Kalender',
    vendor: 'Google Ireland Ltd',
    category: 'external',
    match: ['calendar.google.com'],
    description_sv: 'Kalendrar från Google.',
  },
```

Append after `'meta-pixel'`:

```ts
  elfsight: {
    name: 'Elfsight',
    vendor: 'Elfsight, SL',
    category: 'external',
    match: ['elfsightcdn.com', 'elfsight.com'],
    description_sv: 'Flöden från sociala medier, till exempel Instagram, via Elfsight.',
  },
```

(Use the `match` list from Task 1 if it differs.)

- [ ] **Step 4: Regenerate and run**

Run: `npm run gen && npx vitest run tests/unit/services.test.ts tests/unit/embed-url.test.ts`
Expected: PASS.

- [ ] **Step 5: Bump the version and register the terms.** Run `npx vitest run tests/unit/consent-terms.test.ts` and confirm `unchanged` FAILS, printing `Current hash: <hash>`. Set `export const CONSENT_VERSION = 2` in `src/config.ts:11`. Add the printed hash to `tests/unit/consent-terms.json`:

```json
{ "1": "c84b631e5e55e0d2640033431beb82ff71d3e64a8436c3a379ff7dc9e40278ec", "2": "<hash printed above>" }
```

- [ ] **Step 6: Run everything unit**

Run: `npm run check && npm test`
Expected: PASS. If `scanError`'s test (it uses `'elfsight'` as an example of an unlisted slug) still passes, leave it; it tests the message, not the registry.

- [ ] **Step 7: Commit**

```bash
git add src/services.ts services.json src/config.ts tests/unit/consent-terms.json tests/unit/services.test.ts tests/unit/embed-url.test.ts
git commit -m "feat: google-calendar and elfsight in the registry; CONSENT_VERSION 2 (#19, #24)"
```

---

### Task 3: Scan recognises ConsentWidget

**Files:**
- Modify: `src/scan.ts:1` (comment), `src/scan.ts:11` (`EMBED_FILE`), `src/scan.ts:44-57` (`embedNames`), `src/scan.ts:269-275` (`scanError` wording)
- Test: `tests/unit/scan.test.ts`

**Interfaces:**
- Produces: `findEmbedServices(source)` returns `service` literals of `<ConsentEmbed>` and `<ConsentWidget>` (and their default-import aliases). `scanError(file, slug, allowed)` keeps its signature; its message says `<ConsentEmbed>/<ConsentWidget>`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/scan.test.ts`:

```ts
const WIDGET = '<ConsentWidget service="elfsight" script="https://elfsightcdn.com/platform.js" title="Instagram"><div class="elfsight-app-a"></div></ConsentWidget>'

test('findEmbedServices reports a live ConsentWidget', () => {
  expect(findEmbedServices(WIDGET)).toEqual(['elfsight'])
})

test('findEmbedServices reports a ConsentWidget imported under another name', () => {
  const source = ["---", "import Feed from '@visionmediahq/astro-consent/components/ConsentWidget.astro'", '---', '<Feed service="elfsight" script="x" title="t" />'].join('\n')
  expect(findEmbedServices(source)).toEqual(['elfsight'])
})

test('findEmbedServices skips ConsentWidget in comments, strings, frontmatter and script blocks', () => {
  const source = [
    '---',
    `const s = '${WIDGET}'`,
    '---',
    `<!-- ${WIDGET} -->`,
    `{/* ${WIDGET} */}`,
    `<p>{"<ConsentWidget service='elfsight' />"}</p>`,
    `<script>const w = '${WIDGET}'</script>`,
  ].join('\n')
  expect(findEmbedServices(source)).toEqual([])
})

test('findEmbedServices ignores MyConsentWidget.astro and ConsentWidgets', () => {
  const source = ["---", "import ConsentWidget from './MyConsentWidget.astro'", '---', WIDGET, '<ConsentWidgets service="x" />'].join('\n')
  expect(findEmbedServices(source)).toEqual([])
})

test('findEmbedServices does not report raw Calendar iframes', () => {
  expect(findEmbedServices('<iframe src="https://calendar.google.com/calendar/embed?src=x"></iframe>')).toEqual([])
})
```

- [ ] **Step 2: Run, expect failures**

Run: `npx vitest run tests/unit/scan.test.ts`
Expected: the first two FAIL (`[]`); the others PASS (they pin existing skips).

- [ ] **Step 3: Implement.** In `src/scan.ts`:

```ts
/** A module specifier whose file is exactly ConsentEmbed.astro or ConsentWidget.astro (not e.g. MapConsentEmbed.astro). */
const EMBED_FILE = /(?:^|\/)Consent(?:Embed|Widget)\.astro$/
const COMPONENT_NAMES = ['ConsentEmbed', 'ConsentWidget'] as const
```

and replace the body of `embedNames`:

```ts
function embedNames(frontmatter: string): Set<string> {
  const names = new Set<string>()
  const takenByOthers = new Set<string>()
  for (const [, name, specifier] of stripJsComments(frontmatter).matchAll(DEFAULT_IMPORT)) {
    if (EMBED_FILE.test(specifier!)) names.add(name!)
    else if ((COMPONENT_NAMES as readonly string[]).includes(name!)) takenByOthers.add(name!)
  }
  for (const name of COMPONENT_NAMES) if (!takenByOthers.has(name)) names.add(name)
  return names
}
```

Update the doc comments above `embedNames` and on line 1 to name both components, and in `scanError` change `<ConsentEmbed service="${slug}">` to `<ConsentEmbed>/<ConsentWidget> service="${slug}"`.

- [ ] **Step 4: Run**

Run: `npx vitest run tests/unit/scan.test.ts && npm run check`
Expected: PASS (adjust any existing `scanError` assertion that matched the old exact wording, keeping its intent).

- [ ] **Step 5: Run the scan over real sites.** For each Elfsight pool site and three sites without Elfsight, run (from this repo, with the site checked out under `~/sites/consent-rollout/<site>` or a fresh shallow clone in the scratchpad):

```bash
npx tsx -e "import {findEmbedServices} from './src/scan.ts'; import {globSync, readFileSync} from 'node:fs'; const dir = process.argv.at(-1); for (const f of globSync(dir + '/src/**/*.astro')) { const s = findEmbedServices(readFileSync(f, 'utf8')); if (s.length) console.log(f, s) }" -- <site dir>
```

Expected: no output on sites that do not use the components. Any hit there is a bug: add it as a test case and fix before continuing. Delete clones afterwards (disk rule in memory).

- [ ] **Step 6: Commit**

```bash
git add src/scan.ts tests/unit/scan.test.ts
git commit -m "feat: the build-time scan covers ConsentWidget"
```

---

### Task 4: Extract EmbedPlaceholder from ConsentEmbed (no behaviour change)

**Files:**
- Create: `src/components/EmbedPlaceholder.astro`
- Modify: `src/components/ConsentEmbed.astro`
- Test: existing `tests/build/build.test.ts`, `tests/e2e/embed.spec.ts`, `a11y.spec.ts`, `contrast.spec.ts`, `nojs.spec.ts`

**Interfaces:**
- Produces: `<EmbedPlaceholder service: ServiceSlug, title: string, infoId: string, openHref?: string>` with a default slot for the info text (fallback: `sv.embed.info`). Renders `[data-placeholder]` with `[data-load]`, `[data-remember]` and, only when `openHref` is set, `a[data-open]`.

- [ ] **Step 1: Baseline.** Run `npm run demo:build -- consent && npm run demo:build -- notice && npx playwright test tests/e2e/embed.spec.ts tests/e2e/nojs.spec.ts tests/e2e/a11y.spec.ts tests/e2e/contrast.spec.ts`. Expected: PASS. Save the built `demo/dist-consent/client/karta/index.html` to the scratchpad as `karta-before.html`.

- [ ] **Step 2: Create `src/components/EmbedPlaceholder.astro`:**

```astro
---
// The click-to-load placeholder shared by ConsentEmbed and ConsentWidget. client.ts finds its
// controls through the DOM contract in CLAUDE.md; keep the attributes and classes identical.
import { SERVICES, type ServiceSlug } from '../services'
import sv from '../text/sv.json'

interface Props {
  service: ServiceSlug
  title: string
  infoId: string
  /** Link to open the content at the provider; no link when omitted (script widgets). */
  openHref?: string
}

const { service, title, infoId, openHref } = Astro.props
const { name } = SERVICES[service]
const fill = (text: string, vars: Record<string, string>): string =>
  text.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match)
---

{/* In normal flow, not absolute: on a narrow screen the box grows instead of clipping. */}
<div data-placeholder class="flex flex-1 flex-col justify-between gap-3 p-4">
  <div class="text-sm" id={infoId}>
    <slot>
      <p>{fill(sv.embed.info, { title, name })}</p>
    </slot>
  </div>
  <div class="flex flex-wrap items-center gap-3">
    <button
      type="button"
      class="btn btn-primary btn-sm h-auto min-h-8 whitespace-normal"
      data-load
      aria-describedby={infoId}>{fill(sv.embed.show, { name })}</button
    >
    <label class="flex cursor-pointer items-center gap-2 text-xs">
      <input type="checkbox" class="checkbox checkbox-sm" data-remember />
      {fill(sv.embed.remember, { name })}
    </label>
    {
      openHref && (
        <a href={openHref} target="_blank" rel="noopener noreferrer" class="link text-xs" data-open>
          {fill(sv.embed.open, { name })}
        </a>
      )
    }
  </div>
</div>
```

- [ ] **Step 3: Use it in `ConsentEmbed.astro`.** Remove the `SERVICES`, `sv` and `fill` imports/definitions that only the placeholder used, import `EmbedPlaceholder from './EmbedPlaceholder.astro'`, and replace the whole `<div data-placeholder …>…</div>` with:

```astro
  {
    Astro.slots.has('placeholder') ? (
      <EmbedPlaceholder service={service} title={title} infoId={infoId} openHref={openHref}>
        <slot name="placeholder" />
      </EmbedPlaceholder>
    ) : (
      <EmbedPlaceholder service={service} title={title} infoId={infoId} openHref={openHref} />
    )
  }
```

Keep the component's header comment.

- [ ] **Step 4: Verify identical output and behaviour**

Run: `npm run check && npm run demo:build -- consent && npm run demo:build -- notice && npm run test:build && npx playwright test tests/e2e/embed.spec.ts tests/e2e/nojs.spec.ts tests/e2e/a11y.spec.ts tests/e2e/contrast.spec.ts`
Expected: PASS. `diff` the new `karta/index.html` with `karta-before.html`: only the random `consent-embed-xxxxxxxx-info` ids and Astro's scoping/asset hashes may differ.

- [ ] **Step 5: Commit**

```bash
git add src/components/EmbedPlaceholder.astro src/components/ConsentEmbed.astro
git commit -m "refactor: EmbedPlaceholder shared by embeds and (next) widgets"
```

---

### Task 5: ConsentWidget component, render-time checks, demo page

**Files:**
- Create: `src/widget.ts`, `src/components/ConsentWidget.astro`, `demo/src/pages/flode.astro`, `tests/unit/widget.test.ts`
- Modify: `demo/privacy.consent.json`, `scripts/demo-copy.ts:12` (`EMBED_PAGES`), `tests/build/build.test.ts`, `tests/build/site-typecheck.test.ts`, `tests/e2e/smoke.spec.ts:9`

**Interfaces:**
- Consumes: `matchesRegistry`, `ServiceSlug` (Task 2); `EmbedPlaceholder` (Task 4); `scanError` (Task 3).
- Produces: `widgetError(file: string, service: ServiceSlug, script: string, markup: string): string | null`. `<ConsentWidget service script title id? minHeight?>` rendering `div[data-consent-embed=<slug>][data-script=<url>] > template[data-payload] + [data-placeholder]`. Demo page `/flode` with `#kalender` (ConsentEmbed, google-calendar), `#flode-a` and `#flode-b` (ConsentWidget, elfsight, script `https://elfsightcdn.com/platform.js`, payload divs `elfsight-app-demo-a` / `elfsight-app-demo-b`).

- [ ] **Step 1: Write the failing unit tests** `tests/unit/widget.test.ts`:

```ts
import { expect, test } from 'vitest'
import { widgetError } from '../../src/widget'

const OK = 'https://elfsightcdn.com/platform.js'
const DIV = '<div class="elfsight-app-a" data-elfsight-app-lazy></div>'

test('accepts an https script on the service’s own host and plain markup', () => {
  expect(widgetError('src/pages/a.astro', 'elfsight', OK, DIV)).toBeNull()
})

test('rejects a relative or malformed script URL', () => {
  expect(widgetError('src/pages/a.astro', 'elfsight', '/platform.js', DIV)).toMatch(/absolute URL/)
})

test('rejects http:', () => {
  expect(widgetError('src/pages/a.astro', 'elfsight', 'http://elfsightcdn.com/platform.js', DIV)).toMatch(/https:/)
})

test('rejects a script that belongs to another service or to none', () => {
  expect(widgetError('src/pages/a.astro', 'elfsight', 'https://maps.googleapis.com/maps/api/js', DIV)).toMatch(/google-maps/)
  expect(widgetError('src/pages/a.astro', 'elfsight', 'https://cdn.example.test/w.js', DIV)).toMatch(/no service/)
})

test('ignores the query string when matching the host', () => {
  expect(widgetError('src/pages/a.astro', 'elfsight', 'https://evil.test/x.js?u=elfsightcdn.com', DIV)).toMatch(/no service/)
})

test('rejects a <script> in the slot, any case and form', () => {
  for (const markup of ['<script src="x"></script>', '<SCRIPT>1</SCRIPT>', '<script type="module" src="/_astro/a.js"></script>']) {
    expect(widgetError('src/pages/a.astro', 'elfsight', OK, DIV + markup)).toMatch(/no <script>/)
  }
})

test('names the file and the service', () => {
  expect(widgetError('src/pages/kontakt.astro', 'elfsight', 'http://x', DIV)).toMatch(/src\/pages\/kontakt\.astro.*elfsight/)
})
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/unit/widget.test.ts`
Expected: FAIL, cannot resolve `../../src/widget`.

- [ ] **Step 3: Implement `src/widget.ts`:**

```ts
// Render-time checks for <ConsentWidget>. Pure and node-free, so the rules are unit-tested without a build.
import { matchesRegistry, type ServiceSlug } from './services'

/** Why a <ConsentWidget> must not render, or null when it may. */
export function widgetError(file: string, service: ServiceSlug, script: string, markup: string): string | null {
  const where = `[astro-consent] ${file}: <ConsentWidget service="${service}">`
  let url: URL
  try {
    url = new URL(script)
  } catch {
    return `${where}: script "${script}" is not an absolute URL.`
  }
  if (url.protocol !== 'https:') return `${where}: script must use https:, got "${script}".`
  // Origin and path only: a query string may mention any host.
  const owner = matchesRegistry(url.origin + url.pathname)
  if (owner !== service) {
    return `${where}: script "${script}" does not belong to ${service} (it matches ${owner ?? 'no service'}).`
  }
  if (/<script\b/i.test(markup)) {
    return `${where}: no <script> in the slot, it would run before consent. Pass the provider's script URL as the script prop.`
  }
  return null
}
```

Run: `npx vitest run tests/unit/widget.test.ts` → PASS.

- [ ] **Step 4: Create `src/components/ConsentWidget.astro`:**

```astro
---
// Click-to-load for a service that loads by <script> instead of an iframe (e.g. Elfsight). The slot's
// markup sits inert in a <template>; client.ts appends it and loads `script` once when the visitor
// clicks "Visa" or has granted the service. Never put a <script> in the slot: the build fails.
import '../styles/contrast.css'
import config from 'virtual:astro-consent/config'
import { scanError } from '../scan'
import type { ServiceSlug } from '../services'
import { widgetError } from '../widget'
import EmbedPlaceholder from './EmbedPlaceholder.astro'

interface Props {
  service: ServiceSlug
  /** The provider's script URL, exactly as the provider gives it. Must be https: on the service's host. */
  script: string
  title: string
  /** Height of the placeholder box; the active widget sizes itself. */
  minHeight?: string
  id?: string
}

const { service, script, title, minHeight = '12rem', id } = Astro.props

// Fallback for a non-literal `service`; literal ones are caught by the build-time scan.
if (!config.services.includes(service)) {
  throw new Error(scanError(Astro.url.pathname, service, config.services))
}
const markup = await Astro.slots.render('default')
const error = widgetError(Astro.url.pathname, service, script, markup)
if (error) throw new Error(error)

const infoId = `${id ?? 'consent-embed-' + crypto.randomUUID().slice(0, 8)}-info`
---

<div
  id={id}
  data-consent-embed={service}
  data-script={script}
  class="relative flex min-h-(--consent-min-h) flex-col rounded-box bg-base-200 text-base-content data-active:min-h-0 data-active:bg-transparent"
  style={`--consent-min-h: ${minHeight}`}
>
  <template data-payload><Fragment set:html={markup} /></template>
  <EmbedPlaceholder service={service} title={title} infoId={infoId} />
</div>
```

- [ ] **Step 5: Demo.** `demo/privacy.consent.json`:

```json
{
  "services": ["google-maps", "google-analytics", "google-calendar", "elfsight"],
  "policy_url": "https://demo.test/integritet",
  "log_endpoint": "https://log.demo.test/consent"
}
```

`demo/src/pages/flode.astro`:

```astro
---
import ConsentEmbed from '@visionmediahq/astro-consent/components/ConsentEmbed.astro'
import ConsentWidget from '@visionmediahq/astro-consent/components/ConsentWidget.astro'
import Base from '../layouts/Base.astro'
export const prerender = true
---

<Base title="Flöde">
  <h1 class="text-2xl font-bold">Kalender och flöde</h1>
  <div class="mt-4 flex flex-col gap-6">
    <ConsentEmbed
      id="kalender"
      service="google-calendar"
      src="https://calendar.google.com/calendar/embed?src=demo%40group.calendar.google.com&ctz=Europe%2FStockholm"
      title="Vår kalender"
    />
    <ConsentWidget id="flode-a" service="elfsight" script="https://elfsightcdn.com/platform.js" title="Instagram A">
      <div class="elfsight-app-demo-a" data-elfsight-app-lazy></div>
    </ConsentWidget>
    <ConsentWidget id="flode-b" service="elfsight" script="https://elfsightcdn.com/platform.js" title="Instagram B">
      <div class="elfsight-app-demo-b" data-elfsight-app-lazy></div>
    </ConsentWidget>
  </div>
</Base>
```

`scripts/demo-copy.ts:12`: add `'src/pages/flode.astro'` to `EMBED_PAGES` and update its comment to "Pages with a <ConsentEmbed> or <ConsentWidget>". `tests/e2e/smoke.spec.ts:9`: expect `['google-maps', 'google-analytics', 'google-calendar', 'elfsight']`.

- [ ] **Step 6: Write the build tests** in `tests/build/build.test.ts`, after the `build-time ConsentEmbed scan` describe:

```ts
const WIDGET_IMPORT = "import ConsentWidget from '@visionmediahq/astro-consent/components/ConsentWidget.astro'"

function widgetPage(body: string): string {
  return ['---', WIDGET_IMPORT, 'export const prerender = true', '---', '<html><head><title>t</title></head><body>', body, '</body></html>'].join('\n')
}

describe('ConsentWidget', () => {
  test('the demo widget page renders an inert template with data-script and no script tag of the service', TIMEOUT, () => {
    const html = consentBuild.html('flode/index.html')
    const widget = html.querySelector('#flode-a')!
    expect(widget.getAttribute('data-consent-embed')).toBe('elfsight')
    expect(widget.getAttribute('data-script')).toBe('https://elfsightcdn.com/platform.js')
    expect(widget.querySelector('template[data-payload]')!.innerHTML).toContain('elfsight-app-demo-a')
    expect(widget.querySelector('a[data-open]')).toBeNull()
    expect(html.querySelectorAll('script').some((s) => (s.getAttribute('src') ?? '').includes('elfsight'))).toBe(false)
  })

  test('build fails on a widget whose service is not in privacy.json', TIMEOUT, () => {
    const build = buildDemo('consent', (dir) => {
      writePrivacy(dir, { services: ['google-maps'] })
      writeFileSync(join(dir, 'src/pages/bad.astro'), widgetPage('<ConsentWidget service="elfsight" script="https://elfsightcdn.com/platform.js" title="x"><div></div></ConsentWidget>'))
    })
    expect(build.code).not.toBe(0)
    expect(build.output).toMatch(/bad\.astro/)
    expect(build.output).toMatch(/elfsight/)
  })

  test('build fails on a script from another host', TIMEOUT, () => {
    const build = buildDemo('consent', (dir) =>
      writeFileSync(join(dir, 'src/pages/bad.astro'), widgetPage('<ConsentWidget service="elfsight" script="https://cdn.example.test/w.js" title="x"><div></div></ConsentWidget>')),
    )
    expect(build.code).not.toBe(0)
    expect(build.output).toMatch(/does not belong to elfsight/)
  })

  for (const tag of ['<script>console.log(1)</script>', '<script is:inline src="https://elfsightcdn.com/platform.js"></script>']) {
    test(`build fails on ${tag.slice(0, 18)}… in the slot`, TIMEOUT, () => {
      const build = buildDemo('consent', (dir) =>
        writeFileSync(join(dir, 'src/pages/bad.astro'), widgetPage(`<ConsentWidget service="elfsight" script="https://elfsightcdn.com/platform.js" title="x"><div></div>${tag}</ConsentWidget>`)),
      )
      expect(build.code).not.toBe(0)
      expect(build.output).toMatch(/no <script> in the slot/)
    })
  }
})
```

(`consentBuild` is the shared consent build already used by the "banner and footer markup" describe; if it is scoped inside that describe, move its `beforeAll` to file level.)

In the "service rows" test, extend the slug list to all four services and add `expect(banner.querySelector('[data-consent-category="external"] [data-consent-service="elfsight"]')).not.toBeNull()`.

In `tests/build/site-typecheck.test.ts`, add `ConsentWidget` to the component imports the fake site type-checks, alongside `ConsentEmbed` (follow that file's existing import list).

- [ ] **Step 7: Run**

Run: `npm run check && npm test && npm run test:build`
Expected: PASS. If the plain-`<script>` case is not caught (Astro hoisted it out of the slot's rendered HTML), STOP and report: the spec's no-script rule then needs a scan-time check instead.

- [ ] **Step 8: Commit**

```bash
git add src/widget.ts src/components/ConsentWidget.astro demo/privacy.consent.json demo/src/pages/flode.astro scripts/demo-copy.ts tests/unit/widget.test.ts tests/build/build.test.ts tests/build/site-typecheck.test.ts tests/e2e/smoke.spec.ts
git commit -m "feat: ConsentWidget, click-to-load for script widgets (#24)"
```

---

### Task 6: client.ts loads the widget script; e2e

**Files:**
- Modify: `src/client.ts:111-120` (`activate`)
- Modify: `tests/e2e/helpers.ts` (`stub`)
- Create: `tests/e2e/widget.spec.ts`
- Modify: `tests/e2e/nojs.spec.ts`, `tests/e2e/a11y.spec.ts`, `tests/e2e/contrast.spec.ts`

**Interfaces:**
- Consumes: demo `/flode` from Task 5 (`#kalender`, `#flode-a`, `#flode-b`).
- Produces: after activation of an element with `data-script`, exactly one `script[src=<url>]` in `document.head`. Test hook in the fake script: `window.__elfsightLoads` (count of executions).

- [ ] **Step 1: Fake platform.js in `stub()`.** In `tests/e2e/helpers.ts`, above `stub`:

```ts
/**
 * Stands in for elfsightcdn.com/platform.js. Like the real one it renders every widget div present
 * when it runs and, through a MutationObserver, every one added later.
 */
const FAKE_ELFSIGHT = `
  window.__elfsightLoads = (window.__elfsightLoads || 0) + 1
  const render = () => {
    for (const el of document.querySelectorAll('[class*="elfsight-app-"]:not([data-rendered])')) {
      el.setAttribute('data-rendered', '')
      el.textContent = 'flöde'
    }
  }
  render()
  new MutationObserver(render).observe(document.body, { childList: true, subtree: true })
`
```

In the route handler, choose the body:

```ts
      const url = route.request().url()
      const body = url.includes('elfsightcdn.com/platform.js') ? FAKE_ELFSIGHT : '/* stub */'
      await route.fulfill(
        isDocument
          ? { status: 200, contentType: 'text/html', body: '<html><body data-stub></body></html>' }
          : { status: 200, contentType: 'application/javascript', body },
      )
```

- [ ] **Step 2: Write the failing e2e** `tests/e2e/widget.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test'
import { action, seed, stored, stub } from './helpers'

const show = (page: Page, id: string) => page.locator(`#${id} [data-load]`)
const remember = (page: Page, id: string) => page.locator(`#${id} [data-remember]`)
const rendered = (page: Page, id: string) => page.locator(`#${id} [data-rendered]`)
const scriptTags = (page: Page) => page.locator('script[src="https://elfsightcdn.com/platform.js"]')
const elfsightLoads = (page: Page) => page.evaluate(() => (window as unknown as { __elfsightLoads?: number }).__elfsightLoads ?? 0)

test('before consent nothing is requested from Elfsight or Google Calendar', async ({ page, context }) => {
  const stubs = await stub(context)
  await page.goto('/flode')
  await page.waitForLoadState('networkidle')
  expect(stubs.registry).toEqual([])
  await expect(page.locator('#flode-a [data-load]')).toHaveText('Visa Elfsight')
  await expect(page.locator('#flode-a a[data-open]')).toHaveCount(0)
  await expect(page.locator('#kalender a[data-open]')).toHaveAttribute('href', /calendar\.google\.com\/calendar\/embed\?src=/)
})

test('one-off Visa on widget A renders A only, loads the script once and stores nothing', async ({ page, context }) => {
  const stubs = await stub(context)
  await page.goto('/flode')
  await show(page, 'flode-a').click()
  await expect(rendered(page, 'flode-a')).toHaveCount(1)
  await expect(page.locator('#flode-a')).toHaveAttribute('data-active', '')
  await expect(page.locator('#flode-b [data-placeholder]')).toBeVisible()
  await expect(page.locator('[class*="elfsight-app-demo-b"]')).toHaveCount(0)
  await expect(scriptTags(page)).toHaveCount(1)
  expect(stubs.registry.every((u) => u.includes('elfsight'))).toBe(true)
  expect(await stored(page)).toBeNull()
})

test('Visa on B after A renders B without a second script', async ({ page, context }) => {
  await stub(context)
  await page.goto('/flode')
  await show(page, 'flode-a').click()
  await expect(rendered(page, 'flode-a')).toHaveCount(1)
  await show(page, 'flode-b').click()
  await expect(rendered(page, 'flode-b')).toHaveCount(1)
  await expect(scriptTags(page)).toHaveCount(1)
  expect(await elfsightLoads(page)).toBe(1)
})

test('remember on A activates both widgets and grants elfsight only', async ({ page, context }) => {
  await stub(context)
  await page.goto('/flode')
  await remember(page, 'flode-a').check()
  await show(page, 'flode-a').click()
  await expect(rendered(page, 'flode-a')).toHaveCount(1)
  await expect(rendered(page, 'flode-b')).toHaveCount(1)
  await expect(page.locator('#kalender iframe')).toHaveCount(0)
  expect((await stored(page))!.services).toEqual(['elfsight'])
})

test('Acceptera alla activates the calendar and both widgets', async ({ page, context }) => {
  await stub(context)
  await page.goto('/flode')
  await action(page, 'all').click()
  await expect(page.locator('#kalender iframe')).toHaveAttribute('src', /calendar\.google\.com/)
  await expect(rendered(page, 'flode-a')).toHaveCount(1)
  await expect(rendered(page, 'flode-b')).toHaveCount(1)
  await expect(scriptTags(page)).toHaveCount(1)
})

test('a grant from another tab activates the widgets without this tab writing', async ({ page, context }) => {
  await stub(context)
  await page.goto('/flode')
  const other = await context.newPage()
  await other.goto('/flode')
  await page.evaluate(() => {
    ;(window as unknown as { __writes: number }).__writes = 0
    const set = localStorage.setItem.bind(localStorage)
    localStorage.setItem = (k: string, v: string) => {
      if (k === 'vm_consent') (window as unknown as { __writes: number }).__writes++
      set(k, v)
    }
  })
  await action(other, 'all').click()
  await expect(rendered(page, 'flode-a')).toHaveCount(1)
  await expect(rendered(page, 'flode-b')).toHaveCount(1)
  expect(await page.evaluate(() => (window as unknown as { __writes: number }).__writes)).toBe(0)
})

test('a stored record without elfsight keeps the widgets inert', async ({ page, context }) => {
  const stubs = await stub(context)
  await seed(page, '/flode', { choice: 'custom', categories: ['necessary'], services: ['google-calendar'] })
  await expect(page.locator('#kalender iframe')).toHaveCount(1)
  await page.waitForLoadState('networkidle')
  await expect(page.locator('#flode-a [data-placeholder]')).toBeVisible()
  expect(stubs.registry.some((u) => u.includes('elfsight'))).toBe(false)
})
```

- [ ] **Step 3: Run, expect failures**

Run: `npm run demo:build -- consent && npx playwright test tests/e2e/widget.spec.ts`
Expected: the "before consent" and "stored record without elfsight" tests PASS; every test expecting `[data-rendered]` FAILS (template appended, script never loaded).

- [ ] **Step 4: Implement in `src/client.ts`.** Next to `activate`:

```ts
  /** Script widgets: loads the provider script once per URL. Only activate() calls this. */
  function loadScript(src: string): void {
    if (document.querySelector(`script[src="${CSS.escape(src)}"]`)) return
    const script = document.createElement('script')
    script.src = src
    script.async = true
    document.head.append(script)
  }
```

In `activate(el)`, after `active.add(…)`:

```ts
    if (el.dataset.script) loadScript(el.dataset.script)
```

Update `activate`'s doc comment to "Swaps an embed's placeholder for its payload, and loads a widget's script."

- [ ] **Step 5: Run**

Run: `npm run check && npm run demo:build -- consent && npx playwright test tests/e2e/widget.spec.ts tests/e2e/embed.spec.ts tests/e2e/crosstab.spec.ts tests/e2e/withdraw.spec.ts`
Expected: PASS.

- [ ] **Step 6: Extend nojs, a11y, contrast.** In `tests/e2e/nojs.spec.ts` add:

```ts
test('without JavaScript the widget page requests nothing and shows placeholders', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL: 'http://localhost:4321' })
  const stubs = await stub(context)
  const page = await context.newPage()
  await page.goto('/flode')
  await page.waitForLoadState('networkidle')
  await expect(page.locator('#flode-a [data-placeholder]')).toBeVisible()
  await expect(page.locator('#kalender [data-placeholder]')).toBeVisible()
  await expect(page.locator('[class*="elfsight-app-"]')).toHaveCount(0)
  expect(stubs.registry).toEqual([])
  await context.close()
})
```

In `a11y.spec.ts`, copy the `embed placeholder has no axe violations` test as `widget placeholders have no axe violations` with `page.goto('/flode')`. In `contrast.spec.ts`, copy `embed Visa button is AA on a red primary` as `widget Visa button is AA on a red primary` with `/flode` and the selector `#flode-a [data-load]` (keep the rest of the body identical).

Run: `npx playwright test` → PASS (needs both demo builds: `npm run demo:build -- consent && npm run demo:build -- notice`).

- [ ] **Step 7: Commit**

```bash
git add src/client.ts tests/e2e/helpers.ts tests/e2e/widget.spec.ts tests/e2e/nojs.spec.ts tests/e2e/a11y.spec.ts tests/e2e/contrast.spec.ts
git commit -m "feat: activating a widget loads its script once (#24)"
```

---

### Task 7: Docs, version, full verification, PR

**Files:**
- Modify: `README.md` (after `### <ConsentEmbed>`, around line 114; the registry/services list), `CHANGELOG.md`, `CLAUDE.md` (DOM contract), `package.json` (`"version": "1.1.0"`)

- [ ] **Step 1: README.** Add `### <ConsentWidget>` after the `ConsentEmbed` section:

````markdown
### `<ConsentWidget>`

Click-to-load for services that load by `<script>` instead of an iframe (Elfsight). The widget
markup goes in the slot and stays inert until the visitor clicks "Visa" or has granted the service;
then the script is loaded once per page.

```astro
---
import ConsentWidget from '@visionmediahq/astro-consent/components/ConsentWidget.astro'
---
<ConsentWidget service="elfsight" script="https://elfsightcdn.com/platform.js" title="Vårt Instagramflöde">
  <div class="elfsight-app-<id>" data-elfsight-app-lazy></div>
</ConsentWidget>
```

- `script` must be `https:` and on the service's own host; the build fails otherwise.
- Never put a `<script>` in the slot: the build fails. Remove the provider's `<script>` tag and pass
  its URL as `script`.
- `minHeight` (default `12rem`) sizes the placeholder; the active widget sizes itself.
````

Add `google-calendar` (`<ConsentEmbed>`) and `elfsight` (`<ConsentWidget>`) to the README's list of registry services, in that list's format.

- [ ] **Step 2: CLAUDE.md DOM contract.** Replace the embed line with:

```
[data-consent-embed=<slug>][data-script=<url>]? template[data-payload] [data-placeholder] [data-load] [data-remember] a[data-open]?
  + [data-active] once the payload is in; a widget (data-script, no a[data-open]) also gets its script, once per URL
```

- [ ] **Step 3: CHANGELOG.** Under the `# Changelog` heading, above `## Unreleased: repo tool`:

```markdown
## 1.1.0

- New services: `google-calendar` (use `<ConsentEmbed>`; the open link is the embed URL, which works
  as a page) and `elfsight` (vendor Elfsight, SL).
- New `<ConsentWidget>`: click-to-load for script widgets. Same placeholder, one-off Visa and
  remember box as `<ConsentEmbed>`; the provider script loads once per page on activation. The build
  fails on an unlisted service, a script outside the service's hosts, or a `<script>` in the slot.
- `CONSENT_VERSION` 2: the registry's terms changed, so every visitor on every site is asked again
  after the site's next install (accepted in #19 and #24).
```

Set `"version": "1.1.0"` in `package.json`.

- [ ] **Step 4: Full verification**

```bash
npm run check && npm test && npm run test:build
npm run demo:build -- consent && npm run demo:build -- notice && npm run test:e2e
npm run test:pack -- 6.1.6 10.0.4
npm run test:pack -- 7.3.5 11.1.6
```

Expected: all PASS. Paste the summary lines into the PR body.

- [ ] **Step 5: Commit, push, open PR**

```bash
git add README.md CLAUDE.md CHANGELOG.md package.json
git commit -m "docs: ConsentWidget, 1.1.0 changelog"
git push -u origin feat/elfsight-calendar
gh pr create --title "1.1.0: Elfsight and Google Calendar, ConsentWidget" --body "<summary, test output, Closes #19, Closes #24 (detect/wire follows in a tool PR)>"
```

**Stop here.** Merging and tagging are Jörgen's: after merge, `starter-install` must be green on `main` with `STARTER_INSTALL=true`, then `git tag -a v1.1.0 -m "…"` and push the tag (public and picked up by every site on `semver:^1.0.0`). The `detect`/`wire` tool PR (spec, "Rollout tool") is planned separately once the real Elfsight markup variants are collected.
