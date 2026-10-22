# Rollout Retro Artifact Implementation Plan

Sites are named by GitHub repo ID (`gh api repositories/<id>`).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A private, static Artifact page for the Task 27 retro: goal and status, timeline from
2026-09-12, a filterable issues-and-fixes log, open retro items, and a "how it was caught" chart.

**Architecture:** Typed data (`findings.ts`, `milestones.ts`) feeds pure functions (`derive.ts`)
that compute every number and run the pre-publish checks. `page.ts` renders the whole page to one
HTML string on the server side; the only browser script is a small inline filter that toggles
`hidden` on pre-rendered rows. `build.ts` validates and writes `out/rollout-retro.html`, which is
published with the Artifact tool.

**Tech Stack:** TypeScript (strict), tsx, vitest, Playwright (chromium, already a devDependency) for
the layout check. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-12-rollout-retro-artifact-design.md`

## Global Constraints

- All build source and data live in `.superpowers/retro-artifact/` (gitignored). This repo is
  public; nothing from the batch log or ledger goes into a tracked file. No commits in Tasks 1–4.
- TypeScript only, strict. The browser filter script is inline inside the generated HTML, not a
  `.js` file.
- Time window 2026-09-12 to the compile date. Dates are ISO `YYYY-MM-DD` strings, never `Date`
  objects (no timezone shifts).
- Every number on the page derives from the data arrays.
- Every row has `source.url` or `source.path`; rows not `retro-open`, `false-positive` or
  `not-a-finding` have at least one `fixRef`.
- English. Private Artifact. No token values anywhere (names like `COOLIFY_SETUP_TOKEN` are fine).
- Page: colour tokens on `:root` with dark mode (per `artifact-design`), 16 px side gutters, no
  horizontal page scroll at 360 px. Chart in inline SVG following `dataviz`.
- `localStorage` only for the remembered filter, every access in try/catch.

## Review Focus

1. Excerpts and symptoms contain `<iframe>`, `&`, quotes and backticks: they must render as text,
   never as markup. Pinned in Task 3 (`escapes markup in data`).
2. Long unbroken strings (commit SHAs, file paths, URLs) at 360 px must not widen the page. Pinned
   in Task 4 (`scrollWidth <= clientWidth` at 360 px).
3. `localStorage` that throws (private mode, preview) must not break the filters. Pinned in Task 3
   (filter script wraps access; test asserts the try/catch is present) and Task 4 (run with storage
   throwing).
4. A filter combination matching nothing shows "No findings match these filters", not an empty
   table. Pinned in Task 3 (empty-state element rendered) and Task 4 (click to zero rows).
5. A date like `2026-10-05` must show as 5 Oct, not 4 Oct, in any timezone. Pinned in Task 1
   (`formatDate` is string-based) and Task 3 (rendered date).

---

### Task 1: Types and derive functions

**Files:**
- Create: `.superpowers/retro-artifact/types.ts`
- Create: `.superpowers/retro-artifact/derive.ts`
- Create: `.superpowers/retro-artifact/tsconfig.json`
- Test: `.superpowers/retro-artifact/derive.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `types.ts`: `Finding`, `Milestone`, `Layer`, `Status`, `CaughtBy`, `Phase`, `Ref`, and the
    const arrays `LAYERS`, `STATUSES`, `CAUGHT_BY`.
  - `derive.ts`:
    - `formatDate(iso: string): string` → `"5 Oct"`.
    - `stats(findings: Finding[], milestones: Milestone[]): { sitesLive: number; releases: string[]; toolPrs: number; findings: number; retroOpen: number }`.
    - `countBy<K extends string>(findings: Finding[], key: (f: Finding) => K): Map<K, number>`.
    - `caughtByLayer(findings: Finding[]): { caughtBy: CaughtBy; byLayer: Record<Layer, number>; total: number }[]` sorted by total descending.
    - `retroGroups(findings: Finding[]): Record<RetroGroup, Finding[]>`.
    - `findingsOn(findings: Finding[], date: string): number`.
    - `validate(findings: Finding[], milestones: Milestone[], requiredIds: string[], compiledOn: string): string[]` → list of problems; empty means publishable.

- [ ] **Step 1: Write the types**

```ts
// .superpowers/retro-artifact/types.ts
export const LAYERS = ['package', 'rollout-tool', 'wire-detect', 'site', 'infra-ops'] as const
export const STATUSES = [
  'fixed-package', 'fixed-tool', 'fixed-site-branch', 'retro-open', 'false-positive', 'not-a-finding',
] as const
export const CAUGHT_BY = [
  'verify-step-1', 'verify-step-2', 'verify-step-3', 'verify-step-4', 'verify-step-5',
  'verify-step-6', 'verify-step-7', 'verify-step-8',
  'live-check', 'screenshot', 'subagent-review', 'by-hand', 'detect',
] as const
export const RETRO_GROUPS = ['package-v1.1', 'rollout-tool', 'fleet-process'] as const

export type Layer = (typeof LAYERS)[number]
export type Status = (typeof STATUSES)[number]
export type CaughtBy = (typeof CAUGHT_BY)[number]
export type RetroGroup = (typeof RETRO_GROUPS)[number]
export type Phase = 'package' | 'pilot' | 'expansion' | 'observation'
export type Ref = { label: string; url: string }

export type Finding = {
  id: string
  date: string
  site: string | null
  phase: Phase
  layer: Layer
  symptom: string
  cause: string
  fix: string
  fixRef: Ref[]
  caughtBy: CaughtBy
  status: Status
  retro: { group: RetroGroup; question: string; doneBy?: Ref } | null
  source: { label: string; url?: string; path?: string; excerpt: string }
}

export type Milestone = {
  date: string           // ISO; upcoming ones may be later than the compile date
  label: string
  upcoming: boolean
  refs: Ref[]
  sitesLive?: number     // cumulative sites live after this milestone, when it changed
  release?: string       // e.g. "v1.0.1"
  toolPrs?: number[]     // astro-consent rollout-tool PR numbers merged that day
}
```

Note against the spec: `retro` is an object, not a string, because Section 4 groups items and
strikes through done ones; `stats` reads `sitesLive`, `release` and `toolPrs` from milestones so
the tiles derive from data.

