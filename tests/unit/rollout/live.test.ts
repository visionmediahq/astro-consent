import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { ConsentPathResult } from '../../../ci/rollout/checks/consent-paths'
import type { ContrastRow } from '../../../ci/rollout/checks/contrast'
import type { RequestResult } from '../../../ci/rollout/checks/requests'
import type { App, Deployment } from '../../../ci/rollout/coolify'
import type { Exec } from '../../../ci/rollout/lib/exec'
import { decodeBaseline, encodeBaseline, issueTitle, type LiveChecks, type LiveResult, live, type RecordedApps } from '../../../ci/rollout/live'
import { merge } from '../../../ci/rollout/merge'
import type { Report, VerifyResult } from '../../../ci/rollout/types'

const DEMO = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/demo-report.json'), 'utf8')) as Report
const SHA = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const MAIN = 'c'.repeat(40)

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function siteDir(
  opts: { baseline?: string | null; apps?: RecordedApps | null; verify?: VerifyResult; site?: string; domains?: string[]; baselined?: string[] | null } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'live-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.rollout'), { recursive: true })
  const report: Report = { ...DEMO, site: opts.site ?? 'nhrk', domains: opts.domains ?? ['nhrk.se'], classification: 'maps' }
  writeFileSync(join(dir, '.rollout/report.json'), JSON.stringify(report))
  if (opts.baseline !== null) writeFileSync(join(dir, '.rollout/live-baseline.txt'), opts.baseline ?? '')
  if (opts.baseline !== null && opts.baselined !== null) {
    writeFileSync(join(dir, '.rollout/live-baseline-hosts.json'), JSON.stringify({ hosts: opts.baselined ?? report.domains }))
  }
  if (opts.apps) writeFileSync(join(dir, '.rollout/apps.json'), JSON.stringify(opts.apps))
  if (opts.verify) writeFileSync(join(dir, '.rollout/verify.json'), JSON.stringify(opts.verify))
  return dir
}

const app = (uuid: string, fqdns: string[], autoDeploy: boolean, over: Partial<App> = {}) => ({
  uuid,
  name: uuid,
  repo: 'nhrk',
  branch: 'main',
  fqdns,
  autoDeploy,
  lastDeployed: autoDeploy ? MAIN : 'e'.repeat(40),
  ...over,
})
const NHRK: RecordedApps = { head: MAIN, apps: [app('web', ['nhrk.se', 'www.nhrk.se'], true), app('cms', ['nhrk.vmedia.se'], false)] }

const req = (path: string, over: Partial<RequestResult> = {}): RequestResult => ({
  path,
  banner: true,
  banners: 1,
  blocked: [],
  errors: [],
  known: [],
  ok: true,
  ...over,
})
const row = (over: Partial<ContrastRow> = {}): ContrastRow => ({
  path: '/',
  kind: 'banner',
  button: 'Neka',
  ratio: 7,
  ok: true,
  fg: { r: 255, g: 255, b: 255 },
  bg: { r: 0, g: 0, b: 0 },
  ...over,
})
const paths = (path: string, over: Partial<ConsentPathResult> = {}): ConsentPathResult => ({
  path,
  visaLoadsOnlyClicked: true,
  rememberAutoShows: true,
  nekaLoadsNothing: true,
  filterKept: null,
  filter: 'none',
  openHref: null,
  notes: [],
  ...over,
})

/** Fake browser checks: `requests` answers from `answers` in turn (the last one repeats). */
function fakeChecks(answers: ((base: string, paths: string[]) => RequestResult[])[] = [(_, p) => p.map((x) => req(x))]) {
  const calls: { what: string; base: string; paths: string[]; baseline?: Set<string>; expectBanner?: (path: string) => boolean }[] = []
  let n = 0
  const checks: LiveChecks = {
    pages: async (base) => (calls.push({ what: 'pages', base, paths: [] }), ['/', '/kontakt', '/finns-inte-x']),
    embedPages: async (_base, p) => p.filter((x) => x === '/kontakt'),
    requests: async (base, p, opts) => {
      calls.push({ what: 'requests', base, paths: p, baseline: opts.baseline, ...(opts.expectBanner ? { expectBanner: opts.expectBanner } : {}) })
      return answers[Math.min(n++, answers.length - 1)]!(base, p)
    },
    consentPaths: async (base, p) => (calls.push({ what: 'consentPaths', base, paths: p }), p.map((x) => paths(x))),
    contrast: async (base, p) => (calls.push({ what: 'contrast', base, paths: p }), p.map((x) => row({ path: x }))),
    close: async () => undefined,
  }
  return { checks, calls }
}

