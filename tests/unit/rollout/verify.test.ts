import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { ClipResult } from '../../../ci/rollout/checks/clip'
import type { ConsentPathResult } from '../../../ci/rollout/checks/consent-paths'
import type { ContrastRow } from '../../../ci/rollout/checks/contrast'
import type { RequestResult } from '../../../ci/rollout/checks/requests'
import { dockerCheck } from '../../../ci/rollout/docker'
import { startPreview } from '../../../ci/rollout/preview'
import type { Report } from '../../../ci/rollout/types'
import { type Checks, type Exec, mapRoutes, ORIGIN, type VerifyDeps, verify } from '../../../ci/rollout/verify'

const PKG = '@visionmediahq/astro-consent'
const DEMO_REPORT = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/demo-report.json'), 'utf8')) as Report
const report = (over: Partial<Report> = {}): Report => ({ ...DEMO_REPORT, astro: { major: 7, output: 'static' }, ...over })

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const lock = (packages: Record<string, Record<string, unknown>>) => JSON.stringify({ lockfileVersion: 3, packages })
const MAIN_LOCK = lock({ '': { name: 'site', dependencies: { astro: '^7.3.5' } }, 'node_modules/zod': { version: '4.1.0' } })
const BRANCH_LOCK = lock({
  '': { name: 'site', dependencies: { [PKG]: 'github:visionmediahq/astro-consent#semver:^1.0.2', astro: '^7.3.5' } },
  [`node_modules/${PKG}`]: { version: '1.0.2' },
  'node_modules/zod': { version: '4.6.5' },
})
const MAIN_PKG = JSON.stringify({ name: 'site', dependencies: { astro: '^7.3.5' } })
const BRANCH_PKG = JSON.stringify({ name: 'site', dependencies: { [PKG]: 'github:visionmediahq/astro-consent#semver:^1.0.2', astro: '^7.3.5' } })
const npmLs = (astro: string) =>
  JSON.stringify({ name: 'site', dependencies: { astro: { version: astro, dependencies: { vite: { version: '7.1.0' } } } } })

/** A site checkout in a temp folder: `<tmp>/site`, so the main worktree `<tmp>/site-main` is beside it. */
function siteDir(lockText = BRANCH_LOCK): string {
  const root = mkdtempSync(join(tmpdir(), 'verify-'))
  dirs.push(root)
  const dir = join(root, 'site')
  mkdirSync(dir)
  writeFileSync(join(dir, 'package-lock.json'), lockText)
  writeFileSync(join(dir, 'package.json'), BRANCH_PKG)
  return dir
}

const SHA = 'a'.repeat(40)

interface Fake {
  deps: Partial<VerifyDeps>
  calls: string[]
  called: Set<string>
}

/**
 * Fakes for every dependency: exec answers git, npm and docker; previews and checks record their
 * calls. `over` replaces single exec answers (by command line prefix) or checks.
 */