- [ ] **Step 2: Write the tsconfig**

```json
{
  "extends": "../../tsconfig.json",
  "include": ["./*.ts"],
  "exclude": []
}
```

- [ ] **Step 3: Write the failing tests**

```ts
// .superpowers/retro-artifact/derive.test.ts
import { describe, expect, it } from 'vitest'
import type { Finding, Milestone } from './types'
import { caughtByLayer, countBy, findingsOn, formatDate, retroGroups, stats, validate } from './derive'

const f = (over: Partial<Finding>): Finding => ({
  id: 'x', date: '2026-10-08', site: 'site-1286030122', phase: 'expansion', layer: 'rollout-tool',
  symptom: 's', cause: 'c', fix: 'fx', fixRef: [{ label: '#5', url: 'https://github.com/visionmediahq/astro-consent/pull/5' }],
  caughtBy: 'verify-step-1', status: 'fixed-tool', retro: null,
  source: { label: 'batch log', path: 'site-factory/.superpowers/sdd/x/log.md', excerpt: 'e' },
  ...over,
})
const m = (over: Partial<Milestone>): Milestone => ({ date: '2026-10-03', label: 'l', upcoming: false, refs: [], ...over })

describe('formatDate', () => {
  it('formats from the string, never shifting a day', () => {
    expect(formatDate('2026-10-05')).toBe('5 Oct')
    expect(formatDate('2026-09-24')).toBe('24 Sep')
  })
})

describe('stats', () => {
  it('derives tiles from data', () => {
    const ms = [
      m({ release: 'v1.0.0' }),
      m({ date: '2026-10-05', sitesLive: 7, release: 'v1.0.1' }),
      m({ date: '2026-10-08', toolPrs: [3, 4, 5] }),
      m({ date: '2026-10-12', sitesLive: 27, toolPrs: [14, 15] }),
      m({ date: '2026-10-15', upcoming: true, sitesLive: 99 }),
    ]
    const fs = [f({}), f({ id: 'y', status: 'retro-open', fixRef: [] })]
    expect(stats(fs, ms)).toEqual({ sitesLive: 27, releases: ['v1.0.0', 'v1.0.1'], toolPrs: 5, findings: 2, retroOpen: 1 })
  })
})

describe('countBy / findingsOn', () => {
  it('counts', () => {
    const fs = [f({}), f({ id: 'y', layer: 'site' }), f({ id: 'z', layer: 'site', date: '2026-10-09' })]
    expect(countBy(fs, (x) => x.layer).get('site')).toBe(2)
    expect(findingsOn(fs, '2026-10-08')).toBe(2)
  })
})

describe('caughtByLayer', () => {
  it('stacks by layer, sorted by total, omitting zero rows', () => {
    const fs = [f({}), f({ id: 'y', caughtBy: 'screenshot', layer: 'site' }), f({ id: 'z', caughtBy: 'screenshot' })]
    const rows = caughtByLayer(fs)
    expect(rows.map((r) => r.caughtBy)).toEqual(['screenshot', 'verify-step-1'])
    expect(rows[0]).toMatchObject({ total: 2, byLayer: { site: 1, 'rollout-tool': 1, package: 0 } })
  })
})

describe('retroGroups', () => {
  it('groups findings that carry a retro question', () => {
    const fs = [f({}), f({ id: 'y', retro: { group: 'fleet-process', question: 'q' } })]
    expect(retroGroups(fs)['fleet-process'].map((x) => x.id)).toEqual(['y'])
    expect(retroGroups(fs)['package-v1.1']).toEqual([])
  })
})

describe('validate', () => {
  const ok = [f({})]
  it('passes clean data', () => {
    expect(validate(ok, [m({})], ['x'], '2026-10-12')).toEqual([])
  })
  it('reports a missing seed id', () => {
    expect(validate(ok, [], ['x', 'pb-map-open-link'], '2026-10-12')).toContain('missing seed finding: pb-map-open-link')
  })
  it('reports duplicate ids', () => {
    expect(validate([f({}), f({})], [], [], '2026-10-12')).toContain('duplicate id: x')
  })
  it('requires a source url or path', () => {
    expect(validate([f({ source: { label: 'l', excerpt: 'e' } })], [], [], '2026-10-12')).toContain('x: source needs url or path')
  })
  it('requires a fixRef unless open, false positive or not a finding', () => {
    expect(validate([f({ fixRef: [] })], [], [], '2026-10-12')).toContain('x: fixed but no fixRef')
    expect(validate([f({ fixRef: [], status: 'not-a-finding' })], [], [], '2026-10-12')).toEqual([])
  })
  it('rejects dates outside the window and non-ISO dates', () => {
    expect(validate([f({ date: '2026-09-01' })], [], [], '2026-10-12')).toContain('x: date 2026-09-01 outside window')
    expect(validate([f({ date: '8 Oct' })], [], [], '2026-10-12')).toContain('x: date 8 Oct outside window')
  })
  it('rejects anything that looks like a secret value', () => {
    const leak = f({ source: { label: 'l', path: 'p', excerpt: 'COOLIFY_SETUP_TOKEN=4|abcdefghijklmnopqrstuvwxyz0123' } })
    expect(validate([leak], [], [], '2026-10-12')).toContain('x: possible secret in text')
    const ghp = f({ symptom: 'ghp_' + 'a'.repeat(36) })
    expect(validate([ghp], [], [], '2026-10-12')).toContain('x: possible secret in text')
  })
  it('rejects non-https links', () => {
    expect(validate([f({ fixRef: [{ label: 'l', url: 'file:///Users/x' }] })], [], [], '2026-10-12')).toContain('x: link not https: file:///Users/x')
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run .superpowers/retro-artifact`
Expected: FAIL, `Cannot find module './derive'` (or "Failed to resolve import").

- [ ] **Step 5: Implement `derive.ts`**

