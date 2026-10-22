// live and merge on the fonts-selfhost flow, and the fonts checks live (site-factory#220). Coolify,
// gh, git and the browser are all faked: nothing reaches a live site, GitHub or Coolify.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { FontsPage } from '../../../ci/rollout/checks/fonts'
import type { RequestResult } from '../../../ci/rollout/checks/requests'
import type { App, Deployment } from '../../../ci/rollout/coolify'
import type { Exec } from '../../../ci/rollout/lib/exec'
import { type LiveChecks, type LiveResult, live, type RecordedApps } from '../../../ci/rollout/live'
import { merge } from '../../../ci/rollout/merge'
import type { Report, VerifyResult } from '../../../ci/rollout/types'

const DEMO = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/demo-report.json'), 'utf8')) as Report
const SHA = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const MAIN = 'c'.repeat(40)
const FONTS_CSS = `/*\n * Generated from https://fonts.googleapis.com/css2?family=Figtree\n * on 2026-10-19 by the astro-consent rollout tool: Google's own faces, served from /fonts/.\n */\n/* latin */\n@font-face {\n  font-family: 'Figtree';\n  font-weight: 400;\n  src: url(/fonts/figtree.woff2) format('woff2');\n}\n`
const BANNER_PKG = JSON.stringify({ dependencies: { '@visionmediahq/astro-consent': 'github:visionmediahq/astro-consent#semver:^1.1.2' } })

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A clone; `state` are files in .rollout/ by name. */
function siteDir(state: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'live-fonts-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.rollout'))
  writeFileSync(join(dir, '.rollout/report.json'), JSON.stringify({ ...DEMO, site: 'site-1277834673', domains: ['site-1277834673.se'], classification: 'consent' }))
  for (const [name, text] of Object.entries(state)) writeFileSync(join(dir, '.rollout', name), text)
  return dir
}
const APPS: RecordedApps = { head: MAIN, apps: [{ uuid: 'web', name: 'web', repo: 'site-1277834673', branch: 'main', fqdns: ['site-1277834673.se'], autoDeploy: true, lastDeployed: MAIN }] }

/** git and gh: the branch, and main's fonts.css and package.json at `ref` (a commit or origin/main). */
function git(o: { branch?: string; fonts?: boolean; banner?: boolean; pkgFails?: boolean } = {}) {
  const calls: string[] = []
  const exec: Exec = async (cmd, args) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    if (line === 'git rev-parse --abbrev-ref HEAD') return { code: 0, out: `${o.branch ?? 'fonts-selfhost'}\n` }
    if (line === 'git fetch origin main') return { code: 0, out: '' }
    if (line === 'git rev-parse origin/main') return { code: 0, out: `${MAIN}\n` }
    if (line === 'git remote get-url origin') return { code: 0, out: 'git@github.com:visionmediahq/site-1277834673.git\n' }
    if (/^git show \S+:src\/styles\/fonts\.css$/.test(line)) return o.fonts === false ? { code: 128, out: 'fatal: path' } : { code: 0, out: FONTS_CSS }
    if (/^git show \S+:package\.json$/.test(line)) return o.pkgFails ? { code: 128, out: 'fatal: bad object' } : { code: 0, out: o.banner === false ? '{}' : BANNER_PKG }
    return { code: 1, out: `unexpected ${line}` }
  }
  return { exec, calls }
}

const req = (path: string, over: Partial<RequestResult> = {}): RequestResult => ({ path, banner: true, banners: 1, blocked: [], errors: [], known: [], ok: true, ...over })
const fontsPage = (path: string, over: Partial<FontsPage> = {}): FontsPage => ({
  path,
  width: 1280,
  google: [],
  woff2: [{ url: 'https://site-1277834673.se/fonts/figtree.woff2', status: 200 }],
  loaded: [{ family: 'Figtree', style: 'normal', weight: '400', status: 'loaded' }],
  used: [{ family: 'Figtree', weight: 400, style: 'normal' }],
  chars: {},
  bodyFamily: 'Figtree',
  ...over,
})

