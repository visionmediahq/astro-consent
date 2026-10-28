// verify on the astro-consent-update flow. Every dependency is faked: no git, npm, Docker, browser or network.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { RequestResult } from '../../../ci/rollout/checks/requests'
import type { Report } from '../../../ci/rollout/types'
import { type Checks, type Exec, type VerifyDeps, verify } from '../../../ci/rollout/verify'

const PKG = '@visionmediahq/astro-consent'
const DEMO_REPORT = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/demo-report.json'), 'utf8')) as Report
const report = (): Report => {
  const { fonts: _none, ...rest } = DEMO_REPORT
  return { ...rest, astro: { major: 6, output: 'static' } }
}
const spec = (range: string) => `github:visionmediahq/astro-consent#semver:${range}`
const pkgJson = (range: string, more: Record<string, unknown> = {}) => JSON.stringify({ name: 'site', dependencies: { [PKG]: spec(range), astro: '^6.1.6' }, ...more })
const lockJson = (range: string, version: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { name: 'site', dependencies: { [PKG]: spec(range), astro: '^6.1.6' } }, [`node_modules/${PKG}`]: { version, resolved: `git+ssh://git@github.com/visionmediahq/astro-consent.git#${version.replaceAll('.', '').padEnd(40, 'a')}` }, ...extra },
  })
const SHA = 'a'.repeat(40)
const BRANCH = 'astro-consent-update'
const NPM_LS = JSON.stringify({ name: 'site', dependencies: { astro: { version: '6.1.6' } } })

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
beforeEach(() => {
  vi.stubEnv('ROLLOUT_MIN_FREE_GB', '')
  vi.stubEnv('ROLLOUT_PORT_BASE', '')
})
afterEach(() => void vi.unstubAllEnvs())

/** `<tmp>/site` on the branch: the package at 1.1.4. */
function siteDir(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'verify-update-'))
  dirs.push(root)
  const dir = join(root, 'site')
  for (const [p, text] of Object.entries({ 'package.json': pkgJson('^1.1.4'), 'package-lock.json': lockJson('^1.1.4', '1.1.4'), ...files })) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), text)
  }
  return dir
}

function fake(o: { mainPkg?: string; mainLock?: string; diff?: string } = {}) {
  const calls: string[] = []
  const called: string[] = []
  const exec: Exec = async (cmd, args) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    if (line.startsWith('git worktree add')) {
      const target = args[args.indexOf('--detach') + 1]!
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'package-lock.json'), o.mainLock ?? lockJson('^1.1.2', '1.1.2'))
    }
    if (line === 'git rev-parse --abbrev-ref HEAD') return { code: 0, out: `${BRANCH}\n` }
    if (line === 'git rev-parse HEAD') return { code: 0, out: `${SHA}\n` }
    if (line.startsWith('git ls-remote')) return { code: 0, out: `${SHA}\trefs/heads/${BRANCH}\n` }
    if (line === 'git remote get-url origin') return { code: 0, out: 'git@github.com:visionmediahq/site.git\n' }
    if (line === 'git show origin/main:package.json') return { code: 0, out: o.mainPkg ?? pkgJson('^1.1.2') }
    if (line === 'git diff --name-only origin/main...HEAD') return { code: 0, out: o.diff ?? 'package-lock.json\npackage.json\n' }
    if (line.startsWith('npm ls')) return { code: 0, out: NPM_LS }
    return { code: 0, out: '' }
  }
  const ok = (path: string): RequestResult => ({ path, banner: true, banners: 1, blocked: [], errors: [], known: [], ok: true })
  const checks: Checks = {
    pages: async () => ['/', '/karta', '/karta-efter-widget', '/finns-inte-x'],
    // The demo report's embeds (detect found them there).
    embedPages: async () => ['/karta', '/karta-efter-widget'],
    requests: async (_base, paths, opts) => paths.map((p) => ({ ...ok(p), banner: opts.expectBanner ? opts.expectBanner(p) : true })),
    consentPaths: async (_b, paths) => (
      called.push('consentPaths'),
      paths.map((path) => ({ path, visaLoadsOnlyClicked: true, rememberAutoShows: true, nekaLoadsNothing: true, filterKept: null, filter: 'none', openHref: null, notes: [] }))
    ),
    clip: async (_b, paths) => (called.push('clip'), paths.map((path) => ({ path, width: 360, kind: 'button' as const, button: 'Neka', w: 80, boxW: 300, over: false, out: false, covered: false, cut: false, clipped: false }))),
    rootStyles: async () => ({}),
    embedBoxes: async () => [],
    contrast: async (_b, paths) => (
      called.push('contrast'),
      paths.flatMap((path) => (['banner', 'links'] as const).map((kind) => ({ path, kind, button: 'Neka', ratio: 7, ok: true, fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } })))
    ),
    shots: async () => (called.push('shots'), ['/tmp/x.png']),
    fonts: async () => (called.push('fonts'), []),
    close: async () => undefined,
  }
  const deps: Partial<VerifyDeps> = {
    exec,
    preview: async (_dir, port) => ({ url: `http://127.0.0.1:${port}`, stop: async () => undefined }),
    checks: async () => checks,
    freeBytes: () => 100e9,
    isUp: async () => false,
    docker: async (_url, b, run) => (called.push(`docker ${b}`), { pass: await run('http://127.0.0.1:4397'), log: 'docker ok' }),
    toolVersion: () => ({ sha: '0123456789abcdef0123456789abcdef01234567', dirty: false }),
  }
  return { deps, calls, called }
}

