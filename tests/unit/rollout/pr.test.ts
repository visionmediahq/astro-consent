import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { ServiceSlug } from '../../../src/services'
import { FLOWS } from '../../../ci/rollout/flows'
import { openPr, originRepo, renderBody, templateKind, TEMPLATE_PATH, TITLE } from '../../../ci/rollout/pr'
import type { Report, VerifyResult } from '../../../ci/rollout/types'

const DEMO = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/demo-report.json'), 'utf8')) as Report
const template = readFileSync(TEMPLATE_PATH, 'utf8')
const report = (over: Partial<Report> = {}): Report => ({ ...DEMO, site: 'kund', domains: ['kund.se'], ...over })
const HEAD = 'b'.repeat(40)
const TOOL_SHA = '0123456789abcdef0123456789abcdef01234567'
const PASS: VerifyResult = {
  pass: true,
  sha: HEAD,
  tool: { sha: TOOL_SHA, dirty: false },
  steps: ['lockfile', 'build', 'requests', 'consent-paths', 'clip', 'contrast', 'screenshots', 'docker'].map((name, i) => ({
    step: i + 1,
    name,
    pass: true,
    evidence: 'SECRET-EVIDENCE-TEXT',
  })),
}
const render = (
  over: { classification?: 'consent' | 'notice'; services?: ServiceSlug[] } = {},
  issues: string[] = [],
  screenshots: { file: string; url: string }[] = [],
) => renderBody(template, { kind: over.classification ?? 'consent', services: over.services ?? ['google-maps'], verify: PASS, issues, domain: 'kund.se', screenshots })