function checks(o: { fonts?: (base: string, paths: string[]) => FontsPage[]; requests?: (p: string[]) => RequestResult[] } = {}) {
  const calls: { what: string; base: string; expectBanner?: (p: string) => boolean }[] = []
  const c: LiveChecks = {
    pages: async () => ['/', '/kontakt'],
    embedPages: async () => [],
    requests: async (base, p, opts) => (calls.push({ what: 'requests', base, ...(opts.expectBanner ? { expectBanner: opts.expectBanner } : {}) }), o.requests ? o.requests(p) : p.map((x) => req(x))),
    consentPaths: async (base) => (calls.push({ what: 'consentPaths', base }), []),
    contrast: async (base, p) => (calls.push({ what: 'contrast', base }), p.map((path) => ({ path, kind: 'banner' as const, button: 'Neka', ratio: 7, ok: true, fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } }))),
    fonts: async (base, p) => (calls.push({ what: 'fonts', base }), o.fonts ? o.fonts(base, p) : p.map((x) => fontsPage(x))),
    close: async () => undefined,
  }
  return { checks: c, calls }
}
const liveDeps = (c: LiveChecks, exec: Exec, apps: App[] = [], deployments: Record<string, Deployment[]> = {}) => ({
  checks: async () => c,
  exec,
  sleep: async () => undefined,
  waitDeployed: async () => 'finished' as const,
  listApps: async () => apps,
  deployments: async (uuid: string) => deployments[uuid] ?? [],
})

describe('live post-merge with the fonts on main', () => {
  test('fonts-selfhost: the banner checks (main has the banner) and the fonts on every domain; its own state files', async () => {
    const dir = siteDir({ 'apps-fonts-selfhost.json': JSON.stringify(APPS), 'live-baseline-fonts-selfhost.txt': '' })
    const c = checks()
    const g = git()
    const r = await live(dir, 'post-merge', SHA, { deps: liveDeps(c.checks, g.exec) })
    expect(r.status).toBe('pass')
    expect(c.calls.map((x) => x.what)).toEqual(['requests', 'contrast', 'fonts'])
    expect(g.calls).toContain(`git show ${SHA}:src/styles/fonts.css`)
    expect(r.lines).toContain('checks: banner and self-hosted fonts')
    expect(r.lines.join('\n')).toMatch(/self-hosted fonts:\n {4}\/ 1280px: ok/)
    expect(existsSync(join(dir, '.rollout/live-post-merge-fonts-selfhost.json'))).toBe(true)
  })

  test('a Google Fonts request or a woff2 that is not 200 live fails twice, 30 s apart: STOP', async () => {
    for (const over of [{ google: ['https://fonts.googleapis.com/css2?family=Figtree'] }, { woff2: [{ url: 'https://site-1277834673.se/fonts/figtree.woff2', status: 404 }] }]) {
      const dir = siteDir({ 'apps-fonts-selfhost.json': JSON.stringify(APPS), 'live-baseline-fonts-selfhost.txt': '' })
      const c = checks({ fonts: (_b, p) => p.map((x) => fontsPage(x, over)) })
      const r = await live(dir, 'post-merge', SHA, { deps: liveDeps(c.checks, git().exec) })
      expect(r.status).toBe('stop')
      expect(r.reason).toBe('live check failed twice, 30 s apart: site-1277834673.se')
      expect(c.calls.filter((x) => x.what === 'fonts')).toHaveLength(2)
    }
  })

  test('fonts-selfhost on a site without the banner on main: the fonts and console errors only, no banner expected', async () => {
    const dir = siteDir({ 'apps-fonts-selfhost.json': JSON.stringify(APPS), 'live-baseline-fonts-selfhost.txt': '' })
    // The map on /kontakt is the site's own without a banner: noted, not checked. A console error still fails.
    const c = checks({ requests: (p) => p.map((x) => req(x, { banner: false, banners: 0, ok: false, ...(x === '/kontakt' ? { blocked: ['https://www.google.com/maps/embed?pb=x'] } : {}) })) })
    const r = await live(dir, 'post-merge', SHA, { deps: liveDeps(c.checks, git({ banner: false }).exec) })
    expect(r.status).toBe('pass')
    expect(r.lines).toContain('  registry requests: the site has no banner yet, so they are its own (noted, not checked)')
    const errors = checks({ requests: (p) => p.map((x) => req(x, { banner: false, banners: 0, errors: ['TypeError: x'] })) })
    const failed = await live(siteDir({ 'apps-fonts-selfhost.json': JSON.stringify(APPS), 'live-baseline-fonts-selfhost.txt': '' }), 'post-merge', SHA, { deps: liveDeps(errors.checks, git({ banner: false }).exec) })
    expect(failed.status).toBe('stop')
    expect(c.calls.map((x) => x.what)).toEqual(['requests', 'fonts'])
    expect(c.calls[0]!.expectBanner!('/')).toBe(false)
    expect(r.lines).toContain('checks: self-hosted fonts')
  })

  test('consent-banner whose merge has the fonts commit: banner and fonts; without it, the banner alone', async () => {
    for (const fonts of [true, false]) {
      const dir = siteDir({ 'apps.json': JSON.stringify(APPS), 'live-baseline.txt': '' })
      const c = checks()
      const r = await live(dir, 'post-merge', SHA, { deps: liveDeps(c.checks, git({ branch: 'consent-banner', fonts }).exec) })
      expect(r.status).toBe('pass')
      expect(c.calls.map((x) => x.what)).toEqual(fonts ? ['requests', 'contrast', 'fonts'] : ['requests', 'contrast'])
    }
  })

  test("fonts-selfhost never reads the banner's apps.json or baseline", async () => {
    const dir = siteDir({ 'apps.json': JSON.stringify(APPS), 'live-baseline.txt': '' })
    const r = await live(dir, 'post-merge', SHA, { deps: liveDeps(checks().checks, git().exec) })
    expect(r).toMatchObject({ status: 'stop', reason: '.rollout/apps-fonts-selfhost.json not found: merge records the apps before merging' })
  })

  test("main's package.json unreadable (fonts-selfhost): a STOP, not \"no banner\"", async () => {
    const dir = siteDir({ 'apps-fonts-selfhost.json': JSON.stringify(APPS), 'live-baseline-fonts-selfhost.txt': '' })
    const c = checks()
    const r = await live(dir, 'post-merge', SHA, { deps: liveDeps(c.checks, git({ pkgFails: true }).exec) })
    expect(r.status).toBe('stop')
    expect(r.reason).toMatch(/git show \S+:package\.json failed, so whether main has the banner is unknown/)
    expect(c.calls).toEqual([])
  })

  test('another branch is refused', async () => {
    await expect(live(siteDir(), 'post-merge', SHA, { deps: liveDeps(checks().checks, git({ branch: 'main' }).exec) })).rejects.toThrow('live runs on branch consent-banner or fonts-selfhost')
  })
})

