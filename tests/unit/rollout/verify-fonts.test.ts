// verify on the fonts-selfhost flow, and step 8 (fonts) on both flows (site-factory#220). Every
// dependency is faked: no git, npm, Docker, browser or network.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { FontsPage } from '../../../ci/rollout/checks/fonts'
import type { RequestResult } from '../../../ci/rollout/checks/requests'
import type { Report } from '../../../ci/rollout/types'
import { type Checks, type Exec, fontsPaths, hasPackage, type VerifyDeps, verify } from '../../../ci/rollout/verify'
import type { FontFetch } from '../../../ci/rollout/wire/fonts'

const PKG = '@visionmediahq/astro-consent'
const DEMO_REPORT = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/demo-report.json'), 'utf8')) as Report
const report = (over: Partial<Report> = {}): Report => ({
  ...DEMO_REPORT,
  astro: { major: 7, output: 'static' },
  fonts: {
    status: 'wire',
    url: 'https://fonts.googleapis.com/css2?family=Figtree:wght@400;700&display=swap',
    urls: ['https://fonts.googleapis.com/css2?family=Figtree:wght@400;700&display=swap'],
    locations: [{ file: 'src/layouts/Base.astro', kind: 'link', start: 0, end: 10 }],
    csp: [{ file: 'public/_headers', kind: 'headers', start: 0, end: 10 }],
    reasons: [],
  },
  ...over,
})
const CSS2 = readFileSync(join(import.meta.dirname, 'fixtures/fonts-wire/css2/figtree.css.txt'), 'utf8')
const FONTS_CSS = `/*\n * Generated from https://fonts.googleapis.com/css2?family=Figtree:wght@400;700&display=swap\n * on 2026-10-19 by the astro-consent rollout tool: Google's own faces, served from /fonts/.\n */\n${CSS2.replace(/https:\/\/fonts\.gstatic\.com\/\S+?\.woff2/g, '/fonts/figtree.woff2')}`
const lock = (packages: Record<string, Record<string, unknown>>) => JSON.stringify({ lockfileVersion: 3, packages })
// The banner is live: main already has the package; the fonts commit leaves package.json and the lockfile alone.
const PKG_JSON = JSON.stringify({ name: 'site', dependencies: { [PKG]: 'github:visionmediahq/astro-consent#semver:^1.1.2', astro: '^7.3.5' } })
const LOCK = lock({ '': { name: 'site', dependencies: { [PKG]: 'github:visionmediahq/astro-consent#semver:^1.1.2', astro: '^7.3.5' } }, [`node_modules/${PKG}`]: { version: '1.1.3' } })
const SHA = 'a'.repeat(40)
const NPM_LS = JSON.stringify({ name: 'site', dependencies: { astro: { version: '7.3.5' } } })

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
beforeEach(() => void vi.stubEnv('ROLLOUT_MIN_FREE_GB', ''))
afterEach(() => void vi.unstubAllEnvs())

/** `<tmp>/site` with package files, and the files given (fonts.css by default). */
function siteDir(files: Record<string, string> = { 'src/styles/fonts.css': FONTS_CSS }): string {
  const root = mkdtempSync(join(tmpdir(), 'verify-fonts-'))
  dirs.push(root)
  const dir = join(root, 'site')
  for (const [p, text] of Object.entries({ 'package.json': PKG_JSON, 'package-lock.json': LOCK, ...files })) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), text)
  }
  return dir
}

const okPage = (path: string, width: number, over: Partial<FontsPage> = {}): FontsPage => ({
  path,
  width,
  google: [],
  woff2: [{ url: 'http://127.0.0.1:4399/fonts/figtree.woff2', status: 200 }],
  loaded: [{ family: 'Figtree', style: 'normal', weight: '400', status: 'loaded' }],
  used: [{ family: 'Figtree', weight: 400, style: 'normal' }],
  chars: { Figtree: 'Välkommen' },
  bodyFamily: 'Figtree',
  ...over,
})

interface Fake {
  deps: Partial<VerifyDeps>
  calls: string[]
  called: string[]
  requestOpts: { base: string; expectBanner?: (p: string) => boolean }[]
}