describe('renderBody', () => {
  test('Kontroller names the tool commit of the verify run, and says when it had uncommitted changes', () => {
    expect(render()).toContain('Kontrollerat lokalt med `ci/rollout` (astro-consent @ 0123456):\n')
    const body = (tool: VerifyResult['tool']) => {
      const { tool: _t, ...rest } = PASS
      return renderBody(template, { kind: 'consent', services: ['google-maps'], verify: tool === undefined ? rest : { ...rest, tool }, issues: [], domain: 'kund.se' })
    }
    expect(body({ sha: TOOL_SHA, dirty: true })).toContain('Kontrollerat lokalt med `ci/rollout` (astro-consent @ 0123456, med ändringar som inte är incheckade):\n')
    // A verify.json stored before the tool was recorded, or git failing.
    expect(body(undefined)).toContain('Kontrollerat lokalt med `ci/rollout` (astro-consent, okänd version):\n')
    expect(body({ sha: null, dirty: null })).toContain('(astro-consent, okänd version):')
  })

  test('has the four sections; nothing addressed to the client (clients already know the banner is coming)', () => {
    for (const classification of ['notice', 'consent'] as const) {
      const body = render({ classification })
      for (const h of ['Vad ändras', 'Så testar du', 'Relaterade ärenden', 'Kontroller']) expect(body).toMatch(new RegExp(`^## ${h}$`, 'm'))
      expect(body).not.toMatch(/Till kunden|kunden/i)
    }
  })

  test('notice and consent wording differ; consent names the service and "Visa Google Maps"', () => {
    const notice = render({ classification: 'notice', services: [] })
    const consent = render({ classification: 'consent' })
    expect(consent).toContain('Google Maps')
    expect(consent).toContain('Visa Google Maps')
    expect(consent).toContain('Visa alltid innehåll från Google Maps')
    expect(consent).toContain('platshållarna')
    expect(notice).not.toContain('Visa Google Maps')
    expect(notice).not.toBe(consent)
  })

  test('consent names each service, one numbered step each, in registry order', () => {
    const body = render({ services: ['google-maps', 'elfsight'] })
    expect(body).toContain('Google Maps och Elfsight')
    expect(body).toContain('`google-maps`, `elfsight`')
    expect(body).toMatch(/^3\. .*Visa Google Maps/m)
    expect(body).toMatch(/^4\. .*Visa Elfsight[\s\S]*Visa alltid innehåll från Elfsight/m)
    expect(body).toMatch(/^5\. .*Cookie-inställningar/m)
    const only = render({ services: ['elfsight'] })
    expect(only).toContain('Visa Elfsight')
    expect(only).toContain('Visa alltid innehåll från Elfsight')
    expect(only).not.toContain('Google Maps')
    expect(render({ services: ['google-calendar'] })).toContain('Visa Google Kalender')
    expect(body).not.toMatch(/\b1\.0\b/)
    expect(body).not.toContain('{{#maps}}')
  })

  test('issues are listed as links, none gives "Inga"', () => {
    const body = render({}, ['https://github.com/visionmediahq/kund/issues/3', 'https://github.com/visionmediahq/kund/issues/4'])
    expect(body).toContain('- https://github.com/visionmediahq/kund/issues/3\n- https://github.com/visionmediahq/kund/issues/4')
    expect(render()).toMatch(/Relaterade ärenden\n\nInga/)
  })

  test('no placeholder or conditional marker is left', () => {
    for (const classification of ['notice', 'consent'] as const) {
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
    expect(() => renderBody(template, { kind: 'consent', services: ['google-maps'], verify: { ...PASS, pass: false }, issues: [], domain: 'kund.se' })).toThrow(/verify/)
  })

  test('finding 7: the merge line matches the process: the tool merges after the live check', () => {
    for (const classification of ['notice', 'consent'] as const) {
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
  writeFileSync(join(dir, '.rollout/report.json'), JSON.stringify(report({ classification: 'consent' })))
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

const BANNER_GOLDEN = join(import.meta.dirname, 'fixtures/pr-body/consent-banner.md.txt')

describe('openPr', () => {
  test('creates the PR with title, head, base and repo, from the rendered body; the body matches the golden file', async () => {
    const dir = siteDir()
    const f = fake()
    const r = await openPr(dir, opts(f))
    expect(r.url).toBe('https://github.com/visionmediahq/kund/pull/9')
    const body = readFileSync(join(dir, '.rollout/pr-body.md'), 'utf8')
    if (process.env['UPDATE_GOLDEN']) writeFileSync(BANNER_GOLDEN, body)
    expect(body).toBe(readFileSync(BANNER_GOLDEN, 'utf8'))
    const create = f.calls.find((c) => c.startsWith('gh pr create'))!
    expect(create).toContain(`-t ${TITLE}`)
    // No version (#51): the range wire installs changes with each release, the diff shows it.
    expect(TITLE).toBe('Samtyckesbanner (astro-consent)')
    expect(create).toContain('-R visionmediahq/kund')
    expect(create).toContain('-H consent-banner')
    expect(create).toContain('-B main')
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
    const f = fake({ 'gh pr list -R visionmediahq/kund --head consent-banner': { code: 0, out: JSON.stringify([{ url: 'https://github.com/visionmediahq/kund/pull/5', title: TITLE }]) } })
    const r = await openPr(siteDir(), opts(f))
    expect(r.url).toBe('https://github.com/visionmediahq/kund/pull/5')
    expect(f.calls.some((c) => c.startsWith('gh pr create'))).toBe(false)
  })

  test('an open PR with the title the tool used before #51 is still ours: returned, nothing created', async () => {
    const f = fake({
      'gh pr list -R visionmediahq/kund --head consent-banner': { code: 0, out: JSON.stringify([{ url: 'https://github.com/visionmediahq/kund/pull/5', title: 'Samtyckesbanner (astro-consent 1.0)' }]) },
    })
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
    const f = fake({ 'gh pr list -R visionmediahq/kund --head consent-banner': { code: 0, out: JSON.stringify([{ url: 'https://github.com/visionmediahq/kund/pull/5', title: 'WIP: cookie banner' }]) } })
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

  test('a branch privacy.json listing elfsight and google-maps names both in the PR body', async () => {
    const dir = siteDir()
    await openPr(dir, opts(fake({ 'git show HEAD:src/data/privacy.json': { code: 0, out: '{"services":["elfsight","google-maps"]}' } })))
    const body = readFileSync(join(dir, '.rollout/pr-body.md'), 'utf8')
    expect(body).toContain('Google Maps och Elfsight')
    expect(body).toContain('Visa Elfsight')
    expect(body).not.toMatch(/\{\{/)
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

  test('templateKind: services listed → consent with them in registry order, none → notice', () => {
    expect(templateKind('{"services":["google-maps"]}')).toEqual({ kind: 'consent', services: ['google-maps'] })
    expect(templateKind('{"services":["elfsight","google-maps"]}')).toEqual({ kind: 'consent', services: ['google-maps', 'elfsight'] })
    expect(templateKind('{"services":[]}')).toEqual({ kind: 'notice', services: [] })
    expect(templateKind('{}')).toEqual({ kind: 'notice', services: [] })
    expect(() => templateKind('{"services":["google-maps","youtube"]}')).toThrow('unknown service youtube in privacy.json')
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

// ── fonts (site-factory#220) ─────────────────────────────────────────────────────────────────

const FONTS_CSS = `/*\n * Generated from https://fonts.googleapis.com/css2?family=Figtree&family=Oswald\n * on 2026-10-19 by the astro-consent rollout tool: Google's own faces, served from /fonts/.\n */\n/* latin */\n@font-face {\n  font-family: 'Figtree';\n  src: url(/fonts/figtree.woff2) format('woff2');\n}\n/* latin */\n@font-face {\n  font-family: 'Oswald';\n  src: url(/fonts/oswald.woff2) format('woff2');\n}\n`
const FONTS_FILES = 'public/fonts/LICENSE-figtree.txt\npublic/fonts/figtree.woff2\nsrc/layouts/Base.astro\nsrc/styles/fonts.css\nsrc/styles/global.css\n'
const GOLDEN = join(import.meta.dirname, 'fixtures/pr-body/fonts-selfhost.md.txt')
const FONTS_PASS: VerifyResult = {
  ...PASS,
  steps: ['lockfile', 'build', 'requests', 'consent-paths', 'clip', 'contrast', 'screenshots', 'fonts', 'docker'].map((name, i) => ({
    step: i + 1,
    name,
    pass: true,
    evidence: 'SECRET-EVIDENCE-TEXT',
    ...(name === 'consent-paths' || name === 'contrast' ? { skipped: true } : {}),
  })),
}

/** A clone on fonts-selfhost with its own verify file and shots; the banner's old state beside it. */
function fontsDir(): string {
  const dir = siteDir()
  writeFileSync(join(dir, '.rollout/verify.json'), JSON.stringify({ ...PASS, sha: 'c'.repeat(40) }))
  writeFileSync(join(dir, '.rollout/verify-fonts-selfhost.json'), JSON.stringify(FONTS_PASS))
  mkdirSync(join(dir, '.rollout/shots-fonts-selfhost'))
  writeFileSync(join(dir, '.rollout/shots-fonts-selfhost/home-1280-open.png'), 'png')
  return dir
}
const fontsFake = (more: Record<string, Answer> = {}) =>
  fake({
    'git rev-parse --abbrev-ref HEAD': { code: 0, out: 'fonts-selfhost\n' },
    'git diff --name-only origin/main...HEAD': { code: 0, out: FONTS_FILES },
    'git show HEAD:src/styles/fonts.css': { code: 0, out: FONTS_CSS },
    'git show HEAD:src/data/privacy.json': { code: 1, out: 'fatal: no privacy.json' },
    ...more,
  })

describe('openPr on fonts-selfhost', () => {
  test('the fonts PR: its title, -H fonts-selfhost, its own verify file, shots and body file; the body matches the golden file', async () => {
    const dir = fontsDir()
    const f = fontsFake()
    const noRerun = async (): Promise<VerifyResult> => {
      throw new Error('the stored fonts verify is for HEAD: no rerun')
    }
    const r = await openPr(dir, opts(f, { verify: noRerun }))
    expect(r.url).toBe('https://github.com/visionmediahq/kund/pull/9')
    expect(r.files.map((x) => x.to)).toEqual(['docs/rollout/2026-10-06-astro-consent/kund/home-1280-open.png'])
    const create = f.calls.find((c) => c.startsWith('gh pr create'))!
    expect(create).toContain('-H fonts-selfhost')
    expect(create).toContain('-t Google Fonts från sajten själv')
    expect(create).toContain(join(dir, '.rollout/pr-body-fonts-selfhost.md'))
    // The other flow's open PR is checked first.
    expect(f.calls).toContain('gh pr list -R visionmediahq/kund --head consent-banner --state open --json url,title')
    const body = readFileSync(join(dir, '.rollout/pr-body-fonts-selfhost.md'), 'utf8')
    if (process.env['UPDATE_GOLDEN']) writeFileSync(GOLDEN, body)
    expect(body).toBe(readFileSync(GOLDEN, 'utf8'))
    expect(body).not.toContain('SECRET-EVIDENCE-TEXT')
  })

  test('refused while a consent-banner PR is open (the two would conflict); nothing created', async () => {
    const f = fontsFake({ 'gh pr list -R visionmediahq/kund --head consent-banner': { code: 0, out: JSON.stringify([{ url: 'https://github.com/visionmediahq/kund/pull/3', title: TITLE }]) } })
    await expect(openPr(fontsDir(), opts(f))).rejects.toThrow('an open consent-banner PR (https://github.com/visionmediahq/kund/pull/3) would conflict with fonts-selfhost')
    expect(f.calls.some((c) => c.startsWith('gh pr create') || c.startsWith('git fetch'))).toBe(false)
  })

  test("refused without the tool's fonts.css on the branch", async () => {
    const f = fontsFake({ 'git show HEAD:src/styles/fonts.css': { code: 128, out: 'fatal: path does not exist' } })
    await expect(openPr(fontsDir(), opts(f))).rejects.toThrow(/src\/styles\/fonts\.css from this tool is not on the branch/)
  })

  test("an open fonts-selfhost PR with the flow's title is returned; another title is refused", async () => {
    const own = fontsFake({ 'gh pr list -R visionmediahq/kund --head fonts-selfhost': { code: 0, out: JSON.stringify([{ url: 'https://github.com/visionmediahq/kund/pull/11', title: 'Google Fonts från sajten själv' }]) } })
    expect((await openPr(fontsDir(), opts(own))).url).toBe('https://github.com/visionmediahq/kund/pull/11')
    const other = fontsFake({ 'gh pr list -R visionmediahq/kund --head fonts-selfhost': { code: 0, out: JSON.stringify([{ url: 'https://github.com/visionmediahq/kund/pull/12', title: 'fonts' }]) } })
    await expect(openPr(fontsDir(), opts(other))).rejects.toThrow(/pull\/12 "fonts" \(expected "Google Fonts från sajten själv"\)/)
  })

  test("the banner's verify.json is never read for fonts-selfhost: without its own, verify runs", async () => {
    const dir = fontsDir()
    rmSync(join(dir, '.rollout/verify-fonts-selfhost.json'))
    let verifies = 0
    await openPr(dir, opts(fontsFake(), { verify: async () => (verifies++, FONTS_PASS) }))
    expect(verifies).toBe(1)
  })
})

describe('openPr on consent-banner with the fonts commit', () => {
  test('the body gets the fonts paragraph and a test step numbered after the banner steps', async () => {
    const dir = siteDir()
    const f = fake({
      'git diff --name-only origin/main...HEAD': { code: 0, out: `src/data/privacy.json\n${FONTS_FILES}` },
      'git show HEAD:src/styles/fonts.css': { code: 0, out: FONTS_CSS },
    })
    await openPr(dir, opts(f))
    const body = readFileSync(join(dir, '.rollout/pr-body.md'), 'utf8')
    expect(body).toContain('- Typsnitten (Figtree och Oswald) laddas från sajten själv i stället för från Google Fonts, i en egen commit')
    expect(body).toMatch(/^4\. Klicka "Cookie-inställningar".*\n5\. Öppna webbläsarens nätverksflik och ladda om sidan: inga anrop till `fonts\.googleapis\.com`/m)
    expect(body).not.toMatch(/\{\{|\}\}/)
  })

  test('without the fonts commit: no fonts paragraph, fonts.css not even read', async () => {
    const dir = siteDir()
    const f = fake()
    await openPr(dir, opts(f))
    expect(readFileSync(join(dir, '.rollout/pr-body.md'), 'utf8')).not.toContain('Typsnitten')
    expect(f.calls.some((c) => c.includes('fonts.css'))).toBe(false)
  })

  test('refused while origin has a fonts-selfhost branch main does not contain; a merged one is no obstacle', async () => {
    const other = 'd'.repeat(40)
    const answers = (merged: boolean) => ({
      'git ls-remote --heads origin refs/heads/fonts-selfhost': { code: 0, out: `${other}\trefs/heads/fonts-selfhost\n` },
      [`git merge-base --is-ancestor ${other} origin/main`]: { code: merged ? 0 : 1, out: '' },
    })
    const f = fake(answers(false))
    await expect(openPr(siteDir(), opts(f))).rejects.toThrow(/origin has a fonts-selfhost branch \(ddddddd\) that is not in origin\/main/)
    expect(f.calls).toContain('git fetch -q origin main fonts-selfhost')
    expect(f.calls.some((c) => c.startsWith('gh pr create'))).toBe(false)
    expect((await openPr(siteDir(), opts(fake(answers(true))))).url).toBe('https://github.com/visionmediahq/kund/pull/9')
  })

  test('refused while a fonts-selfhost PR is open', async () => {
    const f = fake({ 'gh pr list -R visionmediahq/kund --head fonts-selfhost': { code: 0, out: JSON.stringify([{ url: 'https://github.com/visionmediahq/kund/pull/4', title: 'Google Fonts från sajten själv' }]) } })
    await expect(openPr(siteDir(), opts(f))).rejects.toThrow('an open fonts-selfhost PR (https://github.com/visionmediahq/kund/pull/4) would conflict with consent-banner')
  })

  test('renderBody: the notice block numbers the fonts step 4; the consent block after its services', () => {
    const fonts = { families: ['Figtree'] }
    expect(renderBody(template, { kind: 'notice', services: [], verify: PASS, issues: [], domain: 'kund.se', fonts })).toMatch(/^3\. Klicka "Cookie-inställningar"[^\n]*\n4\. Öppna webbläsarens nätverksflik/m)
    expect(renderBody(template, { kind: 'consent', services: ['google-maps', 'elfsight'], verify: PASS, issues: [], domain: 'kund.se', fonts })).toMatch(/^5\. Klicka "Cookie-inställningar"[^\n]*\n6\. Öppna webbläsarens nätverksflik/m)
  })
})

// ── Sentry's bundle (#93) ────────────────────────────────────────────────────────────────────

describe('the banner body with the Sentry commit', () => {
  test('renderBody: the paragraph names what the commit replaced, and the step comes last', () => {
    const jsd = renderBody(template, { kind: 'notice', services: [], verify: PASS, issues: [], domain: 'kund.se', sentry: { cdns: ['jsdelivr'], initBeforeBundle: false } })
    expect(jsd).toContain('- Skriptet för felrapporteringen (Sentry, som skickar fel till vår GlitchTip när sajtens `PUBLIC_GLITCHTIP_DSN` är satt) laddas från sajten själv, `/js/sentry-8.55.2.min.js`, i en egen commit. Inget syns på sidan. Den gamla adressen (`cdn.jsdelivr.net`) svarade 404')
    expect(jsd).not.toContain('Sentrys CDN i USA')
    expect(jsd).toMatch(/^3\. Klicka "Cookie-inställningar"[^\n]*\n4\. I nätverksfliken: inga anrop till `browser\.sentry-cdn\.com`/m)
    const cdn = renderBody(template, { kind: 'consent', services: ['google-maps'], verify: PASS, issues: [], domain: 'kund.se', fonts: { families: ['Figtree'] }, sentry: { cdns: ['sentry-cdn'], initBeforeBundle: false } })
    expect(cdn).toContain('Förut hämtades det från Sentrys CDN i USA (`browser.sentry-cdn.com`)')
    expect(cdn).not.toContain('svarade 404')
    expect(cdn).toMatch(/^5\. Öppna webbläsarens nätverksflik[^\n]*\n6\. I nätverksfliken: inga anrop/m)
  })

  test('the jsDelivr sentence claims nothing about the DSN; an init before the bundle gets its own true sentence (review of #126)', () => {
    const body = (initBeforeBundle: boolean) => renderBody(template, { kind: 'notice', services: [], verify: PASS, issues: [], domain: 'kund.se', sentry: { cdns: ['jsdelivr'], initBeforeBundle } })
    expect(body(false)).toContain('Den gamla adressen (`cdn.jsdelivr.net`) svarade 404, så felrapporteringen har inte fungerat.')
    expect(body(false)).not.toContain('börjar fungera')
    expect(body(false)).not.toContain('Sentry.init')
    expect(body(true)).toContain('Sajten startar felrapporteringen (`Sentry.init`) innan skriptet har laddats, så den fungerar inte heller nu')
  })

  test('without the commit nothing about Sentry is in the body', () => {
    expect(renderBody(template, { kind: 'notice', services: [], verify: PASS, issues: [], domain: 'kund.se' })).not.toMatch(/sentry/i)
  })

  test('openPr adds it when the branch changes the bundle file, with the CDNs from report.sentry', async () => {
    const dir = siteDir()
    const loader = { file: 'src/layouts/Base.astro', line: 9, cdn: 'jsdelivr', version: '8', url: 'x', kind: 'element', src: { start: 0, end: 1 }, cuts: [], initBeforeBundle: false }
    writeFileSync(join(dir, '.rollout/report.json'), JSON.stringify(report({ classification: 'consent', sentry: { status: 'wire', loaders: [loader], selfHosted: [], reasons: [], hints: [] } } as Partial<Report>)))
    const f = fake({ 'git diff --name-only origin/main...HEAD': { code: 0, out: 'public/js/sentry-8.55.2.min.js\nsrc/layouts/Base.astro\nsrc/data/privacy.json\n' } })
    await openPr(dir, opts(f))
    const body = readFileSync(join(dir, '.rollout/pr-body.md'), 'utf8')
    expect(body).toContain('laddas från sajten själv, `/js/sentry-8.55.2.min.js`')
    expect(body).toContain('svarade 404')
    expect(body).toContain('- `public/js/sentry-8.55.2.min.js`')
  })
})

describe('openPr on sentry-selfhost', () => {
  const SENTRY_GOLDEN = join(import.meta.dirname, 'fixtures/pr-body/sentry-selfhost.md.txt')
  const SENTRY_PASS: VerifyResult = {
    ...PASS,
    steps: ['lockfile', 'build', 'requests', 'consent-paths', 'clip', 'contrast', 'screenshots', 'fonts', 'docker'].map((name, i) => ({
      step: i + 1,
      name,
      pass: true,
      evidence: 'SECRET-EVIDENCE-TEXT',
      ...(['consent-paths', 'contrast', 'fonts'].includes(name) ? { skipped: true } : {}),
    })),
  }
  const sentryDir = (): string => {
    const dir = siteDir()
    const loader = (cdn: string) => ({ file: 'src/layouts/Base.astro', line: 9, cdn, version: '8.55.0', url: 'x', kind: 'element', src: { start: 0, end: 1 }, cuts: [], initBeforeBundle: false })
    writeFileSync(
      join(dir, '.rollout/report.json'),
      JSON.stringify(report({ classification: 'consent', sentry: { status: 'wire', loaders: [loader('sentry-cdn')], selfHosted: [], reasons: [], hints: [] } } as Partial<Report>)),
    )
    writeFileSync(join(dir, '.rollout/verify-sentry-selfhost.json'), JSON.stringify(SENTRY_PASS))
    mkdirSync(join(dir, '.rollout/shots-sentry-selfhost'))
    writeFileSync(join(dir, '.rollout/shots-sentry-selfhost/home-1280-open.png'), 'png')
    return dir
  }
  const sentryFake = (more: Record<string, Answer> = {}) =>
    fake({
      'git rev-parse --abbrev-ref HEAD': { code: 0, out: 'sentry-selfhost\n' },
      'git diff --name-only origin/main...HEAD': { code: 0, out: 'public/js/sentry-8.55.2.min.js\nsrc/layouts/Base.astro\n' },
      ...more,
    })

  test('its title, -H sentry-selfhost, its own verify file and body; the body matches the golden file', async () => {
    const dir = sentryDir()
    const f = sentryFake()
    const r = await openPr(dir, opts(f, { verify: async () => { throw new Error('the stored verify is for HEAD: no rerun') } }))
    expect(r.url).toBe('https://github.com/visionmediahq/kund/pull/9')
    const create = f.calls.find((c) => c.startsWith('gh pr create'))!
    expect(create).toContain('-H sentry-selfhost')
    expect(create).toContain('-t Felrapporteringens skript från sajten själv')
    for (const other of ['consent-banner', 'fonts-selfhost', 'astro-consent-update']) expect(f.calls).toContain(`gh pr list -R visionmediahq/kund --head ${other} --state open --json url,title`)
    const body = readFileSync(join(dir, '.rollout/pr-body-sentry-selfhost.md'), 'utf8')
    if (process.env['UPDATE_GOLDEN']) writeFileSync(SENTRY_GOLDEN, body)
    expect(body).toBe(readFileSync(SENTRY_GOLDEN, 'utf8'))
    expect(body).toContain('Sentrys CDN i USA')
    expect(body).not.toContain('svarade 404')
    expect(body).not.toContain('SECRET-EVIDENCE-TEXT')
  })

  test('the template: jsDelivr claims nothing about the DSN; an init before the bundle is said plainly (review of #127)', () => {
    const tpl = readFileSync(FLOWS['sentry-selfhost'].template, 'utf8')
    const body = (initBeforeBundle: boolean) => renderBody(tpl, { kind: 'sentry', services: [], verify: PASS, issues: [], domain: 'kund.se', sentry: { cdns: ['jsdelivr'], initBeforeBundle } })
    expect(body(false)).toContain('- Den gamla adressen (`cdn.jsdelivr.net`) svarade 404, så felrapporteringen har inte fungerat.\n')
    expect(body(false)).not.toContain('börjar fungera')
    expect(body(true)).toContain('- Sajten startar felrapporteringen (`Sentry.init`) innan skriptet har laddats, så den fungerar inte heller nu; det rättas i en separat ändring.')
  })

  test('refused without the bundle on the branch, or while another flow has an open PR', async () => {
    await expect(openPr(sentryDir(), opts(sentryFake({ 'git diff --name-only origin/main...HEAD': { code: 0, out: 'src/layouts/Base.astro\n' } })))).rejects.toThrow(
      'public/js/sentry-8.55.2.min.js is not on the branch: run.ts sentry first',
    )
    const f = sentryFake({ 'gh pr list -R visionmediahq/kund --head consent-banner': { code: 0, out: JSON.stringify([{ url: 'https://github.com/visionmediahq/kund/pull/3', title: TITLE }]) } })
    await expect(openPr(sentryDir(), opts(f))).rejects.toThrow('an open consent-banner PR (https://github.com/visionmediahq/kund/pull/3) would conflict with sentry-selfhost')
  })
})

// ── astro-consent-update ─────────────────────────────────────────────────────────────────────

const OLD = 'c258167ff9c28a92eab5f4b414e575701e9cebd3'
const NEW = '8128aec232f06065a139ba384f6fa623bb2527d4'
const lockAt = (version: string, sha: string) =>
  JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@visionmediahq/astro-consent': { version, resolved: `git+ssh://git@github.com/visionmediahq/astro-consent.git#${sha}` } } })
const UPDATE_GOLDEN = join(import.meta.dirname, 'fixtures/pr-body/astro-consent-update.md.txt')
const UPDATE_CHANGELOG = '# Changelog\n\n## 1.1.4\n\n- Fix: the toggles.\n\n## 1.1.3\n\n- Fix: the width.\n\n## 1.1.2\n\n- Old.\n\n## 1.1.0\n\n- `CONSENT_VERSION` 2.\n\n## 1.0.2\n\n- Older.\n'

/** A clone on astro-consent-update with its own verify file and shots. */
function updateDir(): string {
  const dir = siteDir()
  writeFileSync(join(dir, '.rollout/verify-astro-consent-update.json'), JSON.stringify(PASS))
  mkdirSync(join(dir, '.rollout/shots-astro-consent-update'))
  writeFileSync(join(dir, '.rollout/shots-astro-consent-update/home-360-open.png'), 'png')
  return dir
}
const updateFake = (from = '1.1.2', more: Record<string, Answer> = {}) =>
  fake({
    'git rev-parse --abbrev-ref HEAD': { code: 0, out: 'astro-consent-update\n' },
    'git diff --name-only origin/main...HEAD': { code: 0, out: 'package-lock.json\npackage.json\n' },
    'git show origin/main:package-lock.json': { code: 0, out: lockAt(from, OLD) },
    'git show HEAD:package-lock.json': { code: 0, out: lockAt('1.1.4', NEW) },
    'git show HEAD:src/data/privacy.json': { code: 1, out: 'never read on this flow' },
    ...more,
  })
const updateOpts = (f: ReturnType<typeof fake>, versions: Record<string, number> = { [OLD]: 2, [NEW]: 2 }, extra: Record<string, unknown> = {}) =>
  opts(f, { consentVersionAt: (sha: string) => versions[sha] ?? null, changelog: UPDATE_CHANGELOG, ...extra })

describe('openPr on astro-consent-update', () => {
  test('its title and branch, both other flows checked, its own files; the body matches the golden file', async () => {
    const dir = updateDir()
    const f = updateFake()
    const r = await openPr(dir, updateOpts(f))
    expect(r.url).toBe('https://github.com/visionmediahq/kund/pull/9')
    expect(r.files.map((x) => x.to)).toEqual(['docs/rollout/2026-10-06-astro-consent/kund/home-360-open.png'])
    const create = f.calls.find((c) => c.startsWith('gh pr create'))!
    expect(create).toContain('-H astro-consent-update')
    expect(create).toContain('-t Uppdatera astro-consent')
    expect(create).toContain(join(dir, '.rollout/pr-body-astro-consent-update.md'))
    expect(f.calls).toContain('gh pr list -R visionmediahq/kund --head consent-banner --state open --json url,title')
    expect(f.calls).toContain('gh pr list -R visionmediahq/kund --head fonts-selfhost --state open --json url,title')
    expect(f.calls.some((c) => c.includes('privacy.json'))).toBe(false)
    const body = readFileSync(join(dir, '.rollout/pr-body-astro-consent-update.md'), 'utf8')
    if (process.env['UPDATE_GOLDEN']) writeFileSync(UPDATE_GOLDEN, body)
    expect(body).toBe(readFileSync(UPDATE_GOLDEN, 'utf8'))
    expect(body).toContain('uppdateras från 1.1.2 till 1.1.4')
    expect(body).toMatch(/#### 1\.1\.4\n\n- Fix: the toggles\.\n\n#### 1\.1\.3\n\n- Fix: the width\./)
    expect(body).not.toContain('#### 1.1.2')
    expect(body).toContain('Ingen besökare får frågan igen')
    expect(body).not.toContain('Alla besökare får frågan')
    expect(body).not.toContain('SECRET-EVIDENCE-TEXT')
  })

  test('from 1.0.2 (CONSENT_VERSION 1 → 2): the body says every visitor is asked again, with a test step for it', async () => {
    const dir = updateDir()
    await openPr(dir, updateOpts(updateFake('1.0.2'), { [OLD]: 1, [NEW]: 2 }))
    const body = readFileSync(join(dir, '.rollout/pr-body-astro-consent-update.md'), 'utf8')
    expect(body).toContain('**Alla besökare får frågan om samtycke igen efter mergen.**')
    expect(body).toMatch(/^3\. Efter mergen, i en webbläsare där du redan gjort ett val på sajten: bannern visas igen\.$/m)
    expect(body).toContain('#### 1.1.0')
    expect(body).not.toContain('Ingen besökare får frågan igen')
  })

  test('refused when whether visitors are asked again is unknown, or the changelog has no entry for the new version', async () => {
    await expect(openPr(updateDir(), updateOpts(updateFake(), { [NEW]: 2 }))).rejects.toThrow(/CONSENT_VERSION could not be read at both commits/)
    await expect(openPr(updateDir(), updateOpts(updateFake(), undefined, { changelog: '# Changelog\n\n## 1.1.3\n\n- x\n' }))).rejects.toThrow(/CHANGELOG\.md has no entry for 1\.1\.4/)
  })

  test('refused while a consent-banner or fonts-selfhost PR is open', async () => {
    for (const other of ['consent-banner', 'fonts-selfhost']) {
      const f = updateFake('1.1.2', { [`gh pr list -R visionmediahq/kund --head ${other}`]: { code: 0, out: JSON.stringify([{ url: 'https://github.com/visionmediahq/kund/pull/5', title: 'x' }]) } })
      await expect(openPr(updateDir(), updateOpts(f))).rejects.toThrow(`an open ${other} PR (https://github.com/visionmediahq/kund/pull/5) would conflict with astro-consent-update`)
    }
  })
})
