// verify step 2's static check of Sentry's self-hosted bundle (#93). verify builds without
// PUBLIC_GLITCHTIP_DSN, so the GlitchTip block never renders locally: the source is read instead.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { checkSentrySource } from '../../../ci/rollout/checks/sentry'
import { SENTRY_FILE, SENTRY_SRC, SENTRY_SRI } from '../../../ci/rollout/lib/sentry'
import { globToRegExp, type SiteFiles } from '../../../ci/rollout/lib/site-files'
import type { Report } from '../../../ci/rollout/types'
import { type Checks, type Exec, type VerifyDeps, verify } from '../../../ci/rollout/verify'
import { sri384 } from '../../../ci/rollout/wire/sentry'

function memSite(files: Record<string, string>): SiteFiles {
  return {
    root: '/mem',
    list: (glob) => Object.keys(files).filter((p) => globToRegExp(glob).test(p)).sort(),
    read: (path) => files[path] ?? '',
    exists: (path) => path in files,
  }
}
const BUNDLE = new TextEncoder().encode('/*! @sentry/browser 8.55.2 (test) */\nvar Sentry={};\n')
const layout = (src: string) => `<html><head><script is:inline src="${src}"></script></head><body /></html>\n`
const CDN = 'https://cdn.jsdelivr.net/npm/@sentry/browser@8/build/bundle.min.js'

describe('checkSentrySource', () => {
  test('the bundle committed, hashing to the SRI, loaded from /js/, no CDN left: pass', () => {
    const r = checkSentrySource(memSite({ 'src/layouts/Base.astro': layout(SENTRY_SRC) }), BUNDLE, sri384(BUNDLE))
    expect(r.pass).toBe(true)
    expect(r.lines).toEqual([`sentry bundle: ${SENTRY_FILE}, ${BUNDLE.length} bytes, ${sri384(BUNDLE)} ok`, `sentry bundle: loaded from ${SENTRY_SRC}, no CDN load left`])
  })

  test('a bundle that does not hash to the recorded SRI fails', () => {
    const r = checkSentrySource(memSite({ 'src/layouts/Base.astro': layout(SENTRY_SRC) }), BUNDLE)
    expect(r.pass).toBe(false)
    expect(r.lines[0]).toBe(`sentry bundle: ${SENTRY_FILE}, ${BUNDLE.length} bytes, ${sri384(BUNDLE)}, NOT the recorded ${SENTRY_SRI}`)
  })

  test('the bundle committed but a layout still on a CDN, or nothing loading it: fail', () => {
    const both = checkSentrySource(memSite({ 'src/layouts/Base.astro': layout(SENTRY_SRC), 'src/layouts/Landing.astro': layout(CDN) }), BUNDLE, sri384(BUNDLE))
    expect(both.pass).toBe(false)
    expect(both.lines).toContain('sentry bundle: a CDN load is still there:')
    expect(both.lines).toContain(`  src/layouts/Landing.astro:1 ${CDN}`)
    const unused = checkSentrySource(memSite({ 'src/layouts/Base.astro': '<html />\n' }), BUNDLE, sri384(BUNDLE))
    expect(unused.pass).toBe(false)
    expect(unused.lines).toContain(`sentry bundle: no <script> loads ${SENTRY_SRC}`)
  })

  test('with the bundle, any other reference to a Sentry CDN host fails, bare origin included; comments and CSPs do not (review of #126)', () => {
    const ok = (files: Record<string, string>) => checkSentrySource(memSite({ 'src/layouts/Base.astro': layout(SENTRY_SRC), ...files }), BUNDLE, sri384(BUNDLE))
    const hint = ok({ 'src/layouts/Base.astro': `<html><head><link rel="preconnect" href="https://browser.sentry-cdn.com" /><script is:inline src="${SENTRY_SRC}"></script></head></html>\n` })
    expect(hint.pass).toBe(false)
    const constant = ok({ 'src/lib/errors.ts': "export const SDK = 'https://browser.sentry-cdn.com'\n" })
    expect(constant.pass).toBe(false)
    expect(constant.lines).toContain("  src/lib/errors.ts:1 still names browser.sentry-cdn.com: export const SDK = 'https://browser.sentry-cdn.com'")
    expect(ok({ 'public/_headers': "/*\n  Content-Security-Policy: script-src 'self' https://browser.sentry-cdn.com\n" }).pass).toBe(true)
    expect(ok({ 'src/lib/errors.ts': '// was https://browser.sentry-cdn.com\nexport const a = 1\n' }).pass).toBe(true)
    expect(ok({ 'src/pages/index.astro': '<!-- copied from browser.sentry-cdn.com -->\n<p>x</p>\n' }).pass).toBe(true)
  })

  test('no bundle on the branch: a CDN load is noted (wire --no-sentry), not failed', () => {
    const r = checkSentrySource(memSite({ 'src/layouts/Base.astro': layout(CDN) }), null)
    expect(r.pass).toBe(true)
    expect(r.lines[0]).toMatch(/^sentry bundle: not self-hosted on this branch/)
    expect(checkSentrySource(memSite({ 'src/layouts/Base.astro': '<html />\n' }), null)).toEqual({ pass: true, lines: ['sentry bundle: none, nothing to check'] })
  })
})