const steps = (r: Awaited<ReturnType<typeof verify>>) => r.steps.map((s) => [s.step, s.name, s.skipped ? 'skipped' : s.pass ? 'pass' : 'FAIL'])
const evidence = (dir: string, file: string) => readFileSync(join(dir, `.rollout/evidence-${BRANCH}`, file), 'utf8')

describe('verify on astro-consent-update', () => {
  test('every banner step runs (the banner changes with the package), 8 skipped without fonts.css; its own state files', async () => {
    const dir = siteDir()
    const f = fake()
    const r = await verify(dir, report(), { deps: f.deps })
    expect(steps(r)).toEqual([
      [1, 'lockfile', 'pass'],
      [2, 'build', 'pass'],
      [3, 'requests', 'pass'],
      [4, 'consent-paths', 'pass'],
      [5, 'clip', 'pass'],
      [6, 'contrast', 'pass'],
      [7, 'screenshots', 'pass'],
      [8, 'fonts', 'skipped'],
      [9, 'docker', 'pass'],
    ])
    expect(f.calls.filter((c) => c.startsWith('git push'))).toEqual([`git push --force-with-lease origin ${BRANCH}`])
    expect(f.called).toContain(`docker ${BRANCH}`)
    expect(f.called).toContain('consentPaths')
    expect(f.called).toContain('contrast')
    expect(f.called).not.toContain('fonts')
    expect(JSON.parse(readFileSync(join(dir, `.rollout/verify-${BRANCH}.json`), 'utf8'))).toEqual(r)
    expect(evidence(dir, '1-lockfile.txt')).toMatch(
      new RegExp(
        [
          `allowed node_modules/${PKG}: 1\\.1\\.2 → 1\\.1\\.4`,
          `package\\.json, main → branch: only the ${PKG} spec changed`,
          'changed files \\(2\\): only package\\.json and package-lock\\.json',
          `${PKG} on main → branch: 1\\.1\\.2 → 1\\.1\\.4`,
        ].join('[\\s\\S]*'),
      ),
    )
  })

  test('step 1 fails: a file besides the two, the version not moved up, another lockfile entry, another package.json change', async () => {
    for (const [o, files, why] of [
      [{ diff: 'package-lock.json\npackage.json\nsrc/pages/index.astro\n' }, {}, /NOT ONLY package\.json AND package-lock\.json[\s\S]*UNKNOWN src\/pages\/index\.astro/],
      [{ mainLock: lockJson('^1.1.4', '1.1.4'), mainPkg: pkgJson('^1.1.4') }, {}, new RegExp(`${PKG} on main → branch: 1\\.1\\.4 → 1\\.1\\.4: NOT AN UPDATE`)],
      [{}, { 'package-lock.json': lockJson('^1.1.4', '1.1.4', { 'node_modules/tslib': { version: '2.8.1', optional: true } }) }, /UNKNOWN node_modules\/tslib: added 2\.8\.1/],
      [{}, { 'package.json': pkgJson('^1.1.4', { engines: { node: '22' } }) }, /package\.json, main → branch: CHANGED beyond the package[\s\S]*UNKNOWN engines: changed/],
    ] as const) {
      const dir = siteDir(files)
      const r = await verify(dir, report(), { deps: fake(o).deps })
      expect(steps(r)).toEqual([[1, 'lockfile', 'FAIL']])
      expect(evidence(dir, '1-lockfile.txt')).toMatch(why)
    }
  })
})