function fake(
  opts: {
    mainLock?: string
    exec?: Record<string, { code: number; out: string }>
    checks?: Partial<Checks>
    docker?: VerifyDeps['docker']
  } = {},
): Fake {
  const calls: string[] = []
  const called = new Set<string>()
  const exec: Exec = async (cmd, args, cwd) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    for (const [prefix, answer] of Object.entries(opts.exec ?? {})) if (line.startsWith(prefix)) return answer
    if (line.startsWith('git worktree add')) {
      const target = args[args.indexOf('--detach') + 1]!
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'package-lock.json'), opts.mainLock ?? MAIN_LOCK)
    }
    if (line === 'git rev-parse --abbrev-ref HEAD') return { code: 0, out: 'consent-banner\n' }
    if (line === 'git rev-parse HEAD') return { code: 0, out: `${SHA}\n` }
    if (line.startsWith('git ls-remote')) return { code: 0, out: `${SHA}\trefs/heads/consent-banner\n` }
    if (line === 'git remote get-url origin') return { code: 0, out: 'git@github.com:visionmediahq/site.git\n' }
    if (line.startsWith('npm ls')) return { code: 0, out: npmLs('7.3.5') }
    if (line === 'git show origin/main:package.json') return { code: 0, out: MAIN_PKG }
    if (line === 'git worktree list --porcelain') {
      const listed = calls.filter((c) => c.startsWith('git worktree add')).map((c) => c.split(' ')[4])
      return { code: 0, out: listed.map((w) => `worktree ${w}\nHEAD ${SHA}\ndetached\n`).join('\n') }
    }
    void cwd
    return { code: 0, out: '' }
  }
  const ok = (path: string): RequestResult => ({ path, banner: true, banners: 1, blocked: [], errors: [], known: [], ok: true })
  const checks: Checks = {
    pages: async () => (called.add('pages'), ['/', '/karta', '/finns-inte-x']),
    embedPages: async () => (called.add('embedPages'), ['/karta']),
    requests: async (base, paths) => {
      called.add(`requests ${base}`)
      return base.includes(':4398')
        ? paths.map((p) => ({ ...ok(p), banner: false, blocked: p === '/karta' ? ['https://www.google.com/maps/embed?pb=x'] : [], ok: false }))
        : paths.map(ok)
    },
    consentPaths: async (_base, paths) => (
      called.add('consentPaths'),
      paths.map((path): ConsentPathResult => ({
        path,
        visaLoadsOnlyClicked: true,
        rememberAutoShows: true,
        nekaLoadsNothing: true,
        filterKept: null,
        filter: 'none',
        openHref: null,
        notes: [],
      }))
    ),
    clip: async (_base, paths) => (
      called.add('clip'),
      paths.map((path): ClipResult => ({ path, width: 320, kind: 'button', button: 'Neka', w: 80, boxW: 300, over: false, out: false, covered: false, clipped: false }))
    ),
    contrast: async (_base, paths) => (
      called.add('contrast'),
      paths.flatMap((path) => (['banner', 'links'] as const).map((kind): ContrastRow => ({
        path,
        kind,
        button: 'Neka',
        ratio: 7,
        ok: true,
        fg: { r: 0, g: 0, b: 0 },
        bg: { r: 255, g: 255, b: 255 },
      })))
    ),
    shots: async () => (called.add('shots'), ['/tmp/x.png']),
    close: async () => void called.add('close'),
    ...opts.checks,
  }
  const deps: Partial<VerifyDeps> = {
    exec,
    preview: async (dir, port) => {
      called.add(`preview ${port}`)
      calls.push(`preview ${dir} ${port}`)
      return { url: `http://127.0.0.1:${port}`, stop: async () => void calls.push(`stop ${port}`) }
    },
    checks: async () => checks,
    docker:
      opts.docker ??
      (async (_url, _branch, run) => {
        called.add('docker')
        return { pass: await run('http://127.0.0.1:4397'), log: 'docker ok' }
      }),
  }
  return { deps, calls, called }
}

const evidence = (dir: string, file: string) => readFileSync(join(dir, '.rollout/evidence', file), 'utf8')

