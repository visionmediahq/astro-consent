import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { openPr, renderBody, TEMPLATE_PATH, TITLE } from '../../../ci/rollout/pr'
import type { Report, VerifyResult } from '../../../ci/rollout/types'

const DEMO = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/demo-report.json'), 'utf8')) as Report
const template = readFileSync(TEMPLATE_PATH, 'utf8')
const report = (over: Partial<Report> = {}): Report => ({ ...DEMO, site: 'kund', domains: ['kund.se'], ...over })
const PASS: VerifyResult = {
  pass: true,
  steps: ['lockfile', 'build', 'requests', 'consent-paths', 'clip', 'contrast', 'screenshots', 'docker'].map((name, i) => ({
    step: i + 1,
    name,
    pass: true,
    evidence: 'SECRET-EVIDENCE-TEXT',
  })),
}
const render = (over: Partial<Report> = {}, issues: string[] = [], screenshots: { file: string; url: string }[] = []) =>
  renderBody(template, { report: report(over), verify: PASS, issues, domain: 'kund.se', screenshots })

describe('renderBody', () => {
  test('has the five sections', () => {
    const body = render({ classification: 'notice' })
    for (const h of ['Vad ändras', 'Så testar du', 'Till kunden', 'Relaterade ärenden', 'Kontroller']) expect(body).toMatch(new RegExp(`^## ${h}$`, 'm'))
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
    expect(() => renderBody(template, { report: report(), verify: { ...PASS, pass: false }, issues: [], domain: 'kund.se' })).toThrow(/verify/)
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
    'git fetch origin main': { code: 0, out: '' },
    'git merge-base --is-ancestor origin/main HEAD': { code: 0, out: '' },
    'git diff --name-only origin/main...HEAD': { code: 0, out: 'src/layouts/Base.astro\nsrc/data/privacy.json\n' },
    'gh pr list': { code: 0, out: '[]' },
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
    const f = fake({ 'gh pr list': { code: 0, out: '[{"url":"https://github.com/visionmediahq/kund/pull/5"}]' } })
    const r = await openPr(siteDir(), opts(f))
    expect(r.url).toBe('https://github.com/visionmediahq/kund/pull/5')
    expect(f.calls.some((c) => c.startsWith('gh pr create'))).toBe(false)
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
    await expect(openPr(siteDir({ ...PASS, pass: false }), opts(fake()))).rejects.toThrow(/verify/)
    const dir = siteDir()
    rmSync(join(dir, '.rollout/verify.json'))
    await expect(openPr(dir, opts(fake()))).rejects.toThrow(/verify/)
  })

  test('refuses another branch and a foreign origin', async () => {
    await expect(openPr(siteDir(), opts(fake({ 'git rev-parse --abbrev-ref HEAD': { code: 0, out: 'main\n' } })))).rejects.toThrow(/consent-banner/)
    await expect(openPr(siteDir(), opts(fake({ 'git remote get-url origin': { code: 0, out: 'git@github.com:other/kund.git\n' } })))).rejects.toThrow(/visionmediahq/)
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