function fake(o: { branch?: string; mainPkg?: string; mainLock?: string; diff?: string; exec?: Record<string, { code: number; out: string }>; checks?: Partial<Checks>; fontFetch?: FontFetch } = {}): Fake {
  const branch = o.branch ?? 'fonts-selfhost'
  const calls: string[] = []
  const called: string[] = []
  const requestOpts: Fake['requestOpts'] = []
  const exec: Exec = async (cmd, args) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    for (const [prefix, answer] of Object.entries(o.exec ?? {})) if (line.startsWith(prefix)) return answer
    if (line.startsWith('git worktree add')) {
      const target = args[args.indexOf('--detach') + 1]!
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'package-lock.json'), o.mainLock ?? LOCK)
    }
    if (line === 'git rev-parse --abbrev-ref HEAD') return { code: 0, out: `${branch}\n` }
    if (line === 'git rev-parse HEAD') return { code: 0, out: `${SHA}\n` }
    if (line.startsWith('git ls-remote')) return { code: 0, out: `${SHA}\trefs/heads/${branch}\n` }
    if (line === 'git remote get-url origin') return { code: 0, out: 'git@github.com:visionmediahq/site.git\n' }
    if (line === 'git show origin/main:package.json') return { code: 0, out: o.mainPkg ?? PKG_JSON }
    if (line === 'git diff --name-only origin/main...HEAD') return { code: 0, out: o.diff ?? 'public/fonts/figtree.woff2\npublic/fonts/LICENSE-figtree.txt\nsrc/layouts/Base.astro\nsrc/styles/fonts.css\nsrc/styles/global.css\n' }
    if (line.startsWith('npm ls')) return { code: 0, out: NPM_LS }
    if (line === 'git worktree list --porcelain') return { code: 0, out: '' }
    return { code: 0, out: '' }
  }
  const ok = (path: string): RequestResult => ({ path, banner: true, banners: 1, blocked: [], errors: [], known: [], ok: true })
  const checks: Checks = {
    pages: async () => ['/', '/om', '/finns-inte-x'],
    embedPages: async () => [],
    requests: async (base, paths, opts) => {
      requestOpts.push({ base, ...(opts.expectBanner ? { expectBanner: opts.expectBanner } : {}) })
      return paths.map((p) => ({ ...ok(p), banner: opts.expectBanner ? opts.expectBanner(p) : !base.includes(':4398') }))
    },
    consentPaths: async () => (called.push('consentPaths'), []),
    clip: async (_b, paths) => (called.push('clip'), paths.map((path) => ({ path, width: 360, kind: 'button' as const, button: 'Neka', w: 80, boxW: 300, over: false, out: false, covered: false, cut: false, clipped: false }))),
    rootStyles: async () => ({}),
    embedBoxes: async () => [],
    contrast: async () => (called.push('contrast'), []),
    shots: async () => (called.push('shots'), ['/tmp/x.png']),
    fonts: async (base, paths, opts) => (called.push(`fonts ${base} ${(opts?.widths ?? [360, 1280]).join(',')}`), paths.flatMap((p) => (opts?.widths ?? [360, 1280]).map((w) => okPage(p, w)))),
    close: async () => undefined,
    ...o.checks,
  }
  const deps: Partial<VerifyDeps> = {
    exec,
    preview: async (_dir, port) => ({ url: `http://127.0.0.1:${port}`, stop: async () => undefined }),
    checks: async () => checks,
    freeBytes: () => 100e9,
    isUp: async () => false,
    docker: async (_url, b, run) => (called.push(`docker ${b}`), { pass: await run('http://127.0.0.1:4397'), log: 'docker ok' }),
    fontFetch: o.fontFetch ?? (async () => ({ status: 200, contentType: 'text/css', body: new TextEncoder().encode(CSS2) })),
  }
  return { deps, calls, called, requestOpts }
}

const steps = (r: Awaited<ReturnType<typeof verify>>) => r.steps.map((s) => [s.step, s.name, s.skipped ? 'skipped' : s.pass ? 'pass' : 'FAIL'])
const evidence = (dir: string, branch: string, file: string) => readFileSync(join(dir, `.rollout/evidence-${branch}`, file), 'utf8')