describe('verify', () => {
  test('all eight steps pass; pushes consent-banner and nothing else; the main worktree is removed', async () => {
    const dir = siteDir()
    const f = fake()
    const result = await verify(dir, report(), { deps: f.deps })
    expect(result.steps.map((s) => [s.step, s.pass])).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, true]))
    expect(result.pass).toBe(true)
    const pushes = f.calls.filter((c) => c.startsWith('git push'))
    expect(pushes).toEqual(['git push --force-with-lease origin consent-banner'])
    expect(f.calls.indexOf(pushes[0]!)).toBeLessThan(f.calls.findIndex((c) => c.startsWith('npm')))
    expect(f.calls).toContain(`git worktree add --detach ${dir}-main origin/main`)
    expect(f.calls.at(-1)).toBe(`git worktree remove --force ${dir}-main`)
    expect(f.calls).toContain('stop 4398')
    expect(f.calls).toContain('stop 4399')
    expect(f.called.has('close')).toBe(true)
    const written = JSON.parse(readFileSync(join(dir, '.rollout/verify.json'), 'utf8')) as typeof result
    expect(written).toEqual(result)
    expect(result.sha).toBe(SHA)
    for (const name of ['1-lockfile', '2-build', '3-requests', '4-consent-paths', '5-clip', '6-contrast', '7-screenshots', '8-docker']) {
      expect(existsSync(join(dir, '.rollout/evidence', `${name}.txt`)), name).toBe(true)
    }
  })

  test('stops at the first failing step: later steps are not run', async () => {
    const dir = siteDir()
    const f = fake({ exec: { 'npm run build': { code: 1, out: 'error: build broke' } } })
    const result = await verify(dir, report(), { deps: f.deps })
    expect(result.pass).toBe(false)
    expect(result.steps.map((s) => [s.step, s.pass])).toEqual([
      [1, true],
      [2, false],
    ])
    expect(evidence(dir, '2-build.txt')).toContain('build broke')
    expect([...f.called].filter((c) => !c.startsWith('close'))).toEqual([])
    expect(f.calls.at(-1)).toBe(`git worktree remove --force ${dir}-main`)
  })

  test('stale screenshots from an earlier run are wiped when verify starts', async () => {
    const dir = siteDir()
    mkdirSync(join(dir, '.rollout/shots'), { recursive: true })
    writeFileSync(join(dir, '.rollout/shots/old.png'), 'x')
    await verify(dir, report(), { deps: fake({ exec: { 'npm run build': { code: 1, out: 'x' } } }).deps })
    expect(existsSync(join(dir, '.rollout/shots/old.png'))).toBe(false)
  })

  test('a failing step 5 stops before contrast, screenshots and docker', async () => {
    const dir = siteDir()
    const clipped: ClipResult = { path: '/', width: 320, kind: 'button', button: 'Acceptera alla', w: 140, boxW: 120, over: false, out: true, covered: false, clipped: true }
    const f = fake({ checks: { clip: async () => [clipped] } })
    const result = await verify(dir, report(), { deps: f.deps })
    expect(result.steps.at(-1)).toMatchObject({ step: 5, pass: false })
    expect(result.steps).toHaveLength(5)
    expect(f.called.has('contrast')).toBe(false)
    expect(f.called.has('docker')).toBe(false)
    expect(evidence(dir, '5-clip.txt')).toContain('Acceptera alla')
  })

  test('step 5: a covered banner button fails and says so (aspokarlsson)', async () => {
    const dir = siteDir()
    const covered: ClipResult = { path: '/', width: 360, kind: 'button', button: 'OK', w: 44, boxW: 326, over: false, out: false, covered: true, clipped: true }
    const f = fake({ checks: { clip: async () => [covered] } })
    const result = await verify(dir, report(), { deps: f.deps })
    expect(result.steps.at(-1)).toMatchObject({ step: 5, pass: false })
    expect(evidence(dir, '5-clip.txt')).toContain('/ 360px button "OK" 44px in 326px CLIPPED (covered by another element)')
  })

  test('step 1: an unknown lockfile change fails and is listed', async () => {
    const dir = siteDir(lock({ ...JSON.parse(BRANCH_LOCK).packages, 'node_modules/left-pad': { version: '1.0.0' } }))
    const result = await verify(dir, report(), { deps: fake().deps })
    expect(result.steps).toEqual([expect.objectContaining({ step: 1, name: 'lockfile', pass: false })])
    expect(result.steps[0]!.evidence).toContain('node_modules/left-pad')
  })

  test('step 1: only allowlisted changes pass', async () => {
    const result = await verify(siteDir(), report(), { deps: fake().deps })
    expect(result.steps[0]).toMatchObject({ step: 1, pass: true })
    expect(result.steps[0]!.evidence).toContain('node_modules/zod: 4.1.0 → 4.6.5')
  })

  test('step 1: npm ls astro vite @tailwindcss/vite differing between main and the branch fails', async () => {
    const dir = siteDir()
    const base = fake()
    const exec: Exec = async (cmd, args, cwd) => {
      const answer = await base.deps.exec!(cmd, args, cwd)
      return [cmd, ...args].join(' ').startsWith('npm ls') && cwd === dir ? { code: 0, out: npmLs('7.4.0') } : answer
    }
    const result = await verify(dir, report(), { deps: { ...base.deps, exec } })
    expect(result.steps).toEqual([expect.objectContaining({ step: 1, pass: false })])
    expect(result.steps[0]!.evidence).toMatch(/astro@7\.3\.5/)
    expect(result.steps[0]!.evidence).toMatch(/astro@7\.4\.0/)
    expect(base.calls.filter((c) => c.startsWith('npm ls'))).toEqual([
      'npm ls astro vite @tailwindcss/vite --all --json',
      'npm ls astro vite @tailwindcss/vite --all --json',
    ])
  })

  test('step 3: main already showing a banner is recorded as "main already green", not a failure', async () => {
    const dir = siteDir()
    const f = fake({
      checks: {
        requests: async (_base, paths) => paths.map((path) => ({ path, banner: true, banners: 1, blocked: [], errors: [], known: [], ok: true })),
      },
    })
    const result = await verify(dir, report(), { deps: f.deps })
    expect(result.steps[2]).toMatchObject({ step: 3, pass: true })
    expect(result.steps[2]!.evidence).toContain('main already green')
    expect(result.pass).toBe(true)
  })

  test('step 3: a blocked request on the branch on a page detect did not know → fail, "detect miss: <path>"', async () => {
    const dir = siteDir()
    const f = fake({
      checks: {
        pages: async () => ['/', '/om', '/karta', '/finns-inte-x'],
        requests: async (base, paths) =>
          paths.map((path) => {
            const blocked = base.includes(':4399') && path === '/om' ? ['https://www.youtube.com/embed/x'] : []
            return { path, banner: base.includes(':4399'), banners: 1, blocked, errors: [], known: [], ok: blocked.length === 0 }
          }),
      },
    })
    const result = await verify(dir, report(), { deps: f.deps })
    expect(result.steps.at(-1)).toMatchObject({ step: 3, pass: false })
    expect(result.steps.at(-1)!.evidence.split('\n')).toContain('detect miss: /om')
    expect(f.called.has('consentPaths')).toBe(false)
  })

  test('step 3: main console errors are the baseline, with main’s port rewritten to the branch’s', async () => {
    const dir = siteDir()
    const seen: (Set<string> | undefined)[] = []
    const f = fake({
      checks: {
        requests: async (base, paths, opts) => {
          seen.push(opts.baseline)
          return paths.map((path) => ({
            path,
            banner: base.includes(':4399'),
            banners: 1,
            blocked: [],
            errors: base.includes(':4398') ? ['Failed to load http://127.0.0.1:4398/x.js'] : [],
            known: [],
            ok: true,
          }))
        },
      },
    })
    await verify(dir, report(), { deps: f.deps })
    expect([...seen[1]!]).toEqual(['Failed to load http://127.0.0.1:4399/x.js'])
  })

  test('step 4 asserts the filter only where the report has one, and fails when it was lost', async () => {
    const dir = siteDir()
    const asked: (boolean | undefined)[] = []
    const f = fake({
      checks: {
        consentPaths: async (_b, paths, opts) =>
          paths.map((path) => {
            asked.push(opts.expectFilter?.(path))
            return { path, visaLoadsOnlyClicked: true, rememberAutoShows: true, nekaLoadsNothing: true, filterKept: false, filter: 'none', openHref: null, notes: [] }
          }),
      },
    })
    const withFilter = report({ iframes: DEMO_REPORT.iframes.map((i) => ({ ...i, classes: 'w-full grayscale' })) })
    const result = await verify(dir, withFilter, { deps: f.deps })
    expect(asked).toEqual([true])
    expect(result.steps.at(-1)).toMatchObject({ step: 4, pass: false })
  })

  test('step 4: a maps site with no embed on any built page fails', async () => {
    const f = fake({ checks: { embedPages: async () => [] } })
    const result = await verify(siteDir(), report(), { deps: f.deps })
    expect(result.steps.at(-1)).toMatchObject({ step: 4, pass: false })
  })

  test('step 6 (Ruling 20): an indeterminate PrivacyLinks row fails', async () => {
    const f = fake({
      checks: {
        contrast: async () => [
          { path: '/', kind: 'banner', button: 'Neka', ratio: 7, ok: true, fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } },
          { path: '/', kind: 'links', button: 'Integritet', ratio: 5, ok: false, fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 }, indeterminate: 'background image behind the text' },
        ],
      },
    })
    const dir = siteDir()
    const result = await verify(dir, report(), { deps: f.deps })
    expect(result.steps.at(-1)).toMatchObject({ step: 6, pass: false })
    expect(evidence(dir, '6-contrast.txt')).toContain('indeterminate')
  })

  test('step 8: the remote branch head must equal the local HEAD', async () => {
    const f = fake({ exec: { 'git ls-remote origin': { code: 0, out: `${'b'.repeat(40)}\trefs/heads/consent-banner\n` } } })
    const result = await verify(siteDir(), report(), { deps: f.deps })
    expect(result.steps.at(-1)).toMatchObject({ step: 8, pass: false })
    expect(f.called.has('docker')).toBe(false)
  })

  test('step 8 runs steps 3–4 against the container', async () => {
    const f = fake()
    await verify(siteDir(), report(), { deps: f.deps })
    expect(f.called.has('requests http://127.0.0.1:4397')).toBe(true)
  })

  test('refuses to run on any branch but consent-banner, and pushes nothing', async () => {
    const f = fake({ exec: { 'git rev-parse --abbrev-ref HEAD': { code: 0, out: 'main\n' } } })
    await expect(verify(siteDir(), report(), { deps: f.deps })).rejects.toThrow(/consent-banner/)
    expect(f.calls.some((c) => c.startsWith('git push'))).toBe(false)
  })

  test('a failed push stops before step 1', async () => {
    const f = fake({ exec: { 'git push': { code: 1, out: 'rejected (stale info)' } } })
    const result = await verify(siteDir(), report(), { deps: f.deps })
    expect(result.pass).toBe(false)
    expect(result.steps).toEqual([expect.objectContaining({ step: 0, name: 'push', pass: false })])
    expect(f.calls.some((c) => c.startsWith('npm'))).toBe(false)
  })

  test('step 1: package.json may change only the astro-consent dependency', async () => {
    const dir = siteDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'site', scripts: { postinstall: 'x' }, dependencies: JSON.parse(BRANCH_PKG).dependencies }))
    const result = await verify(dir, report(), { deps: fake().deps })
    expect(result.steps).toEqual([expect.objectContaining({ step: 1, pass: false })])
    expect(result.steps[0]!.evidence).toContain('scripts')
  })

  test('an unrelated <dir>-main folder is left alone and verify refuses', async () => {
    const dir = siteDir()
    mkdirSync(`${dir}-main`)
    writeFileSync(join(`${dir}-main`, 'keep.txt'), 'mine')
    const f = fake()
    await expect(verify(dir, report(), { deps: f.deps })).rejects.toThrow(/-main.*not a worktree of this clone/)
    expect(readFileSync(join(`${dir}-main`, 'keep.txt'), 'utf8')).toBe('mine')
    expect(f.calls.some((c) => c.startsWith('git push') || c.startsWith('git worktree remove'))).toBe(false)
  })

  test('a leftover <dir>-main worktree of this clone is removed and recreated', async () => {
    const dir = siteDir()
    const f = fake()
    await verify(dir, report(), { deps: f.deps })
    mkdirSync(`${dir}-main`, { recursive: true })
    const g = fake()
    const exec: Exec = async (cmd, args, cwd) =>
      [cmd, ...args].join(' ') === 'git worktree list --porcelain' ? { code: 0, out: `worktree ${dir}\n\nworktree ${dir}-main\ndetached\n` } : g.deps.exec!(cmd, args, cwd)
    const result = await verify(dir, report(), { deps: { ...g.deps, exec } })
    expect(result.pass).toBe(true)
    expect(g.calls.filter((c) => c === `git worktree remove --force ${dir}-main`)).toHaveLength(2)
  })

  test('step 6 (Ruling 20): a page without PrivacyLinks rows fails even when another page has them', async () => {
    const row = (path: string, kind: 'banner' | 'links'): ContrastRow => ({ path, kind, button: 'x', ratio: 7, ok: true, fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } })
    const f = fake({
      checks: {
        contrast: async () => [row('/', 'banner'), row('/', 'links'), row('/karta', 'banner'), row('/finns-inte-x', 'banner'), row('/finns-inte-x', 'links')],
      },
    })
    const dir = siteDir()
    const result = await verify(dir, report(), { deps: f.deps })
    expect(result.steps.at(-1)).toMatchObject({ step: 6, pass: false })
    expect(evidence(dir, '6-contrast.txt')).toContain('/karta: no PrivacyLinks text measured')
  })

  test('step 6: CMS admin pages (Ruling 26) need no PrivacyLinks', async () => {
    const row = (path: string, kind: 'banner' | 'links'): ContrastRow => ({ path, kind, button: 'x', ratio: 7, ok: true, fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } })
    const f = fake({
      checks: {
        pages: async () => ['/', '/admin/', '/finns-inte-x'],
        embedPages: async () => [],
        contrast: async () => [row('/', 'banner'), row('/', 'links'), row('/admin/', 'banner'), row('/finns-inte-x', 'banner'), row('/finns-inte-x', 'links')],
      },
    })
    const result = await verify(siteDir(), report({ classification: 'notice', iframes: [] }), { deps: f.deps })
    expect(result.steps[5]).toMatchObject({ step: 6, pass: true })
  })

  test('step 3 (Ruling 34a): the pages must include "/"', async () => {
    const f = fake({ checks: { pages: async () => ['/finns-inte-x'], embedPages: async () => [] } })
    const result = await verify(siteDir(), report({ classification: 'notice', iframes: [] }), { deps: f.deps })
    expect(result.steps.at(-1)).toMatchObject({ step: 3, pass: false })
    expect(result.steps.at(-1)!.evidence).toContain('"/" is not among the pages')
  })

  test('step 8 (Ruling 34b): an origin outside github.com/visionmediahq fails before Docker', async () => {
    const f = fake({ exec: { 'git remote get-url origin': { code: 0, out: 'https://gitlab.com/someone/site.git\n' } } })
    const result = await verify(siteDir(), report(), { deps: f.deps })
    expect(result.steps.at(-1)).toMatchObject({ step: 8, pass: false })
    expect(result.steps.at(-1)!.evidence).toContain('github.com/visionmediahq')
    expect(f.called.has('docker')).toBe(false)
  })

  test('demo mode: no git, no npm, no docker; steps 1, 2 and 8 skipped; /utan-banner and the 404 expect no banner', async () => {
    const out = mkdtempSync(join(tmpdir(), 'verify-demo-'))
    dirs.push(out)
    const expected: [string, boolean][] = []
    const consentPages: string[] = []
    const f = fake({
      checks: {
        requests: async (_b, paths, opts) =>
          paths.map((path) => {
            expected.push([path, opts.expectBanner!(path)])
            return { path, banner: true, banners: 1, blocked: [], errors: [], known: [], ok: true }
          }),
        pages: async () => ['/', '/karta', '/utan-banner', '/finns-inte-x'],
        embedPages: async () => ['/karta', '/utan-banner/'],
        consentPaths: async (_b, paths) => {
          consentPages.push(...paths)
          return paths.map((path) => ({ path, visaLoadsOnlyClicked: true, rememberAutoShows: true, nekaLoadsNothing: true, filterKept: null, filter: 'none', openHref: null, notes: [] }))
        },
      },
    })
    const result = await verify('/demo/dist-consent', DEMO_REPORT, { deps: f.deps, demo: true, out })
    expect(f.calls.filter((c) => !c.startsWith('preview') && !c.startsWith('stop'))).toEqual([])
    expect(f.called.has('docker')).toBe(false)
    expect(result.steps.map((s) => [s.step, s.pass, s.skipped ?? false])).toEqual([
      [1, true, true],
      [2, true, true],
      [3, true, false],
      [4, true, false],
      [5, true, false],
      [6, true, false],
      [7, true, false],
      [8, true, true],
    ])
    expect(expected).toEqual([
      ['/', true],
      ['/karta', true],
      ['/utan-banner', false],
      ['/finns-inte-x', false],
    ])
    expect(existsSync(join(out, 'verify.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(out, 'verify.json'), 'utf8')).sha).toBeNull()
    // Step 4 clicks the banner: the bannerless page is left out.
    expect(consentPages).toEqual(['/karta'])
  })
})

describe('verify: final review fixes', () => {
  test('finding 1: uncommitted or untracked files refuse verify before the push, with a failing verify.json', async () => {
    const dir = siteDir()
    const f = fake({ exec: { 'git status --porcelain --untracked-files=all': { code: 0, out: ' M src/layouts/Base.astro\n?? notes.txt\n' } } })
    const result = await verify(dir, report(), { deps: f.deps })
    expect(result.pass).toBe(false)
    expect(result.steps).toEqual([expect.objectContaining({ step: 0, name: 'clean', pass: false })])
    expect(result.steps[0]!.evidence).toContain('commit your changes, then rerun verify')
    expect(result.steps[0]!.evidence).toContain('src/layouts/Base.astro')
    expect(JSON.parse(readFileSync(join(dir, '.rollout/verify.json'), 'utf8'))).toEqual(result)
    expect(f.calls.some((c) => c.startsWith('git push') || c.startsWith('npm'))).toBe(false)
  })

  test('finding 1: a failing git status refuses too', async () => {
    const f = fake({ exec: { 'git status --porcelain --untracked-files=all': { code: 128, out: 'fatal: x' } } })
    const result = await verify(siteDir(), report(), { deps: f.deps })
    expect(result.steps).toEqual([expect.objectContaining({ step: 0, name: 'clean', pass: false })])
    expect(f.calls.some((c) => c.startsWith('git push'))).toBe(false)
  })

  test('finding 2: a remote consent-banner this tool did not push is never force-pushed over', async () => {
    const dir = siteDir()
    const other = 'b'.repeat(40)
    const f = fake({ exec: { 'git ls-remote --heads origin refs/heads/consent-banner': { code: 0, out: `${other}\trefs/heads/consent-banner\n` } } })
    const result = await verify(dir, report(), { deps: f.deps })
    expect(result.pass).toBe(false)
    expect(result.steps).toEqual([expect.objectContaining({ step: 0, name: 'push', pass: false })])
    expect(result.steps[0]!.evidence).toContain(other)
    expect(f.calls.some((c) => c.startsWith('git push'))).toBe(false)
  })

  test('finding 2: the remote head this tool pushed last (a rerun after a rebase or amend) may be replaced', async () => {
    const dir = siteDir()
    const ours = 'b'.repeat(40)
    const first = fake({ exec: { 'git ls-remote --heads origin refs/heads/consent-banner': { code: 0, out: '' }, 'git rev-parse HEAD': { code: 0, out: `${ours}\n` } } })
    await verify(dir, report(), { deps: first.deps })
    expect(first.calls).toContain('git push --force-with-lease origin consent-banner')
    rmSync(`${dir}-main`, { recursive: true, force: true })
    const again = fake({ exec: { 'git ls-remote --heads origin refs/heads/consent-banner': { code: 0, out: `${ours}\trefs/heads/consent-banner\n` } } })
    const result = await verify(dir, report(), { deps: again.deps })
    expect(again.calls).toContain('git push --force-with-lease origin consent-banner')
    expect(result.steps[0]).toMatchObject({ step: 1, pass: true })
  })

  test('finding 2: ls-remote failing refuses the push', async () => {
    const f = fake({ exec: { 'git ls-remote --heads origin refs/heads/consent-banner': { code: 2, out: 'fatal: could not read' } } })
    const result = await verify(siteDir(), report(), { deps: f.deps })
    expect(result.steps).toEqual([expect.objectContaining({ step: 0, name: 'push', pass: false })])
    expect(f.calls.some((c) => c.startsWith('git push'))).toBe(false)
  })

  test('pre-run: another branch ending in /consent-banner on origin is not ours to refuse over', async () => {
    const f = fake({ exec: { 'git ls-remote --heads origin': { code: 0, out: `${'b'.repeat(40)}\trefs/heads/feature/consent-banner\n` } } })
    const result = await verify(siteDir(), report(), { deps: f.deps })
    expect(f.calls).toContain('git ls-remote --heads origin refs/heads/consent-banner')
    expect(f.calls).toContain('git push --force-with-lease origin consent-banner')
    expect(result.steps[0]).toMatchObject({ step: 1, pass: true })
  })

  test("pre-run: verify's own npm ci/build leaving the tree dirty fails as a site problem (the next verify would refuse)", async () => {
    const f = fake()
    const inner = f.deps.exec!
    let statuses = 0
    f.deps.exec = async (cmd, args, cwd) => {
      if (cmd === 'git' && args[0] === 'status' && statuses++ > 0) return { code: 0, out: '?? .astro/types.d.ts\n' }
      return inner(cmd, args, cwd)
    }
    const result = await verify(siteDir(), report(), { deps: f.deps })
    expect(result.pass).toBe(false)
    expect(result.steps.map((s) => [s.step, s.pass])).toEqual([...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, true]), [9, false]])
    expect(result.steps.at(-1)).toMatchObject({ name: 'clean' })
    expect(result.steps.at(-1)!.evidence).toContain('.astro/types.d.ts')
    expect(result.steps.at(-1)!.evidence).toMatch(/\.gitignore/)
  })

  test('finding 3: CMS admin routes (src/pages/admin/ or public/admin/) expect no banner, locally and in Docker', async () => {
    const asked: Record<string, Record<string, boolean>> = {}
    const row = (path: string, kind: 'banner' | 'links'): ContrastRow => ({ path, kind, button: 'x', ratio: 7, ok: true, fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } })
    const f = fake({
      checks: {
        pages: async () => ['/', '/admin/', '/admin/index.html', '/administration', '/finns-inte-x'],
        embedPages: async () => [],
        requests: async (base, paths, opts) =>
          paths.map((path) => {
            const expect = opts.expectBanner?.(path) ?? true
            ;(asked[base] ??= {})[path] = expect
            const banner = path.startsWith('/admin/') ? false : !base.includes(':4398')
            return { path, banner, banners: banner ? 1 : 0, blocked: [], errors: [], known: [], ok: banner === expect }
          }),
        contrast: async () => [row('/', 'banner'), row('/', 'links'), row('/administration', 'banner'), row('/administration', 'links'), row('/finns-inte-x', 'banner'), row('/finns-inte-x', 'links')],
      },
    })
    const result = await verify(siteDir(), report({ classification: 'notice', iframes: [] }), { deps: f.deps })
    const want = { '/': true, '/admin/': false, '/admin/index.html': false, '/administration': true, '/finns-inte-x': true }
    expect(asked['http://127.0.0.1:4399']).toEqual(want)
    expect(asked['http://127.0.0.1:4397']).toEqual(want)
    expect(result.pass).toBe(true)
  })

  test('finding 10: ORIGIN is anchored to github.com/visionmediahq', () => {
    expect(ORIGIN.test('git@github.com:visionmediahq/x.git')).toBe(true)
    expect(ORIGIN.test('https://github.com/visionmediahq/x')).toBe(true)
    expect(ORIGIN.test('https://evil/github.com/visionmediahq/x')).toBe(false)
    expect(ORIGIN.test('git@evil.com:github.com/visionmediahq/x')).toBe(false)
  })

  test('finding 10: step 8 refuses an origin that only contains github.com/visionmediahq', async () => {
    const f = fake({ exec: { 'git remote get-url origin': { code: 0, out: 'https://evil/github.com/visionmediahq/x\n' } } })
    const result = await verify(siteDir(), report(), { deps: f.deps })
    expect(result.steps.at(-1)).toMatchObject({ step: 8, pass: false })
    expect(f.called.has('docker')).toBe(false)
  })
})