/** Fake exec for gh: `issues` is what `gh issue list` answers. */
function fakeGh(issues: { title: string; url: string }[] = []) {
  const calls: string[][] = []
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') return { code: 0, out: JSON.stringify(issues) }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'create') return { code: 0, out: 'https://github.com/visionmediahq/nhrk/issues/99\n' }
    const line = [cmd, ...args].join(' ')
    if (line === 'git fetch origin main') return { code: 0, out: '' }
    if (line === 'git rev-parse origin/main') return { code: 0, out: `${MAIN}\n` }
    if (line === 'git remote get-url origin') return { code: 0, out: 'git@github.com:visionmediahq/nhrk.git\n' }
    return { code: 1, out: `unexpected ${cmd} ${args.join(' ')}` }
  }
  return { exec, calls }
}

function deps(
  o: {
    checks?: LiveChecks
    exec?: Exec
    deploy?: (a: App, sha: string) => Promise<'finished' | 'failed' | 'cancelled' | 'timeout'>
    listApps?: () => Promise<App[]>
    deployments?: (uuid: string) => Promise<Deployment[]>
  } = {},
) {
  const sleeps: number[] = []
  const waited: string[] = []
  return {
    sleeps,
    waited,
    deps: {
      checks: async () => o.checks ?? fakeChecks().checks,
      exec: o.exec ?? fakeGh().exec,
      sleep: async (ms: number) => void sleeps.push(ms),
      waitDeployed: async (a: App, sha: string) => (waited.push(`${a.uuid}@${sha}`), o.deploy ? o.deploy(a, sha) : 'finished'),
      listApps: o.listApps ?? (async () => []),
      deployments: o.deployments ?? (async () => []),
    },
  }
}

describe('baseline encoding', () => {
  test('one error per line, the domain\'s host as a placeholder, newlines kept', () => {
    const text = encodeBaseline([
      { host: 'nhrk.se', errors: ['Failed to load https://nhrk.se/x.js', 'Error: a\nb'] },
      { host: 'www.nhrk.se', errors: ['Failed to load https://www.nhrk.se/x.js'] },
    ])
    expect(text.trimEnd().split('\n')).toHaveLength(2)
    expect(decodeBaseline(text, 'www.nhrk.se')).toEqual(new Set(['Failed to load https://www.nhrk.se/x.js', 'Error: a\nb']))
  })
})