/** Google's answer with a cyrillic subset the site left out (Figtree has none; a stand-in). */
const withCyrillic: FontFetch = async () => ({
  status: 200,
  contentType: 'text/css',
  body: new TextEncoder().encode(`${CSS2}/* cyrillic */\n@font-face {\n  font-family: 'Figtree';\n  font-style: normal;\n  font-weight: 400;\n  src: url(https://fonts.gstatic.com/s/figtree/v9/cyr.woff2) format('woff2');\n  unicode-range: U+0400-045F;\n}\n`),
})

describe('verify on fonts-selfhost', () => {
  test('runs 1–3, 5, 7–9 and skips the banner-only 4 and 6; pushes fonts-selfhost; state files of its own', async () => {
    const dir = siteDir()
    // The banner's state from earlier must stay as it was.
    mkdirSync(join(dir, '.rollout'), { recursive: true })
    writeFileSync(join(dir, '.rollout/verify.json'), '{"banner":true}')
    const f = fake()
    const r = await verify(dir, report(), { deps: f.deps })
    expect(steps(r)).toEqual([
      [1, 'lockfile', 'pass'],
      [2, 'build', 'pass'],
      [3, 'requests', 'pass'],
      [4, 'consent-paths', 'skipped'],
      [5, 'clip', 'pass'],
      [6, 'contrast', 'skipped'],
      [7, 'screenshots', 'pass'],
      [8, 'fonts', 'pass'],
      [9, 'docker', 'pass'],
    ])
    expect(r.pass).toBe(true)
    expect(f.calls.filter((c) => c.startsWith('git push'))).toEqual(['git push --force-with-lease origin fonts-selfhost'])
    expect(f.calls).toContain('git ls-remote --heads origin refs/heads/fonts-selfhost')
    expect(f.called).not.toContain('consentPaths')
    expect(f.called).not.toContain('contrast')
    expect(f.called).toContain('docker fonts-selfhost')
    // Step 8 at 360 and 1280 on the branch, and its requests at 1280 against the container.
    expect(f.called).toContain('fonts http://127.0.0.1:4399 360,1280')
    expect(f.called).toContain('fonts http://127.0.0.1:4397 1280')
    expect(JSON.parse(readFileSync(join(dir, '.rollout/verify-fonts-selfhost.json'), 'utf8'))).toEqual(r)
    expect(readFileSync(join(dir, '.rollout/pushed-fonts-selfhost.txt'), 'utf8')).toBe(`${SHA}\n`)
    expect(readFileSync(join(dir, '.rollout/verify.json'), 'utf8')).toBe('{"banner":true}')
    expect(existsSync(join(dir, '.rollout/pushed.txt'))).toBe(false)
    expect(evidence(dir, 'fonts-selfhost', '4-consent-paths.txt')).toMatch(/banner-only check: not run on fonts-selfhost/)
    expect(evidence(dir, 'fonts-selfhost', '1-lockfile.txt')).toMatch(/package\.json, main → branch: same[\s\S]*package-lock\.json, main → branch: same[\s\S]*changed files \(5\): only the fonts/)
    expect(evidence(dir, 'fonts-selfhost', '8-fonts.txt')).toMatch(/src\/styles\/fonts\.css: \d+ faces, Figtree[\s\S]*dist\/: no Google Fonts host[\s\S]*\/ 360px: ok[\s\S]*every character shown is in a kept face/)
    expect(evidence(dir, 'fonts-selfhost', '9-docker.txt')).toMatch(/step 8 requests against the container \(1280 px\)/)
  })

  test('step 1: package.json or the lockfile changed, or a file the fonts plan does not touch: FAIL', async () => {
    for (const [o, why] of [
      [{ mainPkg: JSON.stringify({ name: 'site', dependencies: { [PKG]: 'x' } }) }, /package\.json, main → branch: CHANGED/],
      [{ mainLock: lock({ '': { name: 'site' } }) }, /package-lock\.json, main → branch: CHANGED/],
      [{ diff: 'src/styles/fonts.css\nsrc/pages/index.astro\n' }, /NOT ONLY THE FONTS[\s\S]*UNKNOWN src\/pages\/index\.astro/],
      [{ exec: { 'npm ls': { code: 1, out: 'x' } } }, /npm ls on main gave no JSON/],
    ] as const) {
      const dir = siteDir()
      const r = await verify(dir, report(), { deps: fake(o).deps })
      expect(steps(r)).toEqual([[1, 'lockfile', 'FAIL']])
      expect(evidence(dir, 'fonts-selfhost', '1-lockfile.txt')).toMatch(why)
    }
  })

  test('fontsPaths: fonts.css, public/fonts/**, the CSS entry and the files detect found the loads and CSPs in', () => {
    const allowed = fontsPaths(report())
    for (const p of ['src/styles/fonts.css', 'public/fonts/a.woff2', 'public/fonts/LICENSE-x.txt', 'src/styles/global.css', 'src/layouts/Base.astro', 'public/_headers']) expect(allowed(p), p).toBe(true)
    for (const p of ['package.json', 'src/pages/index.astro', 'public/fonts.txt']) expect(allowed(p), p).toBe(false)
  })

  test('main without the banner (fonts first): no banner expected anywhere, clip skipped', async () => {
    const f = fake({ mainPkg: JSON.stringify({ name: 'site' }) })
    const dir = siteDir({ 'src/styles/fonts.css': FONTS_CSS, 'package.json': JSON.stringify({ name: 'site' }) })
    const r = await verify(dir, report(), { deps: f.deps })
    expect(r.pass).toBe(true)
    expect(steps(r)[4]).toEqual([5, 'clip', 'skipped'])
    expect(f.requestOpts.filter((x) => x.base.includes(':4399')).every((x) => x.expectBanner?.('/') === false)).toBe(true)
    expect(hasPackage(PKG_JSON)).toBe(true)
    expect(hasPackage('{"devDependencies":{"@visionmediahq/astro-consent":"x"}}')).toBe(true)
    expect(hasPackage('not json')).toBe(false)
  })

  test("main without the banner: the registry requests main makes on a page are the site's own (noted); one main does not make fails", async () => {
    const MAPS = 'https://maps.google.com/maps?q=x&output=embed'
    const noBanner = JSON.stringify({ name: 'site' })
    const run = async (extra: string[]) => {
      const dir = siteDir({ 'src/styles/fonts.css': FONTS_CSS, 'package.json': noBanner })
      const requests: Checks['requests'] = async (base, paths) =>
        paths.map((p) => {
          const blocked = p === '/om' ? [MAPS, ...(base.includes(':4398') ? [] : extra)] : []
          return { path: p, banner: false, banners: 0, blocked, errors: [], known: [], ok: blocked.length === 0 }
        })
      const r = await verify(dir, report(), { deps: fake({ mainPkg: noBanner, checks: { requests } }).deps })
      return { r, text: evidence(dir, 'fonts-selfhost', '3-requests.txt') }
    }
    const same = await run([])
    expect(same.r.pass).toBe(true)
    expect(same.text).toContain('/om: 1 registry request(s) main makes too (no banner on main): noted, not the fonts commit\'s')
    expect(same.text).not.toMatch(/detect miss/)
    const more = await run(['https://www.googletagmanager.com/gtag/js?id=G-X'])
    expect(steps(more.r).at(-1)).toEqual([3, 'requests', 'FAIL'])
    expect(more.text).toMatch(/BLOCKED https:\/\/www\.googletagmanager\.com/)
  })

  test("step 8 without the tool's fonts.css (missing, or hand-written): FAIL", async () => {
    for (const files of [{}, { 'src/styles/fonts.css': '@font-face { font-family: X; src: url(/x.woff2) }' }] as Record<string, string>[]) {
      const dir = siteDir(files)
      const r = await verify(dir, report(), { deps: fake().deps })
      expect(steps(r).at(-1)).toEqual([8, 'fonts', 'FAIL'])
      expect(evidence(dir, 'fonts-selfhost', '8-fonts.txt')).toMatch(/missing or not this tool's/)
    }
  })

  test('step 8 fails on a Google request, a woff2 404, a face used but not loaded, a character outside the kept ranges, a Google host in dist/; docker never runs', async () => {
    const cases: [Partial<FontsPage> | null, Record<string, string>, RegExp][] = [
      [{ google: ['https://fonts.googleapis.com/css2?family=Figtree'] }, {}, /request\(s\) to Google Fonts/],
      [{ woff2: [{ url: 'http://127.0.0.1:4399/fonts/x.woff2', status: 404 }] }, {}, /woff2 not 200:\n {2}404/],
      [{ used: [{ family: 'Figtree', weight: 700, style: 'normal' }] }, {}, /Figtree 700 normal \(face normal 700-700 not loaded\)/],
      [{ chars: { Figtree: 'Hej Привет' } }, {}, /characters shown in Figtree outside its kept unicode-ranges[^\n]*U\+041F П/],
      [null, { 'dist/index.html': '<link href="https://fonts.googleapis.com/css2?family=Figtree" rel="stylesheet">' }, /dist\/ names Google Fonts:\n {2}index\.html/],
    ]
    for (const [over, files, why] of cases) {
      const dir = siteDir({ 'src/styles/fonts.css': FONTS_CSS, ...files })
      const f = fake({ fontFetch: withCyrillic, checks: { fonts: async (_b, paths) => paths.flatMap((p) => [360, 1280].map((w) => okPage(p, w, over ?? {}))) } })
      const r = await verify(dir, report(), { deps: f.deps })
      expect(steps(r).at(-1), String(why)).toEqual([8, 'fonts', 'FAIL'])
      expect(evidence(dir, 'fonts-selfhost', '8-fonts.txt')).toMatch(why)
      expect(f.called.some((c) => c.startsWith('docker'))).toBe(false)
    }
  })

  test("step 8 coverage: Google's answer unreachable means every uncovered character counts, and it says so", async () => {
    const dir = siteDir()
    const f = fake({ fontFetch: async () => ({ status: 503, contentType: 'text/html', body: new Uint8Array() }), checks: { fonts: async (_b, paths) => paths.map((p) => okPage(p, 1280, { chars: { Figtree: '☎' } })) } })
    const r = await verify(dir, report(), { deps: f.deps })
    expect(steps(r).at(-1)).toEqual([8, 'fonts', 'FAIL'])
    expect(evidence(dir, 'fonts-selfhost', '8-fonts.txt')).toMatch(/Google's faces unknown \(https:\/\/fonts\.googleapis\.com\/css2\S+ answered 503\)/)
    // With Google's answer, ☎ (no Figtree face has it) is a note.
    const ok = siteDir()
    const g = fake({ checks: { fonts: async (_b, paths) => paths.map((p) => okPage(p, 1280, { chars: { Figtree: '☎' } })) } })
    expect((await verify(ok, report(), { deps: g.deps })).pass).toBe(true)
    expect(evidence(ok, 'fonts-selfhost', '8-fonts.txt')).toMatch(/U\+260E ☎ not in any face Google has/)
  })

  test('the fonts-selfhost branch on origin pushed by someone else is never force-pushed over', async () => {
    const f = fake({ exec: { 'git ls-remote --heads origin refs/heads/fonts-selfhost': { code: 0, out: `${'b'.repeat(40)}\trefs/heads/fonts-selfhost\n` } } })
    const r = await verify(siteDir(), report(), { deps: f.deps })
    expect(r.steps).toEqual([expect.objectContaining({ step: 0, name: 'push', pass: false })])
    expect(f.calls.some((c) => c.startsWith('git push'))).toBe(false)
  })
})

describe('step 8 on consent-banner', () => {
  test("runs when the branch has the tool's fonts.css (wire's second commit), with every banner step", async () => {
    const dir = siteDir()
    // Main before the banner: the branch adds the package (step 1's allowlist) and the fonts.
    const astro = { astro: '^7.3.5' }
    const rows = (paths: string[]) =>
      paths.flatMap((path) => (['banner', 'links'] as const).map((kind) => ({ path, kind, button: 'Neka', ratio: 7, ok: true, fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } })))
    const f = fake({
      branch: 'consent-banner',
      mainPkg: JSON.stringify({ name: 'site', dependencies: astro }),
      mainLock: lock({ '': { name: 'site', dependencies: astro } }),
      checks: { contrast: async (_b, paths) => rows(paths) },
    })
    const r = await verify(dir, report({ classification: 'notice', iframes: [], widgets: [] }), { deps: f.deps })
    expect(steps(r).map((s) => s[1])).toEqual(['lockfile', 'build', 'requests', 'consent-paths', 'clip', 'contrast', 'screenshots', 'fonts', 'docker'])
    expect(steps(r).filter((s) => s[2] === 'skipped')).toEqual([])
    expect(f.called).toContain('fonts http://127.0.0.1:4399 360,1280')
    expect(existsSync(join(dir, '.rollout/verify.json'))).toBe(true)
  })

  test('consent-banner: pushed.txt (the name it always had) names our last push: a rerun may replace it', async () => {
    const dir = siteDir({})
    mkdirSync(join(dir, '.rollout'), { recursive: true })
    const ours = 'b'.repeat(40)
    writeFileSync(join(dir, '.rollout/pushed.txt'), `${ours}\n`)
    const f = fake({ branch: 'consent-banner', exec: { 'git ls-remote --heads origin refs/heads/consent-banner': { code: 0, out: `${ours}\trefs/heads/consent-banner\n` } } })
    const r = await verify(dir, report(), { deps: f.deps })
    expect(f.calls).toContain('git push --force-with-lease origin consent-banner')
    expect(r.steps[0]).toMatchObject({ step: 1 })
    expect(readFileSync(join(dir, '.rollout/pushed.txt'), 'utf8')).toBe(`${SHA}\n`)
  })

  test('any other branch is refused before anything runs', async () => {
    const f = fake({ branch: 'main' })
    await expect(verify(siteDir(), report(), { deps: f.deps })).rejects.toThrow('verify runs on branch consent-banner or fonts-selfhost')
    expect(f.calls.some((c) => c.startsWith('git push') || c.startsWith('npm'))).toBe(false)
  })
})

// ── review of #76 ────────────────────────────────────────────────────────────────────────────

const MAPS = 'https://maps.google.com/maps?q=x&output=embed'
/** Requests answered per side: `main` and `branch` map a path to the registry URLs it requests. */
const sides =
  (main: Record<string, string[]>, branch: Record<string, string[]>, banner: boolean): Checks['requests'] =>
  async (base, paths) =>
    paths.map((p) => {
      const blocked = (base.includes(':4398') ? main : branch)[p] ?? []
      const shows = banner && !base.includes(':4398')
      return { path: p, banner: shows, banners: shows ? 1 : 0, blocked, errors: [], known: [], ok: blocked.length === 0 && shows === banner }
    })

describe('review of #76: the banner property and fail-closed edges', () => {
  test('M2: on consent-banner, a registry URL requested before consent fails step 3 even when main requests the same URL on the same page', async () => {
    const dir = siteDir({})
    const f = fake({ branch: 'consent-banner', checks: { requests: sides({ '/om': [MAPS] }, { '/om': [MAPS] }, true) } })
    const r = await verify(dir, report(), { deps: f.deps })
    expect(steps(r).at(-1)).toEqual([3, 'requests', 'FAIL'])
    const text = readFileSync(join(dir, '.rollout/evidence/3-requests.txt'), 'utf8')
    expect(text).toMatch(/\/om: banner=true blocked=1 errors=0 \(baseline 0\) FAIL\n {4}BLOCKED https:\/\/maps\.google\.com/)
    expect(text).not.toMatch(/main makes too/)
  })

  test('M2: on fonts-selfhost with the banner on main, the same holds: main requesting it too excuses nothing', async () => {
    const dir = siteDir()
    const r = await verify(dir, report(), { deps: fake({ checks: { requests: sides({ '/om': [MAPS] }, { '/om': [MAPS] }, true) } }).deps })
    expect(steps(r).at(-1)).toEqual([3, 'requests', 'FAIL'])
  })

  test('M25: without the banner on main, a registry URL main requests only on another page is not excused', async () => {
    const noBanner = JSON.stringify({ name: 'site' })
    const dir = siteDir({ 'src/styles/fonts.css': FONTS_CSS, 'package.json': noBanner })
    const r = await verify(dir, report(), { deps: fake({ mainPkg: noBanner, checks: { requests: sides({ '/': [MAPS] }, { '/om': [MAPS] }, false) } }).deps })
    expect(steps(r).at(-1)).toEqual([3, 'requests', 'FAIL'])
    expect(evidence(dir, 'fonts-selfhost', '3-requests.txt')).toMatch(/\/om: banner=false blocked=1 .*FAIL/)
  })

  test("main's package.json unreadable on fonts-selfhost: a STOP before any step, not \"no banner\"", async () => {
    const dir = siteDir()
    const f = fake({ exec: { 'git show origin/main:package.json': { code: 128, out: "fatal: invalid object name 'origin/main'" } } })
    const r = await verify(dir, report(), { deps: f.deps })
    expect(r.pass).toBe(false)
    expect(r.steps).toEqual([expect.objectContaining({ step: 0, name: 'main', pass: false })])
    expect(r.steps[0]!.evidence).toMatch(/git show origin\/main:package\.json failed[\s\S]*invalid object name/)
    expect(f.calls.some((c) => c.startsWith('npm'))).toBe(false)
  })

  test('coverage: a character outside the kept ranges in the shipped JS/JSON is a note (a library string may never show); in the DOM, hidden or not, it fails', async () => {
    const js = { 'src/styles/fonts.css': FONTS_CSS, 'dist/_astro/lib.js': 'const re=/[Ѐ-ӿ]/,msg="Привет"', 'dist/data.json': '{"t":"Привет"}' }
    const ok = siteDir(js)
    const r = await verify(ok, report(), { deps: fake({ fontFetch: withCyrillic }).deps })
    expect(r.pass).toBe(true)
    expect(evidence(ok, 'fonts-selfhost', '8-fonts.txt')).toMatch(/note: characters in the shipped JS\/JSON outside Figtree's kept unicode-ranges[^\n]*U\+041F П[^\n]*_astro\/lib\.js/)
    const dom = siteDir()
    const hidden = fake({ fontFetch: withCyrillic, checks: { fonts: async (_b, paths) => paths.map((p) => okPage(p, 1280, { chars: { Figtree: 'Hej Привет' }, used: [] })) } })
    expect(steps(await verify(dom, report(), { deps: hidden.deps })).at(-1)).toEqual([8, 'fonts', 'FAIL'])
  })
})

describe('step 8 skips CMS admin shells (lj-trim)', () => {
  // public/admin/index.html loads Sveltia CMS from unpkg, which asks Google Fonts for the editor UI.
  const ADMIN = '<!doctype html><html><head><script src="https://unpkg.com/@sveltia/cms@0.165.2/dist/sveltia-cms.js"></script></head><body></body></html>'
  const googleOn =
    (bad: string): Checks['fonts'] =>
    async (_b, paths, opts) =>
      paths.flatMap((p) => (opts?.widths ?? [360, 1280]).map((w) => okPage(p, w, p === bad ? { google: ['https://fonts.googleapis.com/css2?family=Merriweather+Sans'] } : {})))

  test('Google requests only on /admin/: step 8 passes on the branch and against the container, /admin/ shown as skipped', async () => {
    const dir = siteDir({ 'src/styles/fonts.css': FONTS_CSS, 'dist/admin/index.html': ADMIN })
    const asked: string[][] = []
    const fonts: Checks['fonts'] = async (b, paths, opts) => (asked.push(paths), googleOn('/admin/')(b, paths, opts))
    const f = fake({ checks: { pages: async () => ['/', '/admin/', '/finns-inte-x'], fonts } })
    const r = await verify(dir, report(), { deps: f.deps })
    expect(steps(r).slice(-2)).toEqual([
      [8, 'fonts', 'pass'],
      [9, 'docker', 'pass'],
    ])
    expect(asked).toEqual([
      ['/', '/finns-inte-x'],
      ['/', '/finns-inte-x'],
    ])
    const text = evidence(dir, 'fonts-selfhost', '8-fonts.txt')
    expect(text).toContain('/admin/: skipped (CMS admin shell, third-party editor fonts)')
    expect(text).toContain('dist/: no Google Fonts host outside comments')
    expect(evidence(dir, 'fonts-selfhost', '9-docker.txt')).toContain('  /admin/: skipped (CMS admin shell, third-party editor fonts)')
  })

  test('control: a Google request on / still fails step 8', async () => {
    const dir = siteDir()
    const f = fake({ checks: { pages: async () => ['/', '/admin/', '/finns-inte-x'], fonts: googleOn('/') } })
    const r = await verify(dir, report(), { deps: f.deps })
    expect(steps(r).at(-1)).toEqual([8, 'fonts', 'FAIL'])
    expect(evidence(dir, 'fonts-selfhost', '8-fonts.txt')).toMatch(/request\(s\) to Google Fonts/)
  })
})