describe('live baseline with the fonts on main', () => {
  const following = { apps: [{ uuid: 'web', name: 'web', repo: 'site-1277834673', branch: 'main', fqdns: ['site-1277834673.se'], autoDeploy: true }], deployments: { web: [{ id: 1, commit: MAIN, status: 'finished' as const, pullRequestId: 0 }] } }

  test("main already self-hosts the fonts: every host is checked for them too; the flow's own baseline files", async () => {
    const dir = siteDir()
    const c = checks()
    const r = await live(dir, 'baseline', undefined, { deps: liveDeps(c.checks, git().exec, following.apps, following.deployments) })
    expect(r.status).toBe('pass')
    expect(c.calls.map((x) => x.what)).toEqual(['requests', 'fonts'])
    expect(existsSync(join(dir, '.rollout/live-baseline-fonts-selfhost.txt'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, '.rollout/live-baseline-hosts-fonts-selfhost.json'), 'utf8')).hosts).toEqual(['site-1277834673.se'])
  })

  test('main self-hosts the fonts but the live site asks Google: STOP, and no baseline is written (merge would trust it)', async () => {
    const dir = siteDir()
    const c = checks({ fonts: (_b, p) => p.map((x) => fontsPage(x, { google: ['https://fonts.gstatic.com/s/x.woff2'] })) })
    const r = await live(dir, 'baseline', undefined, { deps: liveDeps(c.checks, git().exec, following.apps, following.deployments) })
    expect(r).toMatchObject({ status: 'stop', reason: 'main self-hosts the fonts, but site-1277834673.se failed the fonts check live' })
    expect(existsSync(join(dir, '.rollout/live-baseline-fonts-selfhost.txt'))).toBe(false)
    expect(existsSync(join(dir, '.rollout/live-baseline-hosts-fonts-selfhost.json'))).toBe(false)
  })

  test('main without the fonts: no fonts check (Google is expected before the merge)', async () => {
    const c = checks()
    await live(siteDir(), 'baseline', undefined, { deps: liveDeps(c.checks, git({ fonts: false }).exec, following.apps, following.deployments) })
    expect(c.calls.map((x) => x.what)).toEqual(['requests'])
  })
})