describe('live baseline', () => {
  test('writes the console baseline and returns red when the live site has no banner', async () => {
    const dir = siteDir({ baseline: null, domains: ['nhrk.se'] })
    const { checks, calls } = fakeChecks([(base, p) => p.map((x) => req(x, { banner: false, banners: 0, ok: false, errors: [`Failed to load ${base}/a.js`] }))])
    const d = deps({ checks })
    const r = await live(dir, 'baseline', undefined, { deps: d.deps })
    expect(r.status).toBe('red')
    expect(readFileSync(join(dir, '.rollout/live-baseline.txt'), 'utf8')).toBe('Failed to load https://{host}/a.js\n')
    expect(calls.filter((c) => c.what === 'requests').map((c) => c.base)).toEqual(['https://nhrk.se'])
    expect(calls.some((c) => c.what === 'consentPaths')).toBe(false)
    expect(d.sleeps).toEqual([])
  })

  test('finding 5 (Ruling 37): baselines report.domains and every host of the Coolify apps that follow main, and records them', async () => {
    const dir = siteDir({ baseline: null, domains: ['nhrk.se'] })
    const { checks, calls } = fakeChecks([(base, p) => p.map((x) => req(x, { banner: false, ok: false, errors: [`Failed to load ${base}/a.js`] }))])
    const apps: App[] = [
      { uuid: 'web', name: 'Website', repo: 'nhrk', branch: 'main', fqdns: ['nhrk.se', 'www.nhrk.se'], autoDeploy: true },
      { uuid: 'cms', name: 'CMS', repo: 'nhrk', branch: 'main', fqdns: ['nhrk.vmedia.se'], autoDeploy: true },
      { uuid: 'stg', name: 'Staging', repo: 'nhrk', branch: 'staging', fqdns: ['stg.nhrk.se'], autoDeploy: true },
      { uuid: 'other', name: 'Other', repo: 'annan', branch: 'main', fqdns: ['annan.se'], autoDeploy: true },
    ]
    const deployments: Record<string, Deployment[]> = {
      web: [{ id: 2, commit: MAIN, status: 'finished', pullRequestId: 0 }],
      cms: [{ id: 1, commit: 'e'.repeat(40), status: 'finished', pullRequestId: 0 }],
      stg: [{ id: 3, commit: MAIN, status: 'finished', pullRequestId: 0 }],
      other: [{ id: 4, commit: MAIN, status: 'finished', pullRequestId: 0 }],
    }
    const d = deps({ checks, listApps: async () => apps, deployments: async (uuid) => deployments[uuid] ?? [] })
    const r = await live(dir, 'baseline', undefined, { deps: d.deps })
    expect(r.status).toBe('red')
    expect(calls.filter((c) => c.what === 'requests').map((c) => c.base)).toEqual(['https://nhrk.se', 'https://www.nhrk.se'])
    expect(JSON.parse(readFileSync(join(dir, '.rollout/live-baseline-hosts.json'), 'utf8'))).toEqual({
      head: MAIN,
      hosts: ['nhrk.se', 'www.nhrk.se'],
      apps: [{ uuid: 'web', name: 'Website', fqdns: ['nhrk.se', 'www.nhrk.se'] }],
    })
    expect(readFileSync(join(dir, '.rollout/live-baseline.txt'), 'utf8')).toBe('Failed to load https://{host}/a.js\n')
  })

  test('finding 5: Coolify unreadable → stop, no baseline written', async () => {
    const dir = siteDir({ baseline: null })
    const d = deps({
      listApps: async () => {
        throw new Error('Coolify GET /api/v1/applications answered 401')
      },
    })
    const r = await live(dir, 'baseline', undefined, { deps: d.deps })
    expect(r.status).toBe('stop')
    expect(r.reason).toMatch(/401/)
    expect(existsSync(join(dir, '.rollout/live-baseline.txt'))).toBe(false)
    expect(existsSync(join(dir, '.rollout/live-baseline-hosts.json'))).toBe(false)
  })

  test('finding 3: CMS admin pages expect no banner and do not stop the site being "already green"', async () => {
    const dir = siteDir({ baseline: null })
    const { checks, calls } = fakeChecks([(_, p) => p.map((x) => req(x, { banner: x !== '/admin/' }))])
    checks.pages = async () => ['/', '/admin/', '/finns-inte-x']
    const r = await live(dir, 'baseline', undefined, { deps: deps({ checks }).deps })
    expect(r.status).toBe('pass')
    const expectBanner = calls.find((c) => c.what === 'requests')!.expectBanner!
    expect(['/', '/admin/', '/admin', '/finns-inte-x'].map(expectBanner)).toEqual([true, false, false, true])
  })

  test('a live site that already shows the banner and requests nothing is noted, not red', async () => {
    const dir = siteDir({ baseline: null })
    const r = await live(dir, 'baseline', undefined, { deps: deps().deps })
    expect(r.status).toBe('pass')
    expect(r.lines.join('\n')).toMatch(/already green/)
  })
})

