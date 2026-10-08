import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { openPr, originRepo, renderBody, templateKind, TEMPLATE_PATH, TITLE } from '../../../ci/rollout/pr'
import type { Report, VerifyResult } from '../../../ci/rollout/types'

const DEMO = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/demo-report.json'), 'utf8')) as Report
const template = readFileSync(TEMPLATE_PATH, 'utf8')
const report = (over: Partial<Report> = {}): Report => ({ ...DEMO, site: 'kund', domains: ['kund.se'], ...over })
const HEAD = 'b'.repeat(40)
const PASS: VerifyResult = {
  pass: true,
  sha: HEAD,
  steps: ['lockfile', 'build', 'requests', 'consent-paths', 'clip', 'contrast', 'screenshots', 'docker'].map((name, i) => ({
    step: i + 1,
    name,
    pass: true,
    evidence: 'SECRET-EVIDENCE-TEXT',
  })),
}
const render = (over: { classification?: 'maps' | 'notice' } = {}, issues: string[] = [], screenshots: { file: string; url: string }[] = []) =>
  renderBody(template, { kind: over.classification ?? 'maps', verify: PASS, issues, domain: 'kund.se', screenshots })

describe('renderBody', () => {
  test('has the four sections; nothing addressed to the client (clients already know the banner is coming)', () => {
    for (const classification of ['notice', 'maps'] as const) {
      const body = render({ classification })
      for (const h of ['Vad ändras', 'Så testar du', 'Relaterade ärenden', 'Kontroller']) expect(body).toMatch(new RegExp(`^## ${h}$`, 'm'))
      expect(body).not.toMatch(/Till kunden|kunden/i)
    }
  })

  test('notice and maps wording differ; maps mentions the maps and "Visa Google Maps"', () => {
    const notice = render({ classification: 'notice' })
    const maps = render({ classification: 'maps' })
    expect(maps).toContain('Visa Google Maps')
    expect(maps).toMatch(/kartorna/i)
    expect(notice).not.toContain('Visa Google Maps')
    expect(notice).not.toMatch(/kartorna/i)
    expect(notice).not.toBe(maps)
  })

  test('issues are listed as links, none gives "Inga"', () => {
    const body = render({}, ['https://github.com/visionmediahq/kund/issues/3', 'https://github.com/visionmediahq/kund/issues/4'])
    expect(body).toContain('- https://github.com/visionmediahq/kund/issues/3\n- https://github.com/visionmediahq/kund/issues/4')
    expect(render()).toMatch(/Relaterade ärenden\n\nInga/)
  })

  test('no placeholder or conditional marker is left', () => {
    for (const classification of ['notice', 'maps'] as const) {
      const body = render({ classification }, ['https://x/1'], [{ file: 'a.png', url: 'https://x/a.png' }])
      expect(body).not.toMatch(/\{\{|\}\}/)
    }
  })

  test('the domain, step results and screenshot links appear; evidence text does not', () => {
    const body = render({}, [], [{ file: 'home-360-open.png', url: 'https://github.com/o/r/blob/main/kund/home-360-open.png' }])
    expect(body).toContain('https://kund.se')
    expect(body).toContain('lockfile')
    expect(body).toContain('[home-360-open.png](https://github.com/o/r/blob/main/kund/home-360-open.png)')
    expect(body).not.toContain('SECRET-EVIDENCE-TEXT')
  })

  test('a failed verify is refused', () => {
    expect(() => renderBody(template, { kind: 'maps', verify: { ...PASS, pass: false }, issues: [], domain: 'kund.se' })).toThrow(/verify/)
  })

  test('finding 7: the merge line matches the process: the tool merges after the live check', () => {
    for (const classification of ['notice', 'maps'] as const) {
      const body = render({ classification })
      expect(body).toContain('**Mergas efter verifiering och livekontroll.**')
      expect(body).not.toContain('Mergas av tekniker')
    }
  })
})

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function siteDir(verifyResult: VerifyResult = PASS): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.rollout/shots'), { recursive: true })
  writeFileSync(join(dir, '.rollout/report.json'), JSON.stringify(report({ classification: 'maps' })))
  writeFileSync(join(dir, '.rollout/verify.json'), JSON.stringify(verifyResult))
  writeFileSync(join(dir, '.rollout/shots/home-360-open.png'), 'png')
  writeFileSync(join(dir, '.rollout/shots/home-1280-open.png'), 'png')
  return dir
}