describe('the fonts check live skips CMS admin shells', () => {
  const following = { apps: [{ uuid: 'web', name: 'web', repo: 'site-1277834673', branch: 'main', fqdns: ['site-1277834673.se'], autoDeploy: true }], deployments: { web: [{ id: 1, commit: MAIN, status: 'finished' as const, pullRequestId: 0 }] } }
  const SKIP = '    /admin/: skipped (CMS admin shell, third-party editor fonts)'
  /** Pages / and /admin/; Google Fonts requested on `bad` only (Sveltia CMS's editor UI on /admin/). */
  function adminChecks(bad: string) {
    const asked: string[][] = []
    const c = checks({ fonts: (_b, p) => (asked.push(p), p.map((x) => fontsPage(x, x === bad ? { google: ['https://fonts.googleapis.com/css2?family=Merriweather+Sans'] } : {}))) })
    c.checks.pages = async () => ['/', '/admin/']
    return { ...c, asked }
  }

  test('post-merge: Google only on /admin/ passes, /admin/ skipped; on / it still fails', async () => {
    const c = adminChecks('/admin/')
    const r = await live(siteDir({ 'apps-fonts-selfhost.json': JSON.stringify(APPS), 'live-baseline-fonts-selfhost.txt': '' }), 'post-merge', SHA, { deps: liveDeps(c.checks, git().exec) })
    expect(r.status).toBe('pass')
    expect(c.asked).toEqual([['/']])
    expect(r.lines).toContain(SKIP)
    const bad = adminChecks('/')
    const failed = await live(siteDir({ 'apps-fonts-selfhost.json': JSON.stringify(APPS), 'live-baseline-fonts-selfhost.txt': '' }), 'post-merge', SHA, { deps: liveDeps(bad.checks, git().exec) })
    expect(failed.status).toBe('stop')
  })

  test('baseline: Google only on /admin/ passes and writes the baseline; on / it is a STOP', async () => {
    const c = adminChecks('/admin/')
    const dir = siteDir()
    const r = await live(dir, 'baseline', undefined, { deps: liveDeps(c.checks, git().exec, following.apps, following.deployments) })
    expect(r.status).toBe('pass')
    expect(r.lines).toContain(SKIP)
    expect(existsSync(join(dir, '.rollout/live-baseline-fonts-selfhost.txt'))).toBe(true)
    const bad = adminChecks('/')
    const stopped = await live(siteDir(), 'baseline', undefined, { deps: liveDeps(bad.checks, git().exec, following.apps, following.deployments) })
    expect(stopped).toMatchObject({ status: 'stop', reason: 'main self-hosts the fonts, but site-1277834673.se failed the fonts check live' })
  })
})