describe('live post-merge', () => {
  test('CASE non-autoDeploy app → issue opened and its domains skipped; only following apps are waited for and checked', async () => {
    const dir = siteDir({ apps: NHRK, baseline: 'Failed to load https://{host}/a.js\n' })
    const { checks, calls } = fakeChecks()
    const gh = fakeGh()
    const d = deps({ checks, exec: gh.exec })
    const r = await live(dir, 'post-merge', SHA, { deps: d.deps })
    expect(r.status).toBe('pass')
    expect(d.waited).toEqual([`web@${SHA}`])
    expect(r.skipped).toEqual(['nhrk.vmedia.se'])
    const create = gh.calls.find((c) => c[1] === 'issue' && c[2] === 'create')!
    expect(create).toBeDefined()
    expect(create).toContain('visionmediahq/nhrk')
    expect(create[create.indexOf('-t') + 1]).toBe('nhrk.vmedia.se redeployar inte från main')
    expect(issueTitle('nhrk.vmedia.se')).toBe('nhrk.vmedia.se redeployar inte från main')
    expect(r.issues).toEqual(['https://github.com/visionmediahq/nhrk/issues/99'])
    const bases = [...new Set(calls.map((c) => c.base))]
    expect(bases).toEqual(['https://nhrk.se', 'https://www.nhrk.se'])
    const first = calls.find((c) => c.what === 'requests')!
    expect(first.baseline).toEqual(new Set(['Failed to load https://nhrk.se/a.js']))
    // consent paths on map pages, contrast over the pages
    expect(calls.find((c) => c.what === 'consentPaths')!.paths).toEqual(['/kontakt'])
    expect(calls.find((c) => c.what === 'contrast')!.paths).toEqual(['/', '/kontakt', '/finns-inte-x'])
    expect(existsSync(join(dir, '.rollout/live-post-merge.json'))).toBe(true)
  })

  test('finding 3: post-merge checks CMS admin pages without expecting a banner and leaves them out of the consent paths', async () => {
    const dir = siteDir({ apps: { head: MAIN, apps: [app('web', ['nhrk.se'], true)] } })
    const { checks, calls } = fakeChecks()
    checks.pages = async () => ['/', '/kontakt', '/admin/', '/finns-inte-x']
    checks.embedPages = async (_b, p) => p.filter((x) => x === '/kontakt' || x === '/admin/')
    const r = await live(dir, 'post-merge', SHA, { deps: deps({ checks }).deps })
    expect(r.status).toBe('pass')
    const expectBanner = calls.find((c) => c.what === 'requests')!.expectBanner!
    expect(expectBanner('/admin/')).toBe(false)
    expect(expectBanner('/kontakt')).toBe(true)
    expect(calls.find((c) => c.what === 'consentPaths')!.paths).toEqual(['/kontakt'])
  })

  test('an open issue with the same title is not opened again', async () => {
    const dir = siteDir({ apps: NHRK })
    const gh = fakeGh([
      { title: 'nhrk.vmedia.se redeployar inte från main (gammal)', url: 'https://github.com/visionmediahq/nhrk/issues/1' },
      { title: 'nhrk.vmedia.se redeployar inte från main', url: 'https://github.com/visionmediahq/nhrk/issues/61' },
    ])
    const r = await live(dir, 'post-merge', SHA, { deps: deps({ exec: gh.exec }).deps })
    expect(r.status).toBe('pass')
    expect(gh.calls.some((c) => c[2] === 'create')).toBe(false)
    expect(r.issues).toEqual(['https://github.com/visionmediahq/nhrk/issues/61'])
    expect(r.skipped).toEqual(['nhrk.vmedia.se'])
  })

  test('CASE check fails then passes after 30 s → pass', async () => {
    const dir = siteDir({ apps: { head: MAIN, apps: [app('web', ['nhrk.se'], true)] } })
    const { checks } = fakeChecks([(_, p) => p.map((x) => req(x, { banner: false, ok: false })), (_, p) => p.map((x) => req(x))])
    const d = deps({ checks })
    const r = await live(dir, 'post-merge', SHA, { deps: d.deps })
    expect(r.status).toBe('pass')
    expect(d.sleeps).toEqual([30_000])
  })

  test('CASE check fails twice → stop with a reason', async () => {
    const dir = siteDir({ apps: { head: MAIN, apps: [app('web', ['nhrk.se'], true)] } })
    const { checks } = fakeChecks([(_, p) => p.map((x) => req(x, { blocked: ['https://maps.google.com/x'], ok: false }))])
    const d = deps({ checks })
    const r = await live(dir, 'post-merge', SHA, { deps: d.deps })
    expect(r.status).toBe('stop')
    expect(r.reason).toMatch(/nhrk\.se/)
    expect(d.sleeps).toEqual([30_000])
  })

  test('a failing contrast row or consent path fails the check too', async () => {
    const dir = siteDir({ apps: { head: MAIN, apps: [app('web', ['nhrk.se'], true)] } })
    const { checks } = fakeChecks()
    checks.contrast = async (_b, p) => p.map((x) => row({ path: x, ratio: 3.2, ok: false }))
    expect((await live(dir, 'post-merge', SHA, { deps: deps({ checks }).deps })).status).toBe('stop')
    const c2 = fakeChecks().checks
    c2.consentPaths = async (_b, p) => p.map((x) => paths(x, { nekaLoadsNothing: false }))
    expect((await live(dir, 'post-merge', SHA, { deps: deps({ checks: c2 }).deps })).status).toBe('stop')
  })

  test('a failed, cancelled or timed-out deployment stops before any check', async () => {
    for (const status of ['failed', 'cancelled', 'timeout'] as const) {
      const dir = siteDir({ apps: NHRK })
      const { checks, calls } = fakeChecks()
      const r = await live(dir, 'post-merge', SHA, { deps: deps({ checks, deploy: async () => status }).deps })
      expect(r.status).toBe('stop')
      expect(r.reason).toContain(status)
      expect(calls).toEqual([])
    }
  })

  test('without the apps recorded before the merge, or without a baseline, it stops', async () => {
    expect((await live(siteDir({}), 'post-merge', SHA, { deps: deps().deps })).reason).toMatch(/apps\.json/)
    expect((await live(siteDir({ apps: NHRK, baseline: null }), 'post-merge', SHA, { deps: deps().deps })).reason).toMatch(/live-baseline/)
  })
})