type Answer = { code: number; out: string }
function fake(answers: Record<string, Answer | (() => Answer)> = {}) {
  const calls: string[] = []
  const defaults: Record<string, Answer> = {
    'git rev-parse --abbrev-ref HEAD': { code: 0, out: 'consent-banner\n' },
    'git remote get-url origin': { code: 0, out: 'git@github.com:visionmediahq/kund.git\n' },
    'git rev-parse HEAD': { code: 0, out: `${HEAD}\n` },
    'git fetch origin main': { code: 0, out: '' },
    'git merge-base --is-ancestor origin/main HEAD': { code: 0, out: '' },
    'git diff --name-only origin/main...HEAD': { code: 0, out: 'src/layouts/Base.astro\nsrc/data/privacy.json\n' },
    'gh pr list': { code: 0, out: '[]' },
    'git show HEAD:src/data/privacy.json': { code: 0, out: '{ "services": ["google-maps"] }\n' },
    'gh pr create': { code: 0, out: 'https://github.com/visionmediahq/kund/pull/9\n' },
  }
  const exec = async (cmd: string, args: string[]): Promise<Answer> => {
    const line = `${cmd} ${args.join(' ')}`
    calls.push(line)
    const key = Object.keys({ ...defaults, ...answers })
      .filter((k) => line.startsWith(k))
      .sort((a, b) => b.length - a.length)[0]
    if (!key) return { code: 0, out: '' }
    const a = (answers as Record<string, Answer | (() => Answer)>)[key] ?? defaults[key]!
    return typeof a === 'function' ? a() : a
  }
  return { exec, calls }
}

const opts = (f: ReturnType<typeof fake>, extra: Record<string, unknown> = {}) => ({
  exec: f.exec,
  issues: [],
  screenshotsDir: 'docs/rollout/2026-10-06-astro-consent/kund',
  screenshotsBase: 'https://github.com/visionmediahq/site-factory/blob/main/docs/rollout/2026-10-06-astro-consent/kund',
  verify: async () => PASS,
  ...extra,
})