describe('merge on fonts-selfhost', () => {
  function mergeExec(o: { head?: string; headRefName?: string; otherBranch?: 'merged' | 'unmerged'; otherPr?: boolean } = {}) {
    const calls: string[] = []
    const exec: Exec = async (cmd, args) => {
      const line = [cmd, ...args].join(' ')
      calls.push(line)
      if (line === 'git rev-parse --abbrev-ref HEAD') return { code: 0, out: 'fonts-selfhost\n' }
      if (line === 'git remote get-url origin') return { code: 0, out: 'git@github.com:visionmediahq/site-1277834673.git\n' }
      if (line === 'git fetch origin main') return { code: 0, out: '' }
      if (line === 'git rev-parse HEAD') return { code: 0, out: `${o.head ?? HEAD}\n` }
      if (line === 'git rev-parse origin/main') return { code: 0, out: `${MAIN}\n` }
      if (line.startsWith('git merge-base --is-ancestor origin/main ')) return { code: 0, out: '' }
      if (line === 'gh pr view 7 -R visionmediahq/site-1277834673 --json state,headRefName') return { code: 0, out: JSON.stringify({ state: 'OPEN', headRefName: o.headRefName ?? 'fonts-selfhost' }) }
      if (line.startsWith('gh pr merge 7 ')) return { code: 0, out: '' }
      if (line === 'gh pr view 7 -R visionmediahq/site-1277834673 --json mergeCommit') return { code: 0, out: JSON.stringify({ mergeCommit: { oid: SHA } }) }
      if (line === 'git ls-remote --heads origin refs/heads/consent-banner') return { code: 0, out: o.otherBranch ? `${'d'.repeat(40)}\trefs/heads/consent-banner\n` : '' }
      if (line === 'git fetch -q origin main consent-banner') return { code: 0, out: '' }
      if (line === `git merge-base --is-ancestor ${'d'.repeat(40)} origin/main`) return { code: o.otherBranch === 'merged' ? 0 : 1, out: '' }
      if (line === 'gh pr list -R visionmediahq/site-1277834673 --head consent-banner --state open --json url,title')
        return { code: 0, out: JSON.stringify(o.otherPr ? [{ url: 'https://github.com/visionmediahq/site-1277834673/pull/3', title: 'Samtyckesbanner (astro-consent)' }] : []) }
      return { code: 1, out: `unexpected: ${line}` }
    }
    return { exec, calls }
  }
  const VERIFIED: VerifyResult = { pass: true, sha: HEAD, steps: [{ step: 1, name: 'lockfile', pass: true, evidence: '' }] }
  const PASS: LiveResult = { status: 'pass', lines: [], skipped: [], issues: [] }
  const apps: App[] = [{ uuid: 'web', name: 'Website', repo: 'site-1277834673', branch: 'main', fqdns: ['site-1277834673.se'], autoDeploy: true }]
  const deps = (exec: Exec, order: string[]) => ({
    exec,
    verify: async () => (order.push('verify'), VERIFIED),
    live: async (_d: string, mode: string, sha: string) => (order.push(`live ${mode} ${sha}`), PASS),
    listApps: async () => apps,
    deployments: async () => [{ id: 1, commit: MAIN, status: 'finished' as const, pullRequestId: 0 }],
  })
  const ready = () =>
    siteDir({
      'verify-fonts-selfhost.json': JSON.stringify(VERIFIED),
      'live-baseline-fonts-selfhost.txt': '',
      'live-baseline-hosts-fonts-selfhost.json': JSON.stringify({ hosts: ['site-1277834673.se'] }),
      // The banner's old state: never used for this flow.
      'verify.json': JSON.stringify({ pass: false, sha: null, steps: [] }),
    })

  test('squash merge of the verified fonts commit, branch deleted, the apps recorded per flow, live post-merge with the merge commit', async () => {
    const dir = ready()
    const g = mergeExec()
    const order: string[] = []
    const r = await merge(dir, 7, { deps: deps(g.exec, order) })
    expect(r).toMatchObject({ status: 'done', mergeCommit: SHA })
    expect(order).toEqual([`live post-merge ${SHA}`])
    expect(g.calls).toContain(`gh pr merge 7 -R visionmediahq/site-1277834673 --squash --delete-branch --match-head-commit ${HEAD}`)
    const rec = JSON.parse(readFileSync(join(dir, '.rollout/apps-fonts-selfhost.json'), 'utf8')) as RecordedApps
    expect(rec.apps.map((a) => [a.uuid, a.autoDeploy])).toEqual([['web', true]])
    expect(existsSync(join(dir, '.rollout/apps.json'))).toBe(false)
  })

  test('refused while origin has an unmerged consent-banner branch or an open consent-banner PR; a merged one is no obstacle', async () => {
    for (const [o, why] of [
      [{ otherBranch: 'unmerged' }, /origin has a consent-banner branch \(ddddddd\) that is not in origin\/main/],
      [{ otherPr: true }, /open consent-banner PR https:\/\/github\.com\/visionmediahq\/site-1277834673\/pull\/3/],
    ] as const) {
      const g = mergeExec(o)
      const r = await merge(ready(), 7, { deps: deps(g.exec, []) })
      expect(r.status).toBe('stop')
      expect(r.reason).toMatch(why)
      expect(g.calls.some((c) => c.startsWith('gh pr merge'))).toBe(false)
    }
    expect((await merge(ready(), 7, { deps: deps(mergeExec({ otherBranch: 'merged' }).exec, []) })).status).toBe('done')
  })

  test("a PR from consent-banner, or the banner's baseline only: STOP, nothing merged", async () => {
    const g = mergeExec({ headRefName: 'consent-banner' })
    const r = await merge(ready(), 7, { deps: deps(g.exec, []) })
    expect(r).toMatchObject({ status: 'stop', reason: 'PR #7 is from consent-banner, not fonts-selfhost' })
    const legacy = siteDir({ 'live-baseline.txt': '', 'live-baseline-hosts.json': JSON.stringify({ hosts: ['site-1277834673.se'] }) })
    const h = mergeExec()
    expect(await merge(legacy, 7, { deps: deps(h.exec, []) })).toMatchObject({ status: 'stop', reason: '.rollout/live-baseline-fonts-selfhost.txt not found: run the live baseline before the merge' })
    expect([...g.calls, ...h.calls].some((c) => c.startsWith('gh pr merge'))).toBe(false)
  })
})