```ts
// .superpowers/retro-artifact/derive.ts
import { CAUGHT_BY, LAYERS, RETRO_GROUPS } from './types'
import type { CaughtBy, Finding, Layer, Milestone, RetroGroup } from './types'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const WINDOW_START = '2026-09-12'

export function formatDate(iso: string): string {
  const [, mm, dd] = iso.split('-')
  return `${Number(dd)} ${MONTHS[Number(mm) - 1]}`
}

export function stats(findings: Finding[], milestones: Milestone[]) {
  const past = milestones.filter((x) => !x.upcoming)
  const live = past.filter((x) => x.sitesLive !== undefined)
  return {
    sitesLive: live.length ? live[live.length - 1]!.sitesLive! : 0,
    releases: past.flatMap((x) => (x.release ? [x.release] : [])),
    toolPrs: past.reduce((n, x) => n + (x.toolPrs?.length ?? 0), 0),
    findings: findings.length,
    retroOpen: findings.filter((x) => x.status === 'retro-open').length,
  }
}

export function countBy<K extends string>(findings: Finding[], key: (f: Finding) => K): Map<K, number> {
  const out = new Map<K, number>()
  for (const f of findings) out.set(key(f), (out.get(key(f)) ?? 0) + 1)
  return out
}

export function findingsOn(findings: Finding[], date: string): number {
  return findings.filter((f) => f.date === date).length
}

export function caughtByLayer(findings: Finding[]) {
  return CAUGHT_BY.map((caughtBy: CaughtBy) => {
    const mine = findings.filter((f) => f.caughtBy === caughtBy)
    const byLayer = Object.fromEntries(LAYERS.map((l) => [l, mine.filter((f) => f.layer === l).length])) as Record<Layer, number>
    return { caughtBy, byLayer, total: mine.length }
  })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
}

export function retroGroups(findings: Finding[]): Record<RetroGroup, Finding[]> {
  return Object.fromEntries(RETRO_GROUPS.map((g) => [g, findings.filter((f) => f.retro?.group === g)])) as Record<RetroGroup, Finding[]>
}

const ISO = /^\d{4}-\d{2}-\d{2}$/
const SECRET = [/ghp_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{30,}/, /\b\d+\|[A-Za-z0-9]{24,}/, /sk-[A-Za-z0-9]{20,}/, /[A-Z_]*(TOKEN|SECRET|PASSWORD|KEY)\s*[=:]\s*\S{8,}/]

export function validate(findings: Finding[], milestones: Milestone[], requiredIds: string[], compiledOn: string): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const f of findings) {
    if (seen.has(f.id)) problems.push(`duplicate id: ${f.id}`)
    seen.add(f.id)
    if (!ISO.test(f.date) || f.date < WINDOW_START || f.date > compiledOn) problems.push(`${f.id}: date ${f.date} outside window`)
    if (!f.source.url && !f.source.path) problems.push(`${f.id}: source needs url or path`)
    if (!['retro-open', 'false-positive', 'not-a-finding'].includes(f.status) && f.fixRef.length === 0) problems.push(`${f.id}: fixed but no fixRef`)
    const links = [...f.fixRef.map((r) => r.url), f.source.url, f.retro?.doneBy?.url].filter((u): u is string => !!u)
    for (const u of links) if (!u.startsWith('https://')) problems.push(`${f.id}: link not https: ${u}`)
    const text = [f.symptom, f.cause, f.fix, f.source.excerpt, f.retro?.question ?? ''].join('\n')
    if (SECRET.some((r) => r.test(text))) problems.push(`${f.id}: possible secret in text`)
  }
  for (const id of requiredIds) if (!seen.has(id)) problems.push(`missing seed finding: ${id}`)
  for (const m of milestones) {
    if (!ISO.test(m.date)) problems.push(`milestone ${m.label}: bad date ${m.date}`)
    for (const r of m.refs) if (!r.url.startsWith('https://')) problems.push(`milestone ${m.label}: link not https: ${r.url}`)
  }
  return problems
}
```

- [ ] **Step 6: Run tests and type-check**

Run: `npx vitest run .superpowers/retro-artifact && npx tsc --noEmit -p .superpowers/retro-artifact`
Expected: all tests PASS; tsc prints nothing.

(No commit: the directory is gitignored. See Global Constraints.)

---

### Task 2: Compile the data

**Files:**
- Create: `.superpowers/retro-artifact/milestones.ts`
- Create: `.superpowers/retro-artifact/findings.ts`
- Create: `.superpowers/retro-artifact/seed.ts`
- Test: `.superpowers/retro-artifact/data.test.ts`

**Interfaces:**
- Consumes: `Finding`, `Milestone` from `types.ts`; `validate` from `derive.ts`.
- Produces: `export const COMPILED_ON: string`, `export const milestones: Milestone[]`,
  `export const findings: Finding[]`, `export const SEED_IDS: string[]`.

Sources (read all of them; prefer the first that has the fact):
1. `CHANGELOG.md` (this repo).
2. `gh pr view <n> --repo visionmediahq/astro-consent --json title,body,mergedAt,url` for n = 1…15.
3. Ledger: `.superpowers/sdd/2026-10-06-astro-consent-pilot-expansion-implementation/progress.md` (this repo, local).
4. Batch log: `~/sites/site-factory/.superpowers/sdd/2026-10-06-astro-consent-pilot-expansion/log.md` (local). Search "Finding", "retro", "STOP", "false positive".
5. Pilot plan: `~/sites/site-factory/docs/superpowers/plans/2026-10-04-astro-consent-live-pilot-7-sites.md` and the pilot log under `~/sites/site-factory/.superpowers/sdd/2026-10-04-astro-consent-live-pilot-7-sites/`.
6. `git -C ~/sites/site-factory log --all --since=2026-09-12 --format='%h %ad %s' --date=short` for milestone commits.

URL forms: `https://github.com/visionmediahq/astro-consent/pull/<n>`,
`https://github.com/visionmediahq/astro-consent/commit/<sha>`,
`https://github.com/visionmediahq/site-factory/commit/<sha>`,
`https://github.com/visionmediahq/<site-repo>/pull/<n>` (confirm the repo name with
`gh pr view <n> --repo visionmediahq/<site-repo> --json url` before using it). For a batch-log or
ledger source set `path` to `site-factory/.superpowers/sdd/2026-10-06-astro-consent-pilot-expansion/log.md`
or `astro-consent/.superpowers/sdd/2026-10-06-astro-consent-pilot-expansion-implementation/progress.md`.
Excerpts are at most 300 characters, quoted verbatim, with any token value cut.