describe('openPr', () => {
  test('creates the PR with title, head, base and repo, from the rendered body', async () => {
    const dir = siteDir()
    const f = fake()
    const r = await openPr(dir, opts(f))
    expect(r.url).toBe('https://github.com/visionmediahq/kund/pull/9')
    const create = f.calls.find((c) => c.startsWith('gh pr create'))!
    expect(create).toContain(`-t ${TITLE}`)
    expect(TITLE).toBe('Samtyckesbanner (astro-consent 1.0)')
    expect(create).toContain('-R visionmediahq/kund')
    expect(create).toContain('-H consent-banner')
    expect(create).toContain('-B main')
    const body = readFileSync(join(dir, '.rollout/pr-body.md'), 'utf8')
    expect(body).toContain('Visa Google Maps')
    expect(body).toContain('src/layouts/Base.astro')
    expect(body).toContain('docs/rollout/2026-10-06-astro-consent/kund/home-360-open.png')
  })

  test('returns the screenshots to copy, from .rollout/shots to the destination folder', async () => {
    const dir = siteDir()
    const r = await openPr(dir, opts(fake()))
    expect(r.files.map((x) => x.to).sort()).toEqual([
      'docs/rollout/2026-10-06-astro-consent/kund/home-1280-open.png',
      'docs/rollout/2026-10-06-astro-consent/kund/home-360-open.png',
    ])
    expect(r.files.every((x) => x.from.startsWith(join(dir, '.rollout/shots')))).toBe(true)
  })

  test('an open PR from consent-banner is returned instead of a new one', async () => {
    const f = fake({ 'gh pr list': { code: 0, out: JSON.stringify([{ url: 'https://github.com/visionmediahq/kund/pull/5', title: TITLE }]) } })
    const r = await openPr(siteDir(), opts(f))
    expect(r.url).toBe('https://github.com/visionmediahq/kund/pull/5')
    expect(f.calls.some((c) => c.startsWith('gh pr create'))).toBe(false)
  })

  test('up to date but verify.json is for another commit: verify runs again', async () => {
    let verifies = 0
    const dir = siteDir({ ...PASS, sha: 'c'.repeat(40) })
    await openPr(dir, opts(fake(), { verify: async () => (verifies++, PASS) }))
    expect(verifies).toBe(1)
  })

  test('up to date but verify.json has no sha: verify runs again', async () => {
    let verifies = 0
    const { sha: _sha, ...noSha } = PASS
    await openPr(siteDir(noSha as VerifyResult), opts(fake(), { verify: async () => (verifies++, PASS) }))
    expect(verifies).toBe(1)
  })

  test('up to date, verify.json failed or missing: verify runs again', async () => {
    let verifies = 0
    const v = async () => (verifies++, PASS)
    await openPr(siteDir({ ...PASS, pass: false }), opts(fake(), { verify: v }))
    const dir = siteDir()
    rmSync(join(dir, '.rollout/verify.json'))
    await openPr(dir, opts(fake(), { verify: v }))
    expect(verifies).toBe(2)
  })

  test('up to date with origin/main: no rebase, no second verify', async () => {
    let verifies = 0
    const f = fake()
    await openPr(siteDir(), opts(f, { verify: async () => (verifies++, PASS) }))
    expect(verifies).toBe(0)
    expect(f.calls.some((c) => c.startsWith('git rebase'))).toBe(false)
  })

  test('behind origin/main: rebases, runs verify again, then opens the PR', async () => {
    let verifies = 0
    const f = fake({ 'git merge-base --is-ancestor origin/main HEAD': { code: 1, out: '' } })
    await openPr(siteDir(), opts(f, { verify: async () => (verifies++, PASS) }))
    expect(f.calls).toContain('git rebase origin/main')
    expect(verifies).toBe(1)
    expect(f.calls.findIndex((c) => c === 'git rebase origin/main')).toBeLessThan(f.calls.findIndex((c) => c.startsWith('gh pr create')))
  })

  test('a rebase conflict is aborted and fails, nothing is pushed or created', async () => {
    const f = fake({
      'git merge-base --is-ancestor origin/main HEAD': { code: 1, out: '' },
      'git rebase origin/main': { code: 1, out: 'CONFLICT' },
    })
    await expect(openPr(siteDir(), opts(f))).rejects.toThrow(/rebase/)
    expect(f.calls).toContain('git rebase --abort')
    expect(f.calls.some((c) => c.startsWith('git push') || c.startsWith('gh pr create'))).toBe(false)
  })

  test('a verify that fails after the rebase fails the PR', async () => {
    const f = fake({ 'git merge-base --is-ancestor origin/main HEAD': { code: 1, out: '' } })
    await expect(openPr(siteDir(), opts(f, { verify: async () => ({ ...PASS, pass: false }) }))).rejects.toThrow(/verify/)
    expect(f.calls.some((c) => c.startsWith('gh pr create'))).toBe(false)
  })

  test('a failed or missing verify.json fails', async () => {
    const failing = async () => ({ ...PASS, pass: false })
    await expect(openPr(siteDir({ ...PASS, pass: false }), opts(fake(), { verify: failing }))).rejects.toThrow(/verify/)
    const dir = siteDir()
    rmSync(join(dir, '.rollout/verify.json'))
    await expect(openPr(dir, opts(fake(), { verify: failing }))).rejects.toThrow(/verify/)
  })

  test('refuses another branch and a foreign origin', async () => {
    await expect(openPr(siteDir(), opts(fake({ 'git rev-parse --abbrev-ref HEAD': { code: 0, out: 'main\n' } })))).rejects.toThrow(/consent-banner/)
    await expect(openPr(siteDir(), opts(fake({ 'git remote get-url origin': { code: 0, out: 'git@github.com:other/kund.git\n' } })))).rejects.toThrow(/visionmediahq/)
  })

  test('finding 2: an open PR from consent-banner with another title is not ours: refused, nothing created', async () => {
    const f = fake({ 'gh pr list': { code: 0, out: JSON.stringify([{ url: 'https://github.com/visionmediahq/kund/pull/5', title: 'WIP: cookie banner' }]) } })
    await expect(openPr(siteDir(), opts(f))).rejects.toThrow(/pull\/5[\s\S]*WIP: cookie banner/)
    expect(f.calls.some((c) => c.startsWith('gh pr create'))).toBe(false)
    expect(f.calls.find((c) => c.startsWith('gh pr list'))).toContain('--json url,title')
  })

  test('finding 4 (Ruling 40): the template block comes from the branch privacy.json, so a hand-wired needs-human site gets a PR', async () => {
    for (const [privacy, maps] of [
      ['{ "services": ["google-maps"], "policy_url": "https://kund.se/integritet" }', true],
      ['{ "services": [] }', false],
    ] as const) {
      const dir = siteDir()
      writeFileSync(join(dir, '.rollout/report.json'), JSON.stringify(report({ classification: 'needs-human', reasons: ['several layouts and no single shared one: a, b'] })))
      const f = fake({ 'git show HEAD:src/data/privacy.json': { code: 0, out: privacy } })
      expect((await openPr(dir, opts(f))).url).toBe('https://github.com/visionmediahq/kund/pull/9')
      const body = readFileSync(join(dir, '.rollout/pr-body.md'), 'utf8')
      expect(body.includes('Visa Google Maps'), privacy).toBe(maps)
    }
  })

  test('finding 4: a maps report but a branch privacy.json without google-maps gets the notice text', async () => {
    const dir = siteDir()
    await openPr(dir, opts(fake({ 'git show HEAD:src/data/privacy.json': { code: 0, out: '{"services":[]}' } })))
    expect(readFileSync(join(dir, '.rollout/pr-body.md'), 'utf8')).not.toContain('Visa Google Maps')
  })

  test('finding 4: no privacy.json on the branch, or one that is not JSON: refused', async () => {
    for (const answer of [{ code: 128, out: "fatal: path 'src/data/privacy.json' does not exist in 'HEAD'" }, { code: 0, out: '{ services' }]) {
      const f = fake({ 'git show HEAD:src/data/privacy.json': answer })
      await expect(openPr(siteDir(), opts(f))).rejects.toThrow(/privacy\.json/)
      expect(f.calls.some((c) => c.startsWith('gh pr create'))).toBe(false)
    }
  })

  test('finding 4: a needs-human site still needs a passing verify of HEAD', async () => {
    const dir = siteDir({ ...PASS, pass: false })
    writeFileSync(join(dir, '.rollout/report.json'), JSON.stringify(report({ classification: 'needs-human' })))
    const f = fake()
    await expect(openPr(dir, opts(f, { verify: async () => ({ ...PASS, pass: false }) }))).rejects.toThrow(/verify/)
    expect(f.calls.some((c) => c.startsWith('gh pr create'))).toBe(false)
  })

  test('templateKind: google-maps listed → maps, else notice', () => {
    expect(templateKind('{"services":["google-maps","youtube"]}')).toBe('maps')
    expect(templateKind('{"services":["youtube"]}')).toBe('notice')
    expect(templateKind('{}')).toBe('notice')
    expect(() => templateKind('[]')).toThrow(/privacy\.json/)
  })

  test('finding 10: originRepo refuses a URL that only contains github.com/visionmediahq', () => {
    expect(originRepo('git@github.com:visionmediahq/kund.git')).toBe('visionmediahq/kund')
    expect(originRepo('https://github.com/visionmediahq/kund')).toBe('visionmediahq/kund')
    expect(() => originRepo('https://evil/github.com/visionmediahq/x')).toThrow(/visionmediahq/)
  })

  test('a gh failure is reported', async () => {
    const f = fake({ 'gh pr create': { code: 1, out: 'boom' } })
    await expect(openPr(siteDir(), opts(f))).rejects.toThrow(/boom/)
  })
})

describe('parsePrArgs', () => {
  test('dir, shots options and repeated --issue', async () => {
    const { parsePrArgs } = await import('../../../ci/rollout/run')
    expect(parsePrArgs(['s', '--shots-dir', 'd', '--shots-base', 'b', '--issue', 'u1', '--issue', 'u2'])).toEqual({
      dir: 's',
      issues: ['u1', 'u2'],
      shotsDir: 'd',
      shotsBase: 'b',
    })
    expect(() => parsePrArgs(['s'])).toThrow(/--shots-dir/)
  })
})