// ── verify itself, every dependency faked (no git, npm, browser or network) ────────────────

const PKG = '@visionmediahq/astro-consent'
const DEMO_REPORT = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/demo-report.json'), 'utf8')) as Report
const PKG_JSON = JSON.stringify({ name: 'site', dependencies: { astro: '^7.3.5' } })
const BRANCH_PKG = JSON.stringify({ name: 'site', dependencies: { [PKG]: 'github:visionmediahq/astro-consent#semver:^1.1.2', astro: '^7.3.5' } })
const LOCK = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'site', dependencies: { astro: '^7.3.5' } } } })
const BRANCH_LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: { '': { name: 'site', dependencies: { [PKG]: 'github:visionmediahq/astro-consent#semver:^1.1.2', astro: '^7.3.5' } }, [`node_modules/${PKG}`]: { version: '1.1.5' } },
})
const SHA = 'a'.repeat(40)
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
beforeEach(() => {
  vi.stubEnv('ROLLOUT_MIN_FREE_GB', '')
  vi.stubEnv('ROLLOUT_PORT_BASE', '')
})
afterEach(() => void vi.unstubAllEnvs())

function siteDir(files: Record<string, string | Uint8Array>): string {
  const root = mkdtempSync(join(tmpdir(), 'verify-sentry-'))
  dirs.push(root)
  const dir = join(root, 'site')
  for (const [p, data] of Object.entries({ 'package.json': BRANCH_PKG, 'package-lock.json': BRANCH_LOCK, ...files })) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), data)
  }
  return dir
}