- [ ] **Step 1: Write the seed list and the failing data test**

```ts
// .superpowers/retro-artifact/seed.ts
export const SEED_IDS = [
  // package
  'pb-map-open-link', 'button-contrast', 'map-button-label',
  // pilot
  'audit-missed-map', 'hand-wire-not-script', 'site-1277834673-cms-redeploy', 'rule-gaps-rulings', 'site-1243511314-footer-contrast',
  // rollout tool PRs #5–#15
  'engines-resync', 'crawl-file-endpoints', 'cdn-cgi-links', 'load-networkidle', 'covered-banner-button',
  'empty-dependency-map', 'sideways-scroll', 'root-field-resync', 'docker-site-url', 'daisyui-added', 'root-styles',
  // site branch fixes
  'site-1346130035-site-url-fallback', 'site-1249159919-banner-lift', 'site-1270076313-chrome-conditional',
  'site-1237723650-scoped-footer-contrast', 'site-1243331215-daisyui-scrollbar', 'site-1243331215-recaptcha', 'site-1243331215-policy-section',
  // infra / ops
  'coolify-no-history', 'disk-full-docker', 'docker-lease', 'preview-drop', 'main-moved',
  // detect
  'invented-map-site-1233003545', 'invented-map-site-1270982253',
]
```

```ts
// .superpowers/retro-artifact/data.test.ts
import { describe, expect, it } from 'vitest'
import { stats, validate } from './derive'
import { COMPILED_ON, findings } from './findings'
import { milestones } from './milestones'
import { SEED_IDS } from './seed'

describe('compiled data', () => {
  it('passes every pre-publish check', () => {
    expect(validate(findings, milestones, SEED_IDS, COMPILED_ON)).toEqual([])
  })
  it('matches the known totals', () => {
    const s = stats(findings, milestones)
    expect(s.sitesLive).toBe(27)
    expect(s.releases).toEqual(['v1.0.0', 'v1.0.1', 'v1.0.2'])
    expect(s.toolPrs).toBe(13)
  })
  it('has the upcoming observation days and retro', () => {
    expect(milestones.filter((m) => m.upcoming).map((m) => m.date)).toEqual(['2026-10-15', '2026-10-19', '2026-10-26', '2026-10-27'])
  })
  it('marks known-fixed retro items done', () => {
    const sb = findings.find((f) => f.id === 'site-1243331215-daisyui-scrollbar')!
    expect(sb.retro?.doneBy?.url).toBe('https://github.com/visionmediahq/astro-consent/pull/15')
  })
  it('classifies the non-findings', () => {
    expect(findings.find((f) => f.id === 'docker-lease')!.status).toBe('not-a-finding')
    expect(findings.find((f) => f.id === 'invented-map-site-1233003545')!.status).toBe('false-positive')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run .superpowers/retro-artifact/data.test.ts`
Expected: FAIL, cannot resolve `./findings`.

- [ ] **Step 3: Write `milestones.ts`**

Use exactly these rows (refs as full GitHub URLs; the retro row is dated the day after the last
observation as a placeholder date and labelled "Task 27 retro (after observation)"):

```ts
// .superpowers/retro-artifact/milestones.ts
import type { Milestone } from './types'
const sf = (sha: string) => ({ label: `site-factory ${sha}`, url: `https://github.com/visionmediahq/site-factory/commit/${sha}` })
const ac = (sha: string) => ({ label: `astro-consent ${sha}`, url: `https://github.com/visionmediahq/astro-consent/commit/${sha}` })

