import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  currentFlow,
  FLOWS,
  flowOf,
  FONTS_MARKER,
  fontsCssAt,
  isFlowBranch,
  isToolFontsCss,
  openPrsFrom,
  readStatePath,
  stateName,
  statePath,
  STEPS,
} from '../../../ci/rollout/flows'
import type { Exec } from '../../../ci/rollout/lib/exec'
import { FONTS_BRANCH } from '../../../ci/rollout/wire/fonts'
import { BRANCH } from '../../../ci/rollout/wire/index'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const rolloutDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'flows-'))
  dirs.push(d)
  mkdirSync(join(d, '.rollout'))
  return join(d, '.rollout')
}
const answer = (map: Record<string, { code: number; out: string }>): Exec => async (cmd, args) => map[[cmd, ...args].join(' ')] ?? { code: 1, out: 'unexpected' }

describe('FLOWS', () => {
  test('one flow per branch: consent-banner and fonts-selfhost, each refusing the other', () => {
    expect(Object.keys(FLOWS)).toEqual([BRANCH, FONTS_BRANCH])
    expect(FLOWS['consent-banner']).toMatchObject({ branch: 'consent-banner', other: 'fonts-selfhost', title: 'Samtyckesbanner (astro-consent)' })
    expect(FLOWS['fonts-selfhost']).toMatchObject({ branch: 'fonts-selfhost', other: 'consent-banner', title: 'Google Fonts från sajten själv' })
    expect(FLOWS['consent-banner'].ownTitles).toContain('Samtyckesbanner (astro-consent 1.0)')
    expect(FLOWS['consent-banner'].template).toMatch(/pr-body\.sv\.md$/)
    expect(FLOWS['fonts-selfhost'].template).toMatch(/pr-body\.fonts\.sv\.md$/)
  })

  test('steps: the numbering is shared; consent-banner runs all but fonts (fonts when self-hosted), fonts-selfhost skips the banner-only 4 and 6', () => {
    expect(STEPS).toEqual(['lockfile', 'build', 'requests', 'consent-paths', 'clip', 'contrast', 'screenshots', 'fonts', 'docker'])
    expect(STEPS.filter((s) => !FLOWS['consent-banner'].steps.includes(s))).toEqual(['fonts'])
    expect(STEPS.filter((s) => !FLOWS['fonts-selfhost'].steps.includes(s))).toEqual(['consent-paths', 'contrast'])
    for (const flow of Object.values(FLOWS)) expect(flow.steps).toEqual(STEPS.filter((s) => flow.steps.includes(s)))
  })
})

describe('branch detection', () => {
  test('flowOf: a FLOWS branch, else an error naming the stage, both branches and the checkout', () => {
    expect(flowOf('fonts-selfhost', 'verify', '/x').branch).toBe('fonts-selfhost')
    expect(isFlowBranch('consent-banner')).toBe(true)
    expect(isFlowBranch('feature/consent-banner')).toBe(false)
    expect(() => flowOf('main', 'pr', '/x')).toThrow('pr runs on branch consent-banner or fonts-selfhost; /x is on main')
    expect(() => flowOf('', 'merge', '/x')).toThrow(/is on \(unknown\)/)
  })

  test('currentFlow reads git rev-parse --abbrev-ref HEAD; a failing git is an unknown branch', async () => {
    expect((await currentFlow(answer({ 'git rev-parse --abbrev-ref HEAD': { code: 0, out: 'fonts-selfhost\n' } }), '/x', 'live')).branch).toBe('fonts-selfhost')
    await expect(currentFlow(answer({}), '/x', 'live')).rejects.toThrow(/live runs on branch .*is on \(unknown\)/)
  })
})

describe('state files', () => {
  test('per branch: verify.json → verify-<branch>.json, evidence → evidence-<branch>', () => {
    expect(stateName('verify.json', 'fonts-selfhost')).toBe('verify-fonts-selfhost.json')
    expect(stateName('pushed.txt', 'consent-banner')).toBe('pushed-consent-banner.txt')
    expect(stateName('live-baseline-hosts.json', 'fonts-selfhost')).toBe('live-baseline-hosts-fonts-selfhost.json')
    expect(stateName('evidence', 'fonts-selfhost')).toBe('evidence-fonts-selfhost')
    expect(statePath('/s/.rollout', 'apps.json', 'consent-banner')).toBe('/s/.rollout/apps-consent-banner.json')
  })

  test('fallback: consent-banner reads the name used before the flows when its own file is missing; fonts-selfhost never does', () => {
    const r = rolloutDir()
    writeFileSync(join(r, 'verify.json'), '{}')
    writeFileSync(join(r, 'pushed.txt'), 'a\n')
    mkdirSync(join(r, 'shots'))
    expect(readStatePath(r, 'verify.json', 'consent-banner')).toBe(join(r, 'verify.json'))
    expect(readStatePath(r, 'pushed.txt', 'consent-banner')).toBe(join(r, 'pushed.txt'))
    expect(readStatePath(r, 'shots', 'consent-banner')).toBe(join(r, 'shots'))
    // The banner's old verify.json is never read as a fonts verify.
    expect(readStatePath(r, 'verify.json', 'fonts-selfhost')).toBe(join(r, 'verify-fonts-selfhost.json'))
    // Once the flow's own file exists, it wins.
    writeFileSync(join(r, 'verify-consent-banner.json'), '{}')
    expect(readStatePath(r, 'verify.json', 'consent-banner')).toBe(join(r, 'verify-consent-banner.json'))
    // Neither: the flow's own name (where the stage will write).
    expect(readStatePath(r, 'apps.json', 'consent-banner')).toBe(join(r, 'apps-consent-banner.json'))
  })
})

describe('the fonts commit', () => {
  test('isToolFontsCss: only a fonts.css with the header this tool writes', () => {
    expect(isToolFontsCss(`/*\n * Generated from https://fonts.googleapis.com/css2?family=X\n * on 2026-10-19 ${FONTS_MARKER}: …\n */`)).toBe(true)
    expect(isToolFontsCss('@font-face { font-family: X; src: url(/x.woff2) }')).toBe(false)
    expect(isToolFontsCss(null)).toBe(false)
  })

  test('fontsCssAt: git show <ref>:src/styles/fonts.css, null when missing or not ours', async () => {
    const ours = `/* ${FONTS_MARKER} */`
    expect(await fontsCssAt(answer({ 'git show origin/main:src/styles/fonts.css': { code: 0, out: ours } }), '/x', 'origin/main')).toBe(ours)
    expect(await fontsCssAt(answer({ 'git show HEAD:src/styles/fonts.css': { code: 0, out: '/* hand-written */' } }), '/x', 'HEAD')).toBeNull()
    expect(await fontsCssAt(answer({}), '/x', 'HEAD')).toBeNull()
  })

  test('openPrsFrom: gh pr list for the branch; a failing gh throws instead of answering none', async () => {
    const exec = answer({ 'gh pr list -R visionmediahq/k --head fonts-selfhost --state open --json url,title': { code: 0, out: '[{"url":"u","title":"t"}]' } })
    expect(await openPrsFrom(exec, '/x', 'visionmediahq/k', 'fonts-selfhost')).toEqual([{ url: 'u', title: 't' }])
    await expect(openPrsFrom(answer({}), '/x', 'visionmediahq/k', 'consent-banner')).rejects.toThrow(/whether a consent-banner PR is open is unknown/)
  })
})