interface Opts {
  tracked?: boolean
  /** sentry-selfhost: main already has the banner (the branch's package files), and these files changed. */
  sentryFlow?: { diff: string }
}
function deps(o: Opts = {}): Partial<VerifyDeps> {
  const branch = o.sentryFlow ? 'sentry-selfhost' : 'consent-banner'
  const exec: Exec = async (cmd, args) => {
    const line = [cmd, ...args].join(' ')
    if (line.startsWith('git worktree add')) {
      const target = args[args.indexOf('--detach') + 1]!
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'package-lock.json'), o.sentryFlow ? BRANCH_LOCK : LOCK)
    }
    if (line === 'git rev-parse --abbrev-ref HEAD') return { code: 0, out: `${branch}\n` }
    if (line === 'git rev-parse HEAD') return { code: 0, out: `${SHA}\n` }
    if (line.startsWith('git ls-remote')) return { code: 0, out: `${SHA}\trefs/heads/${branch}\n` }
    if (line === 'git show origin/main:package.json') return { code: 0, out: o.sentryFlow ? BRANCH_PKG : PKG_JSON }
    if (line === 'git diff --name-only origin/main...HEAD') return { code: 0, out: o.sentryFlow?.diff ?? '' }
    if (line.startsWith('git ls-files --error-unmatch')) return { code: o.tracked === false ? 1 : 0, out: '' }
    if (line.startsWith('npm ls')) return { code: 0, out: JSON.stringify({ name: 'site', dependencies: { astro: { version: '7.3.5' } } }) }
    return { code: 0, out: '' }
  }
  const checks = { daisyuiParts: () => [], close: async () => undefined } as unknown as Checks
  const lockDir = mkdtempSync(join(tmpdir(), 'verify-sentry-lock-'))
  dirs.push(lockDir)
  return {
    exec,
    preview: async (_dir, port) => ({ url: `http://127.0.0.1:${port}`, stop: async () => undefined }),
    // Step 3 needs a browser; failing there ends the run right after step 2.
    checks: async () => ({ ...checks, pages: async () => [] }) as unknown as Checks,
    freeBytes: () => 100e9,
    isUp: async () => false,
    lockDir,
    toolVersion: () => ({ sha: SHA, dirty: false }),
  }
}
const run = (dir: string, o: Opts = {}) => verify(dir, { ...DEMO_REPORT, astro: { major: 7, output: 'static' }, sentry: SENTRY_REPORT }, { deps: deps(o) })
const step2 = async (dir: string, o: Opts = {}) => (await run(dir, o)).steps.find((s) => s.step === 2)!
const SENTRY_REPORT: Report['sentry'] = {
  status: 'wire',
  loaders: [{ file: 'src/layouts/Base.astro', line: 1, cdn: 'jsdelivr', version: '8', url: CDN, kind: 'element', src: { start: 0, end: 1 }, cuts: [] }],
  selfHosted: [],
  reasons: [],
}

describe('verify step 2 (build) with the Sentry check', () => {
  test("the tool's bundle committed but not the recorded bytes: step 2 fails and says so", async () => {
    const dir = siteDir({ 'src/layouts/Base.astro': layout(SENTRY_SRC), [SENTRY_FILE]: BUNDLE })
    const s = await step2(dir)
    expect(s.pass).toBe(false)
    expect(s.evidence).toContain(`NOT the recorded ${SENTRY_SRI}`)
  })

  test('the bundle on disk but not committed counts as absent: a CDN load left is only noted', async () => {
    const dir = siteDir({ 'src/layouts/Base.astro': layout(CDN), [SENTRY_FILE]: BUNDLE })
    const s = await step2(dir, { tracked: false })
    expect(s.pass).toBe(true)
    expect(s.evidence).toMatch(/sentry bundle: not self-hosted on this branch/)
  })
})

describe('verify on sentry-selfhost', () => {
  const FILES = `${SENTRY_FILE}\nsrc/layouts/Base.astro\n`

  test('step 1: package files as main\'s and only the bundle and the layout changed', async () => {
    const dir = () => siteDir({ 'src/layouts/Base.astro': layout(SENTRY_SRC), [SENTRY_FILE]: BUNDLE })
    const s1 = (await run(dir(), { sentryFlow: { diff: FILES } })).steps.find((s) => s.step === 1)!
    expect(s1.pass).toBe(true)
    expect(s1.evidence).toContain('changed files (2): only the Sentry bundle')
    const extra = (await run(dir(), { sentryFlow: { diff: `${FILES}src/pages/index.astro\n` } })).steps.find((s) => s.step === 1)!
    expect(extra.pass).toBe(false)
    expect(extra.evidence).toContain('NOT ONLY THE SENTRY BUNDLE')
    expect(extra.evidence).toContain('  UNKNOWN src/pages/index.astro')
  })

  test('step 2: the bundle must be committed; the daisyUI parts are not asked', async () => {
    const dir = siteDir({ 'src/layouts/Base.astro': layout(CDN) })
    const s = await step2(dir, { sentryFlow: { diff: FILES }, tracked: false })
    expect(s.pass).toBe(false)
    expect(s.evidence).toContain(`${SENTRY_FILE} is not committed on sentry-selfhost: run.ts sentry writes it`)
    expect(s.evidence).not.toContain('daisyUI')
  })
})