export const milestones: Milestone[] = [
  { date: '2026-09-24', label: 'ADR 0004 privacy and consent, draft', upcoming: false, refs: [sf('47a16e9'), sf('1f2a493')] },
  { date: '2026-10-01', label: 'Design spec, revs 1–3', upcoming: false, refs: [sf('0076e6c'), sf('a643857'), sf('75f4477')] },
  { date: '2026-10-02', label: 'Package plan, revs 1–4', upcoming: false, refs: [sf('d4a93f4'), sf('d43e664')] },
  { date: '2026-10-03', label: 'v1.0.0', upcoming: false, refs: [ac('3c5266c')], release: 'v1.0.0' },
  { date: '2026-10-05', label: '7 pilot sites live; v1.0.1', upcoming: false, refs: [sf('5f6fa84'), ac('fbca91a')], sitesLive: 7, release: 'v1.0.1' },
  { date: '2026-10-06', label: 'Expansion spec and plan: 20 sites + rollout tool', upcoming: false, refs: [sf('e7b48f3'), sf('4361955'), sf('a894bf4')] },
  { date: '2026-10-07', label: 'v1.0.2: contrast, map button', upcoming: false, refs: [ac('f26fc72')], release: 'v1.0.2' },
  { date: '2026-10-08', label: 'Rollout tool merged; expansion starts', upcoming: false, refs: [ac('b458afa')], toolPrs: [3, 4, 5, 6, 7, 8, 9] },
  { date: '2026-10-09', label: 'Tool fixes #10–#13', upcoming: false, refs: [ac('004653c')], toolPrs: [10, 11, 12, 13] },
  { date: '2026-10-12', label: '20 of 20 merged; 27 sites live', upcoming: false, refs: [ac('ca9b49d')], sitesLive: 27, toolPrs: [14, 15] },
  { date: '2026-10-15', label: 'Observation, day 3', upcoming: true, refs: [] },
  { date: '2026-10-19', label: 'Observation, day 7', upcoming: true, refs: [] },
  { date: '2026-10-26', label: 'Observation, day 14', upcoming: true, refs: [] },
  { date: '2026-10-27', label: 'Task 27 retro (after observation)', upcoming: true, refs: [] },
]
```

`toolPrs` counts #3–#15 = 13. #3 (the tool itself) and #4 (pre-run patch) are milestones, not
findings; #5–#15 are findings.

- [ ] **Step 4: Write `findings.ts`**

`export const COMPILED_ON = '<today, ISO>'` and `export const findings: Finding[] = [ … ]`, one
entry per finding in the sources, using each `SEED_IDS` id for the matching finding and adding
any further findings the sources contain (at least: `animation-during-shots` on
site 1239527892, `site-1271984151-template-href` on site 1240623269, `site-1237723650-visa-transient` on site 1237723650 as
`retro-open` with group `fleet-process`, `large-site-sampling` on site 1270076313). Classification rules:

| Situation | layer | status |
|---|---|---|
| Fixed in a package release | `package` | `fixed-package` |
| Fixed by an astro-consent rollout PR #5–#15 | `rollout-tool` | `fixed-tool` |
| Fixed only on that site's branch | `site` | `fixed-site-branch` |
| A gap in wire/detect, still open | `wire-detect` | `retro-open` |
| Coolify, Docker, disk, preview, main moving | `infra-ops` | per row; the lease error is `not-a-finding` |
| Detect flagged, Jörgen ruled fine | `wire-detect` | `false-positive` |

`retro` is set whenever the source says "for the retro"/"retro:"; group by what would change:
the package → `package-v1.1`, `ci/rollout` → `rollout-tool`, people/process/Coolify → `fleet-process`.
Set `doneBy` only on `site-1243331215-daisyui-scrollbar` (PR #15) unless a source shows another
retro item fixed. `caughtBy` follows the source wording ("verify round 1 FAIL step 3" →
`verify-step-3`; "found it in the 360 px screenshot" → `screenshot`; "subagent review" →
`subagent-review`; "live post-merge STOP" → `live-check`; "detect:" → `detect`; otherwise `by-hand`).

Example entry (copy this shape):

```ts
{
  id: 'cdn-cgi-links',
  date: '2026-10-08',
  site: 'site-1296282111',
  phase: 'expansion',
  layer: 'rollout-tool',
  symptom: "Live post-merge check stopped on /cdn-cgi/l/email-protection, which has no banner.",
  cause: "The crawl followed Cloudflare's email-obfuscation link as if it were a site page.",
  fix: 'extractLinks skips /cdn-cgi/ links.',
  fixRef: [{ label: 'astro-consent #7', url: 'https://github.com/visionmediahq/astro-consent/pull/7' }],
  caughtBy: 'live-check',
  status: 'fixed-tool',
  retro: null,
  source: {
    label: 'Batch log, site 1296282111',
    path: 'site-factory/.superpowers/sdd/2026-10-06-astro-consent-pilot-expansion/log.md',
    excerpt: "live post-merge STOP on /cdn-cgi/l/email-protection: Cloudflare's email obfuscation page has no banner, and the site's own 14 pages all passed. Fixed by astro-consent #7: extractLinks skips /cdn-cgi/.",
  },
},
```

- [ ] **Step 5: Run the data test until it passes**

Run: `npx vitest run .superpowers/retro-artifact && npx tsc --noEmit -p .superpowers/retro-artifact`
Expected: PASS. A failing `validate` prints the exact problems; fix the data, never the check.

- [ ] **Step 6: Spot-check five rows against their sources**

Pick five random ids (`npx tsx -e "import('./.superpowers/retro-artifact/findings.ts').then(m=>console.log(m.findings.sort(()=>Math.random()-.5).slice(0,5).map(f=>f.id)))"`)
and confirm each `fixRef` URL opens (`gh pr view` / `gh api repos/visionmediahq/<repo>/commits/<sha> -q .sha`)
and the excerpt appears verbatim in its source (`grep -F`).

---

### Task 3: Render the page

**Files:**
- Create: `.superpowers/retro-artifact/page.ts`
- Test: `.superpowers/retro-artifact/page.test.ts`

Load the `artifact-design` and `dataviz` skills before writing `page.ts`.

**Interfaces:**
- Consumes: `Finding`, `Milestone`, `LAYERS`, `STATUSES` from `types.ts`; `stats`, `caughtByLayer`,
  `retroGroups`, `findingsOn`, `formatDate`, `countBy` from `derive.ts`.
- Produces: `renderPage(input: { findings: Finding[]; milestones: Milestone[]; compiledOn: string }): string`
  and `escapeHtml(s: string): string`.

DOM the tests and Task 4 rely on:

```
<title>Rollout Retro</title>
header: h1, p[data-goal], [data-stat=sites|releases|toolprs|findings|retro] (text = the number)
section#timeline  li[data-milestone][data-date][data-upcoming=true|false] span[data-count]
section#log  [data-filter=layer|status][data-value] (button, aria-pressed)
             [data-row][data-id][data-layer][data-status]  (details > summary)
             p[data-empty][hidden]  "No findings match these filters"
section#retro  h3 per group, li[data-retro-id][data-done=true|false]
section#caught svg[role=img][aria-label] g[data-bar=<caughtBy>]  figcaption
footer: "Compiled <date>"
```

- [ ] **Step 1: Write the failing tests**

```ts
// .superpowers/retro-artifact/page.test.ts
import { parse } from 'node-html-parser'
import { describe, expect, it } from 'vitest'
import { renderPage } from './page'
import type { Finding, Milestone } from './types'

const f = (over: Partial<Finding>): Finding => ({
  id: 'a', date: '2026-10-05', site: 'site-1271984151', phase: 'pilot', layer: 'package',
  symptom: 'Opened <iframe src="x"> & "quotes" `ticks`', cause: 'c', fix: 'fx',
  fixRef: [{ label: 'v1.0.1', url: 'https://github.com/visionmediahq/astro-consent/commit/fbca91a' }],
  caughtBy: 'live-check', status: 'fixed-package', retro: null,
  source: { label: 'log', path: 'site-factory/x.md', excerpt: '<script>alert(1)</script>' },
  ...over,
})
const milestones: Milestone[] = [
  { date: '2026-10-05', label: 'Pilot live', upcoming: false, refs: [], sitesLive: 7, release: 'v1.0.1' },
  { date: '2026-10-15', label: 'Observation, day 3', upcoming: true, refs: [] },
]
const findings = [
  f({}),
  f({ id: 'b', layer: 'site', status: 'retro-open', fixRef: [], caughtBy: 'screenshot',
      retro: { group: 'package-v1.1', question: 'Offset variable?' } }),
  f({ id: 'c', layer: 'rollout-tool', status: 'fixed-tool', caughtBy: 'screenshot',
      retro: { group: 'rollout-tool', question: 'q', doneBy: { label: '#15', url: 'https://github.com/visionmediahq/astro-consent/pull/15' } } }),
]
const html = renderPage({ findings, milestones, compiledOn: '2026-10-12' })
const doc = parse(html)