describe('mapRoutes', () => {
  test('page files, layouts through their pages, and call sites; dynamic routes are left out', () => {
    const iframe = DEMO_REPORT.iframes[0]!
    const r = report({
      layouts: [{ file: 'src/layouts/Map.astro', pages: ['src/pages/hitta/index.astro'], footerRef: null }],
      iframes: [
        { ...iframe, file: 'src/pages/kontakt.astro' },
        { ...iframe, file: 'src/layouts/Map.astro' },
        { ...iframe, file: 'src/components/M.astro', callSites: [{ file: 'src/pages/om.astro', src: 'x' }, { file: 'src/pages/[slug].astro', src: 'y' }] },
      ],
    })
    expect([...mapRoutes(r)].sort()).toEqual(['/hitta', '/kontakt', '/om'])
  })
})

describe('dockerCheck', () => {
  function dockerFake(opts: { info?: number; build?: number } = {}) {
    const calls: string[] = []
    let clone = ''
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      if (cmd === 'docker' && args[0] === 'info') return { code: opts.info ?? 0, out: opts.info ? 'Cannot connect to the Docker daemon' : '' }
      if (cmd === 'git' && args[0] === 'clone') {
        clone = args.at(-1)!
        mkdirSync(clone, { recursive: true })
        writeFileSync(join(clone, 'Dockerfile'), 'FROM node:22\nEXPOSE 4321\nCMD ["node", "dist/server/entry.mjs"]\n')
      }
      if (cmd === 'docker' && args[0] === 'build') return { code: opts.build ?? 0, out: 'built' }
      if (cmd === 'docker' && args[0] === 'run') return { code: 0, out: 'c0ffee\n' }
      return { code: 0, out: '' }
    }
    return { exec, calls, clone: () => clone }
  }

  test('clone, build, run with PORT from EXPOSE, check, then stop, rmi, prune and delete the clone', async () => {
    const d = dockerFake()
    const result = await dockerCheck('git@github.com:visionmediahq/site.git', 'consent-banner', async (url) => url === 'http://127.0.0.1:4397', {
      exec: d.exec,
      waitUp: async () => true,
    })
    expect(result.pass).toBe(true)
    expect(d.calls).toContain(`git clone --depth 1 --branch consent-banner git@github.com:visionmediahq/site.git ${d.clone()}`)
    expect(d.calls).toContain(`docker build -t rollout-site ${d.clone()}`)
    expect(d.calls).toContain('docker run -d --rm -p 4397:4321 -e HOST=0.0.0.0 -e PORT=4321 rollout-site')
    expect(d.calls.slice(-3)).toEqual(['docker stop c0ffee', 'docker rmi -f rollout-site', 'docker builder prune -f'])
    expect(existsSync(d.clone())).toBe(false)
  })

  test('always cleans up (image removed, clone removed) even when run() throws', async () => {
    const d = dockerFake()
    const result = await dockerCheck('https://github.com/visionmediahq/site', 'consent-banner', async () => {
      throw new Error('browser crashed')
    }, { exec: d.exec, waitUp: async () => true })
    expect(result.pass).toBe(false)
    expect(result.log).toContain('browser crashed')
    expect(d.calls).toContain('docker stop c0ffee')
    expect(d.calls).toContain('docker rmi -f rollout-site')
    expect(existsSync(d.clone())).toBe(false)
  })

  test('a failed build still removes the image and the clone', async () => {
    const d = dockerFake({ build: 1 })
    const result = await dockerCheck('https://github.com/visionmediahq/site', 'consent-banner', async () => true, { exec: d.exec, waitUp: async () => true })
    expect(result.pass).toBe(false)
    expect(d.calls.some((c) => c.startsWith('docker run'))).toBe(false)
    expect(d.calls).toContain('docker rmi -f rollout-site')
    expect(existsSync(d.clone())).toBe(false)
  })

  test('Docker not running: a clear failure, nothing cloned', async () => {
    const d = dockerFake({ info: 1 })
    const result = await dockerCheck('https://github.com/visionmediahq/site', 'consent-banner', async () => true, { exec: d.exec })
    expect(result.pass).toBe(false)
    expect(result.log).toMatch(/Docker is not running/)
    expect(d.calls).toEqual(['docker info'])
  })
})

describe('startPreview', () => {
  let server: Server | null = null
  afterEach(() => {
    server?.close()
    server = null
  })

  test('starts the SSR entry with HOST and PORT, detached, and stop() kills it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'preview-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'dist/server'), { recursive: true })
    writeFileSync(
      join(dir, 'dist/server/entry.mjs'),
      "import { createServer } from 'node:http'\ncreateServer((q, s) => s.end('hej ' + process.env.HOST)).listen(Number(process.env.PORT), process.env.HOST)\n",
    )
    const port = 4380 + Math.floor(Math.random() * 10)
    const preview = await startPreview(dir, port, true)
    try {
      expect(preview.url).toBe(`http://127.0.0.1:${port}`)
      expect(await (await fetch(preview.url)).text()).toBe('hej 127.0.0.1')
    } finally {
      await preview.stop()
    }
    await expect(fetch(preview.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
  })

  test('refuses a port that is already serving', async () => {
    const port = 4370 + Math.floor(Math.random() * 10)
    server = createServer((_q, s) => s.end('old')).listen(port, '127.0.0.1')
    await new Promise((r) => server!.once('listening', r))
    await expect(startPreview(tmpdir(), port, true)).rejects.toThrow(/in use/)
  })
})