/** Fake git and gh for merge. `moved`: origin/main is not an ancestor of the verified commit. */
function mergeExec(o: { moved?: boolean; head: { sha: string }; rebaseFails?: boolean; state?: string }) {
  const calls: string[] = []
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`
    calls.push(line)
    if (line === 'git rev-parse --abbrev-ref HEAD') return { code: 0, out: 'consent-banner\n' }
    if (line === 'git remote get-url origin') return { code: 0, out: 'git@github.com:visionmediahq/nhrk.git\n' }
    if (line === 'git fetch origin main') return { code: 0, out: '' }
    if (line === 'git rev-parse HEAD') return { code: 0, out: `${o.head.sha}\n` }
    if (line === 'git rev-parse origin/main') return { code: 0, out: `${MAIN}\n` }
    if (line.startsWith('git merge-base --is-ancestor origin/main ')) return { code: o.moved && line.endsWith(HEAD) ? 1 : 0, out: '' }
    if (line === 'git rebase origin/main') return o.rebaseFails ? { code: 1, out: 'CONFLICT' } : { code: 0, out: '' }
    if (line === 'git rebase --abort') return { code: 0, out: '' }
    if (line.startsWith('gh pr view 7 -R visionmediahq/nhrk --json state,headRefName'))
      return { code: 0, out: JSON.stringify({ state: o.state ?? 'OPEN', headRefName: 'consent-banner' }) }
    if (line.startsWith('gh pr merge 7 ')) return { code: 0, out: '' }
    if (line === 'gh pr view 7 -R visionmediahq/nhrk --json mergeCommit') return { code: 0, out: JSON.stringify({ mergeCommit: { oid: SHA } }) }
    return { code: 1, out: `unexpected: ${line}` }
  }
  return { exec, calls }
}

const VERIFIED = (sha: string): VerifyResult => ({ pass: true, sha, steps: [{ step: 1, name: 'lockfile', pass: true, evidence: '' }] })
const LIVE_PASS: LiveResult = { status: 'pass', lines: [], skipped: [], issues: [] }

function mergeDeps(exec: Exec, head: { sha: string }) {
  const order: string[] = []
  const deployments: Record<string, Deployment[]> = {
    web: [{ id: 2, commit: MAIN, status: 'finished', pullRequestId: 0 }],
    cms: [{ id: 1, commit: 'e'.repeat(40), status: 'finished', pullRequestId: 0 }],
  }
  const apps: App[] = [
    { uuid: 'web', name: 'Website', repo: 'nhrk', branch: 'main', fqdns: ['nhrk.se'], autoDeploy: true },
    { uuid: 'cms', name: 'CMS', repo: 'nhrk', branch: 'main', fqdns: ['nhrk.vmedia.se'], autoDeploy: true },
    { uuid: 'stg', name: 'Staging', repo: 'nhrk', branch: 'staging', fqdns: ['stg.nhrk.se'], autoDeploy: true },
  ]
  return {
    order,
    deps: {
      exec: async (cmd: string, args: string[], cwd?: string) => {
        if (cmd === 'gh' && args[1] === 'merge') order.push('gh pr merge')
        return exec(cmd, args, cwd)
      },
      verify: async () => {
        order.push('verify')
        head.sha = 'f'.repeat(40)
        return VERIFIED(head.sha)
      },
      live: async (_dir: string, mode: string, sha?: string) => (order.push(`live ${mode} ${sha}`), LIVE_PASS),
      listApps: async () => apps,
      deployments: async (uuid: string) => deployments[uuid] ?? [],
    },
  }
}

describe('merge', () => {
  test('CASE main moved before merge → rebase and re-verify run before gh pr merge', async () => {
    const head = { sha: HEAD }
    const dir = siteDir({ verify: VERIFIED(HEAD), apps: null })
    const g = mergeExec({ moved: true, head })
    const m = mergeDeps(g.exec, head)
    const r = await merge(dir, 7, { deps: m.deps })
    expect(r.status).toBe('done')
    expect(g.calls).toContain('git rebase origin/main')
    expect(m.order).toEqual(['verify', 'gh pr merge', `live post-merge ${SHA}`])
    const mergeCall = g.calls.find((c) => c.startsWith('gh pr merge'))!
    expect(mergeCall).toContain(`--match-head-commit ${'f'.repeat(40)}`)
  })

  test('main unmoved and HEAD verified: no re-verify; squash merge, branch deleted, merge commit to live', async () => {
    const head = { sha: HEAD }
    const dir = siteDir({ verify: VERIFIED(HEAD) })
    const g = mergeExec({ head })
    const m = mergeDeps(g.exec, head)
    const r = await merge(dir, 7, { deps: m.deps })
    expect(r).toMatchObject({ status: 'done', mergeCommit: SHA })
    expect(m.order).toEqual(['gh pr merge', `live post-merge ${SHA}`])
    expect(g.calls.find((c) => c.startsWith('gh pr merge'))).toBe(`gh pr merge 7 -R visionmediahq/nhrk --squash --delete-branch --match-head-commit ${HEAD}`)
  })

  test('records before the merge which apps follow main (Ruling 14)', async () => {
    const head = { sha: HEAD }
    const dir = siteDir({ verify: VERIFIED(HEAD) })
    const g = mergeExec({ head })
    await merge(dir, 7, { deps: mergeDeps(g.exec, head).deps })
    const rec = JSON.parse(readFileSync(join(dir, '.rollout/apps.json'), 'utf8')) as RecordedApps
    expect(rec.head).toBe(MAIN)
    expect(rec.apps.map((a) => [a.uuid, a.autoDeploy, a.lastDeployed])).toEqual([
      ['web', true, MAIN],
      ['cms', false, 'e'.repeat(40)],
    ])
  })

  test('a verify.json of another commit means verify again before merging', async () => {
    const head = { sha: HEAD }
    const dir = siteDir({ verify: VERIFIED('9'.repeat(40)) })
    const g = mergeExec({ head })
    const m = mergeDeps(g.exec, head)
    expect((await merge(dir, 7, { deps: m.deps })).status).toBe('done')
    expect(m.order[0]).toBe('verify')
  })

  test('stops without merging: no live baseline, a rebase conflict, a failing verify, a PR not open, no app following main, a following host without baseline', async () => {
    const cases: [Parameters<typeof siteDir>[0], Parameters<typeof mergeExec>[0], RegExp, ((d: ReturnType<typeof mergeDeps>['deps']) => void)?][] = [
      [{ verify: VERIFIED(HEAD), baseline: null }, { head: { sha: HEAD } }, /live baseline/],
      [{ verify: VERIFIED(HEAD) }, { head: { sha: HEAD }, moved: true, rebaseFails: true }, /rebase/],
      [{ verify: VERIFIED(HEAD) }, { head: { sha: HEAD }, moved: true }, /verify/, (d) => (d.verify = async () => ({ ...VERIFIED(HEAD), pass: false }))],
      [{ verify: VERIFIED(HEAD) }, { head: { sha: HEAD }, state: 'MERGED' }, /MERGED/],
      [{ verify: VERIFIED(HEAD) }, { head: { sha: HEAD } }, /nothing would deploy/, (d) => (d.deployments = async () => [])],
      // Ruling 36/37: an app that follows main serves a host the live baseline did not record.
      [
        { verify: VERIFIED(HEAD) },
        { head: { sha: HEAD } },
        /www\.nhrk\.se[\s\S]*live <dir> baseline/,
        (d) => {
          const listApps = d.listApps
          d.listApps = async () => (await listApps()).map((a) => (a.uuid === 'web' ? { ...a, fqdns: ['nhrk.se', 'www.nhrk.se'] } : a))
        },
      ],
      // Ruling 37: a baseline from before the hosts were recorded.
      [{ verify: VERIFIED(HEAD), baselined: null }, { head: { sha: HEAD } }, /live-baseline-hosts\.json[\s\S]*live <dir> baseline/],
    ]
    for (const [site, git, reason, tweak] of cases) {
      const dir = siteDir(site)
      const g = mergeExec(git)
      const m = mergeDeps(g.exec, git.head)
      tweak?.(m.deps)
      const r = await merge(dir, 7, { deps: m.deps })
      expect(r.status).toBe('stop')
      expect(r.reason).toMatch(reason)
      expect(g.calls.some((c) => c.startsWith('gh pr merge'))).toBe(false)
    }
  })

  test('finding 5 (Ruling 37): a following host outside report.domains that the baseline recorded does not stop the merge', async () => {
    const head = { sha: HEAD }
    const dir = siteDir({ verify: VERIFIED(HEAD), domains: ['nhrk.se'], baselined: ['nhrk.se', 'www.nhrk.se'] })
    const g = mergeExec({ head })
    const m = mergeDeps(g.exec, head)
    const listApps = m.deps.listApps
    m.deps.listApps = async () => (await listApps()).map((a) => (a.uuid === 'web' ? { ...a, fqdns: ['nhrk.se', 'www.nhrk.se'] } : a))
    expect((await merge(dir, 7, { deps: m.deps })).status).toBe('done')
  })

  test('finding 8: a merge commit that cannot be read names the post-merge rerun', async () => {
    const head = { sha: HEAD }
    const dir = siteDir({ verify: VERIFIED(HEAD) })
    const g = mergeExec({ head })
    const exec: Exec = async (cmd, args, cwd) =>
      [cmd, ...args].join(' ') === 'gh pr view 7 -R visionmediahq/nhrk --json mergeCommit' ? { code: 1, out: 'HTTP 502' } : g.exec(cmd, args, cwd)
    const m = mergeDeps(exec, head)
    const r = await merge(dir, 7, { deps: m.deps })
    expect(r.status).toBe('stop')
    expect(r.reason).toContain('rerun `live <dir> post-merge --sha <merge commit>`')
  })

  test('a failing live check after the merge is a stop', async () => {
    const head = { sha: HEAD }
    const dir = siteDir({ verify: VERIFIED(HEAD) })
    const g = mergeExec({ head })
    const m = mergeDeps(g.exec, head)
    m.deps.live = async () => ({ status: 'stop', reason: 'nhrk.se failed twice', lines: [], skipped: [], issues: [] })
    expect(await merge(dir, 7, { deps: m.deps })).toMatchObject({ status: 'stop', reason: 'nhrk.se failed twice', mergeCommit: SHA })
  })
})