describe('renderPage', () => {
  it('has a short title', () => {
    expect(doc.querySelector('title')!.text).toBe('Rollout Retro')
  })
  it('escapes markup in data', () => {
    expect(html).not.toContain('<iframe src="x">')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;iframe src=&quot;x&quot;&gt; &amp;')
  })
  it('derives the stat tiles', () => {
    expect(doc.querySelector('[data-stat=sites]')!.text.trim()).toBe('7')
    expect(doc.querySelector('[data-stat=findings]')!.text.trim()).toBe('3')
    expect(doc.querySelector('[data-stat=retro]')!.text.trim()).toBe('1')
  })
  it('renders milestones with counts and upcoming flags', () => {
    const lis = doc.querySelectorAll('[data-milestone]')
    expect(lis.map((l) => l.getAttribute('data-upcoming'))).toEqual(['false', 'true'])
    expect(lis[0]!.querySelector('[data-count]')!.text.trim()).toBe('3')
    expect(lis[0]!.text).toContain('5 Oct')
  })
  it('renders one row per finding with filter attributes', () => {
    const rows = doc.querySelectorAll('[data-row]')
    expect(rows.map((r) => r.getAttribute('data-layer'))).toEqual(['package', 'site', 'rollout-tool'])
  })
  it('renders a filter chip per layer and status with counts', () => {
    expect(doc.querySelectorAll('[data-filter=layer]').length).toBe(5)
    expect(doc.querySelectorAll('[data-filter=status]').length).toBe(6)
    expect(doc.querySelector('[data-filter=layer][data-value=site]')!.text).toContain('1')
  })
  it('has a hidden empty state', () => {
    const empty = doc.querySelector('[data-empty]')!
    expect(empty.hasAttribute('hidden')).toBe(true)
    expect(empty.text).toContain('No findings match these filters')
  })
  it('groups retro items and marks done ones', () => {
    expect(doc.querySelector('[data-retro-id=b]')!.getAttribute('data-done')).toBe('false')
    expect(doc.querySelector('[data-retro-id=c]')!.getAttribute('data-done')).toBe('true')
  })
  it('draws one bar per caughtBy, largest first, with an accessible label', () => {
    const bars = doc.querySelectorAll('#caught [data-bar]').map((b) => b.getAttribute('data-bar'))
    expect(bars).toEqual(['screenshot', 'live-check'])
    expect(doc.querySelector('#caught svg')!.getAttribute('aria-label')).toBeTruthy()
  })
  it('guards localStorage and defines dark mode', () => {
    expect(html).toMatch(/try\s*{[^}]*localStorage/)
    expect(html).toContain('prefers-color-scheme: dark')
    expect(html).toContain(':root[data-theme="dark"]')
  })
  it('loads no external scripts', () => {
    expect(doc.querySelectorAll('script[src]').length).toBe(0)
  })
  it('shows the compile date', () => {
    expect(doc.querySelector('footer')!.text).toContain('12 Oct 2026')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run .superpowers/retro-artifact/page.test.ts`
Expected: FAIL, cannot resolve `./page`.

- [ ] **Step 3: Implement `page.ts`**

Structure (fill the CSS per `artifact-design`; keep the functions as shown):

```ts
// .superpowers/retro-artifact/page.ts
import { caughtByLayer, countBy, findingsOn, formatDate, retroGroups, stats } from './derive'
import { LAYERS, RETRO_GROUPS, STATUSES } from './types'
import type { Finding, Layer, Milestone, Ref, Status } from './types'

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
const e = escapeHtml
const link = (r: Ref) => `<a href="${e(r.url)}">${e(r.label)}</a>`

const LAYER_LABEL: Record<Layer, string> = {
  package: 'Package', 'rollout-tool': 'Rollout tool', 'wire-detect': 'Wire / detect', site: 'Site', 'infra-ops': 'Infra / ops',
}
const STATUS_LABEL: Record<Status, string> = {
  'fixed-package': 'Fixed in package', 'fixed-tool': 'Fixed in tool', 'fixed-site-branch': 'Fixed on site branch',
  'retro-open': 'Open retro item', 'false-positive': 'False positive', 'not-a-finding': 'Not a finding',
}
const GROUP_LABEL = { 'package-v1.1': 'Package v1.1', 'rollout-tool': 'Rollout tool', 'fleet-process': 'Fleet process' } as const

const GOAL = 'Every Vision Media Astro site serves a fail-closed consent banner (@visionmediahq/astro-consent). This month built the package and rehearsed the rollout on 27 sites before the ~180-site fleet.'

function header(findings: Finding[], milestones: Milestone[]): string {
  const s = stats(findings, milestones)
  const tile = (key: string, value: string | number, label: string) =>
    `<div class="tile"><span class="num" data-stat="${key}">${e(String(value))}</span><span class="lbl">${e(label)}</span></div>`
  const next = milestones.filter((m) => m.upcoming).map((m) => `${formatDate(m.date)}: ${e(m.label)}`).join(' · ')
  return `<header><h1>astro-consent rollout retro</h1><p data-goal>${e(GOAL)}</p>
    <div class="tiles">${tile('sites', s.sitesLive, 'sites live')}${tile('releases', s.releases.length, s.releases.join(', '))}
    ${tile('toolprs', s.toolPrs, 'rollout tool PRs')}${tile('findings', s.findings, 'findings')}${tile('retro', s.retroOpen, 'open retro items')}</div>
    <p class="next">Next: ${next}</p></header>`
}

function timeline(findings: Finding[], milestones: Milestone[]): string {
  const items = milestones.map((m) => `<li data-milestone data-date="${m.date}" data-upcoming="${m.upcoming}">
    <time>${formatDate(m.date)}</time><span class="ml">${e(m.label)}</span>
    <span class="count" data-count>${findingsOn(findings, m.date)}</span>
    ${m.refs.length ? `<span class="refs">${m.refs.map(link).join(' ')}</span>` : ''}</li>`).join('')
  return `<section id="timeline"><h2>Timeline</h2>
    <p class="backlog">12 Sep – 23 Sep: N16 backlog (issue opened 8 May)</p><ol>${items}</ol></section>`
}

function row(f: Finding): string {
  const refs = f.fixRef.map(link).join(', ')
  const src = f.source.url ? link({ label: f.source.label, url: f.source.url }) : `${e(f.source.label)} <code>${e(f.source.path ?? '')}</code>`
  return `<details data-row data-id="${e(f.id)}" data-layer="${f.layer}" data-status="${f.status}">
    <summary><time>${formatDate(f.date)}</time><span class="site">${e(f.site ?? '—')}</span>
      <span class="chip">${LAYER_LABEL[f.layer]}</span><span class="sym">${e(f.symptom)}</span>
      <span class="chip st-${f.status}">${STATUS_LABEL[f.status]}</span></summary>
    <dl><dt>Cause</dt><dd>${e(f.cause)}</dd><dt>Fix</dt><dd>${e(f.fix || '—')} ${refs}</dd>
      <dt>Caught by</dt><dd>${e(f.caughtBy)}</dd>
      ${f.retro ? `<dt>Retro</dt><dd>${e(f.retro.question)}</dd>` : ''}
      <dt>Source</dt><dd>${src}<blockquote>${e(f.source.excerpt)}</blockquote></dd></dl></details>`
}

function log(findings: Finding[]): string {
  const sorted = [...findings].sort((a, b) => a.date.localeCompare(b.date))
  const byLayer = countBy(findings, (f) => f.layer)
  const byStatus = countBy(findings, (f) => f.status)
  const chip = (kind: string, value: string, label: string, n: number) =>
    `<button type="button" data-filter="${kind}" data-value="${value}" aria-pressed="false">${e(label)} <span>${n}</span></button>`
  return `<section id="log"><h2>Issues and fixes</h2>
    <div class="filters" role="group" aria-label="Layer">${LAYERS.map((l) => chip('layer', l, LAYER_LABEL[l], byLayer.get(l) ?? 0)).join('')}</div>
    <div class="filters" role="group" aria-label="Status">${STATUSES.map((s) => chip('status', s, STATUS_LABEL[s], byStatus.get(s) ?? 0)).join('')}</div>
    <div class="rows">${sorted.map(row).join('')}</div>
    <p data-empty hidden>No findings match these filters.</p></section>`
}

function retro(findings: Finding[]): string {
  const groups = retroGroups(findings)
  return `<section id="retro"><h2>Open retro items</h2>${RETRO_GROUPS.map((g) => `<h3>${GROUP_LABEL[g]}</h3><ul>${groups[g].map((f) => {
    const done = !!f.retro?.doneBy
    return `<li data-retro-id="${e(f.id)}" data-done="${done}">${done ? `<s>${e(f.retro!.question)}</s> ${link(f.retro!.doneBy!)}` : e(f.retro!.question)}
      <a href="#" data-goto="${e(f.id)}">log</a></li>`
  }).join('') || '<li>None</li>'}</ul>`).join('')}</section>`
}

function caught(findings: Finding[]): string {
  // Horizontal stacked bars in inline SVG; one <g data-bar> per caughtBy row, segments per layer
  // coloured by --layer-<name> tokens. Per dataviz: direct labels, totals at bar ends, no gridlines.
  const rows = caughtByLayer(findings)
  const max = Math.max(1, ...rows.map((r) => r.total))
  const rowH = 28, labelW = 130, barW = 400
  const bars = rows.map((r, i) => {
    let x = labelW
    const segs = LAYERS.filter((l) => r.byLayer[l] > 0).map((l) => {
      const w = (r.byLayer[l] / max) * barW
      const rect = `<rect x="${x}" y="${i * rowH + 6}" width="${w}" height="16" class="seg-${l}"><title>${LAYER_LABEL[l]}: ${r.byLayer[l]}</title></rect>`
      x += w
      return rect
    }).join('')
    return `<g data-bar="${r.caughtBy}"><text x="${labelW - 8}" y="${i * rowH + 19}" text-anchor="end">${e(r.caughtBy)}</text>${segs}<text x="${x + 6}" y="${i * rowH + 19}">${r.total}</text></g>`
  }).join('')
  const h = rows.length * rowH
  const legend = LAYERS.map((l) => `<span class="key seg-${l}">${LAYER_LABEL[l]}</span>`).join('')
  return `<section id="caught"><h2>How it was caught</h2><figure>
    <svg role="img" aria-label="Findings by how they were caught, stacked by layer" viewBox="0 0 ${labelW + barW + 40} ${h}" width="100%">${bars}</svg>
    <div class="legend">${legend}</div><figcaption>${e(CAUGHT_CAPTION)}</figcaption></figure></section>`
}

// Written after Task 2, from the compiled data (spec: the caption is not assumed in advance).
export let CAUGHT_CAPTION = ''

const FILTER_SCRIPT = `
(() => {
  const KEY = 'rollout-retro-filters'
  const chips = [...document.querySelectorAll('[data-filter]')]
  const rows = [...document.querySelectorAll('[data-row]')]
  const empty = document.querySelector('[data-empty]')
  let saved = []
  try { saved = JSON.parse(localStorage.getItem(KEY) || '[]') } catch { saved = [] }
  for (const c of chips) if (saved.includes(c.dataset.filter + ':' + c.dataset.value)) c.setAttribute('aria-pressed', 'true')
  function apply() {
    const on = (kind) => chips.filter((c) => c.dataset.filter === kind && c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.value)
    const layers = on('layer'), statuses = on('status')
    let shown = 0
    for (const r of rows) {
      const ok = (!layers.length || layers.includes(r.dataset.layer)) && (!statuses.length || statuses.includes(r.dataset.status))
      r.hidden = !ok
      if (ok) shown++
    }
    empty.hidden = shown > 0
    try { localStorage.setItem(KEY, JSON.stringify(chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.filter + ':' + c.dataset.value))) } catch {}
  }
  for (const c of chips) c.addEventListener('click', () => { c.setAttribute('aria-pressed', String(c.getAttribute('aria-pressed') !== 'true')); apply() })
  for (const a of document.querySelectorAll('[data-goto]')) a.addEventListener('click', (ev) => {
    ev.preventDefault()
    const r = document.querySelector('[data-row][data-id="' + a.dataset.goto + '"]')
    if (r) { r.hidden = false; r.open = true; r.scrollIntoView({ block: 'center' }) }
  })
  apply()
})()`

const CSS = `/* tokens on :root, dark under @media (prefers-color-scheme: dark) guarded by
   :root:not([data-theme="light"]) and again under :root[data-theme="dark"]; body background set;
   --layer-<name> tokens for the five layers, validated with the dataviz palette script;
   .seg-<layer> { fill: var(--layer-<layer>) } and .key.seg-<layer>::before swatches;
   summary as grid on desktop, stacked under 640px; overflow-wrap:anywhere on .sym, code, blockquote, a;
   #timeline ol horizontal (flex, scroll-free wrap) from 640px, vertical below;
   [data-upcoming=true] dashed; max-width 72rem; padding-inline 16px */`

export function renderPage({ findings, milestones, compiledOn }: { findings: Finding[]; milestones: Milestone[]; compiledOn: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rollout Retro</title><style>${CSS}</style></head><body>
${header(findings, milestones)}<main>${timeline(findings, milestones)}${log(findings)}${retro(findings)}${caught(findings)}</main>
<footer>Compiled ${formatDate(compiledOn)} ${compiledOn.slice(0, 4)}. Sources: CHANGELOG, astro-consent PRs, rollout ledger and batch log.</footer>
<script>${FILTER_SCRIPT}</script></body></html>`
}
```

Replace the `CSS` comment with the real stylesheet following those rules. Replace the
`CAUGHT_CAPTION` declaration with a `const` holding one sentence that states what the compiled
chart shows (e.g. which share verify caught and what only screenshots or review caught), written
from `caughtByLayer(findings)` output.

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run .superpowers/retro-artifact && npx tsc --noEmit -p .superpowers/retro-artifact`
Expected: all PASS, tsc silent.

---

### Task 4: Build, check in a browser, publish

**Files:**
- Create: `.superpowers/retro-artifact/build.ts`
- Create: `.superpowers/retro-artifact/check.ts`
- Output: `.superpowers/retro-artifact/out/rollout-retro.html`, `out/*.png`

**Interfaces:**
- Consumes: `renderPage` from `page.ts`; `validate` from `derive.ts`; `findings`, `COMPILED_ON`
  from `findings.ts`; `milestones` from `milestones.ts`; `SEED_IDS` from `seed.ts`.
- Produces: the published Artifact URL.

- [ ] **Step 1: Write `build.ts`**

```ts
// .superpowers/retro-artifact/build.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validate } from './derive'
import { COMPILED_ON, findings } from './findings'
import { milestones } from './milestones'
import { renderPage } from './page'
import { SEED_IDS } from './seed'

const problems = validate(findings, milestones, SEED_IDS, COMPILED_ON)
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
const out = join(dirname(fileURLToPath(import.meta.url)), 'out')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'rollout-retro.html'), renderPage({ findings, milestones, compiledOn: COMPILED_ON }))
console.log(`wrote ${join(out, 'rollout-retro.html')} (${findings.length} findings)`)
```

- [ ] **Step 2: Build**

Run: `npx tsx .superpowers/retro-artifact/build.ts`
Expected: `wrote …/out/rollout-retro.html (N findings)`, exit 0.

- [ ] **Step 3: Write `check.ts` (Playwright layout and behaviour check)**

```ts
// .superpowers/retro-artifact/check.ts
import { chromium } from '@playwright/test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), 'out')
const url = 'file://' + join(dir, 'rollout-retro.html')
const fail: string[] = []
const browser = await chromium.launch()

for (const width of [360, 1280]) {
  for (const scheme of ['light', 'dark'] as const) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme })
    await page.goto(url)
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    if (wide) fail.push(`${width}/${scheme}: horizontal scroll`)
    await page.screenshot({ path: join(dir, `${width}-${scheme}.png`), fullPage: true })
    await page.close()
  }
}

// Filters, empty state, and storage that throws.
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.addInitScript(() => {
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked') } })
})
await page.goto(url)
const total = await page.locator('[data-row]').count()
await page.click('[data-filter=status][data-value=not-a-finding]')
const nf = await page.locator('[data-row]:visible').count()
if (nf < 1 || nf >= total) fail.push(`status filter shows ${nf} of ${total}`)
await page.click('[data-filter=layer][data-value=package]')
if (await page.locator('[data-row]:visible').count() !== 0) fail.push('package + not-a-finding should match nothing')
if (!(await page.locator('[data-empty]').isVisible())) fail.push('empty state not shown')
await browser.close()

if (fail.length) { console.error(fail.join('\n')); process.exit(1) }
console.log('check OK; screenshots in', dir)
```

- [ ] **Step 4: Run the check**

Run: `npx tsx .superpowers/retro-artifact/check.ts`
Expected: `check OK`. Then read all four PNGs with the Read tool and confirm by eye: tiles
readable, dashed upcoming milestones, chart legible in dark mode, no clipped text at 360 px.
Fix `page.ts` and repeat Steps 2–4 until both pass.

- [ ] **Step 5: Final secret scan of the output**

Run: `grep -nE 'ghp_|github_pat_|[0-9]+\|[A-Za-z0-9]{24,}|(TOKEN|SECRET|PASSWORD|KEY)\s*[=:]\s*\S{8,}' .superpowers/retro-artifact/out/rollout-retro.html || echo clean`
Expected: `clean`.

- [ ] **Step 6: Publish**

Read `out/rollout-retro.html` in full (Artifact rule: never publish unread content), then call the
Artifact tool: `file_path` = `.superpowers/retro-artifact/out/rollout-retro.html`, `icon` =
`timeline`, `description` = "astro-consent rollout retro: goal, timeline, issues and fixes, open
retro items, 2026-09-12 to 2026-10-12." Report the URL to Jörgen. Do not share it further.

- [ ] **Step 7: Note the republish path**

Append one line to the ledger
(`.superpowers/sdd/2026-10-06-astro-consent-pilot-expansion-implementation/progress.md`):
`<date>: retro artifact published <URL>; source .superpowers/retro-artifact/, rebuild with build.ts + check.ts and republish to the same URL after each observation day.`
