// The astro-consent-update flow: a live site's lockfile moved to the latest release, on its own
// branch, one commit. The npm install and the GitHub lookups are injected; git is real.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { parseUpdateArgs, runUpdate } from '../../../ci/rollout/run'
import {
  changelogBetween,
  compareVersions,
  consentVersionOf,
  installedOf,
  RELEASE,
  UPDATE_BRANCH,
  updateCommitMessage,
  updateSpec,
  updateSummary,
} from '../../../ci/rollout/wire/update'

const PKG = '@visionmediahq/astro-consent'
const OLD_SHA = 'c258167ff9c28a92eab5f4b414e575701e9cebd3'
const NEW_SHA = '8128aec232f06065a139ba384f6fa623bb2527d4'
const resolved = (sha: string) => `git+ssh://git@github.com/visionmediahq/astro-consent.git#${sha}`
const spec = (range: string) => `github:visionmediahq/astro-consent#semver:${range}`

const pkgJson = (range: string) => `${JSON.stringify({ name: 'site', type: 'module', dependencies: { [PKG]: spec(range), astro: '^6.1.6' } }, null, 2)}\n`
const lockJson = (range: string, version: string, sha: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify(
    {
      name: 'site',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'site', dependencies: { [PKG]: spec(range), astro: '^6.1.6' } },
        'node_modules/astro': { version: '6.1.6', resolved: 'https://registry.npmjs.org/astro/-/astro-6.1.6.tgz' },
        [`node_modules/${PKG}`]: { version, resolved: resolved(sha), license: 'MIT', dependencies: { zod: '^4.6.5' } },
        ...extra,
      },
    },
    null,
    2,
  )}\n`

const CHANGELOG = `# Changelog

## 1.1.4

- Fix: the toggles.
- No wording change: \`CONSENT_VERSION\` is unchanged and no visitor is asked again.

## 1.1.3

- Fix: the banner's width.

## 1.1.2

- Fix: ConsentWidget on Astro 6.

## 1.1.0

- \`CONSENT_VERSION\` 2: every visitor on every site is asked again.

## 1.0.2

- Old.

## Unreleased: repo tool

Not part of the package.
`

describe('helpers', () => {
  test('installedOf: the version and commit of the installed package, null without it', () => {
    expect(installedOf(lockJson('^1.1.2', '1.1.2', OLD_SHA))).toEqual({ version: '1.1.2', sha: OLD_SHA })
    expect(installedOf(JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }))).toBeNull()
    expect(installedOf(JSON.stringify({ lockfileVersion: 3, packages: { [`node_modules/${PKG}`]: { version: '1.0.2', resolved: 'file:../x' } } }))).toEqual({ version: '1.0.2', sha: null })
  })

  test('compareVersions: numeric, part by part', () => {
    expect(compareVersions('1.1.4', '1.1.2')).toBeGreaterThan(0)
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0)
    expect(compareVersions('1.1.2', '1.1.2')).toBe(0)
    expect(compareVersions('1.0.2', '1.1.0')).toBeLessThan(0)
  })

  test('changelogBetween: the entries after `from` up to `to`, newest first; none for `to` is an error', () => {
    expect(changelogBetween(CHANGELOG, '1.1.2', '1.1.4').map((e) => e.version)).toEqual(['1.1.4', '1.1.3'])
    expect(changelogBetween(CHANGELOG, '1.0.2', '1.1.4').map((e) => e.version)).toEqual(['1.1.4', '1.1.3', '1.1.2', '1.1.0'])
    expect(changelogBetween(CHANGELOG, '1.1.2', '1.1.4')[1]).toEqual({ version: '1.1.3', text: "- Fix: the banner's width." })
    expect(() => changelogBetween(CHANGELOG, '1.1.2', '1.1.5')).toThrow(/CHANGELOG\.md has no entry for 1\.1\.5/)
  })

  test('consentVersionOf: the CONSENT_VERSION of a src/config.ts', () => {
    expect(consentVersionOf("import x from 'y'\nexport const CONSENT_VERSION = 2\n")).toBe(2)
    expect(consentVersionOf('export const CONSENT_VERSION = 1 // the wording\n')).toBe(1)
    expect(consentVersionOf('nothing here')).toBeNull()
  })

  test('updateSummary: versions, and whether visitors are asked again (CONSENT_VERSION moved); null when unknown', () => {
    const main = lockJson('^1.0.2', '1.0.2', OLD_SHA)
    const branch = lockJson('^1.1.4', '1.1.4', NEW_SHA)
    const at = (map: Record<string, number>) => (sha: string) => map[sha] ?? null
    expect(updateSummary(main, branch, at({ [OLD_SHA]: 1, [NEW_SHA]: 2 }))).toEqual({ from: '1.0.2', to: '1.1.4', reasks: true })
    expect(updateSummary(main, branch, at({ [OLD_SHA]: 2, [NEW_SHA]: 2 }))).toEqual({ from: '1.0.2', to: '1.1.4', reasks: false })
    expect(updateSummary(main, branch, at({ [NEW_SHA]: 2 }))).toEqual({ from: '1.0.2', to: '1.1.4', reasks: null })
  })

  test('the spec, the commit message and the release this checkout ships', () => {
    expect(updateSpec('1.1.4')).toBe('github:visionmediahq/astro-consent#semver:^1.1.4')
    expect(updateCommitMessage('1.1.2', '1.1.4')).toBe('chore: astro-consent 1.1.2 → 1.1.4')
    expect(RELEASE).toBe(JSON.parse(readFileSync(join(import.meta.dirname, '../../../package.json'), 'utf8')).version)
    expect(UPDATE_BRANCH).toBe('astro-consent-update')
  })
})

// ── runUpdate on a real checkout ────────────────────────────────────────────────────────────

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const status = (dir: string) => git(dir, 'status', '--porcelain', '--untracked-files=all')

/** A clone of a bare origin whose main holds `files`. */
function checkout(files: Record<string, string>): string {
  const origin = temp('update-origin-')
  git(origin, 'init', '-q', '--bare', '-b', 'main')
  const seed = temp('update-seed-')
  git(seed, 'init', '-q', '-b', 'main')
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, p)), { recursive: true })
    writeFileSync(join(seed, p), text)
  }
  git(seed, 'add', '-A')
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@example.se', 'commit', '-q', '-m', 'site')
  git(seed, 'push', '-q', origin, 'main')
  const parent = temp('update-clone-')
  git(parent, 'clone', '-q', origin, 'site')
  const dir = join(parent, 'site')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'user.email', 't@example.se')
  return dir
}
const live = (range = '^1.1.2', version = '1.1.2') => checkout({ 'package.json': pkgJson(range), 'package-lock.json': lockJson(range, version, OLD_SHA), 'src/pages/index.astro': '<h1>Hej</h1>\n' })

/** What npm install --package-lock-only does to the two files, or `more` on top. */
const npm =
  (to = '1.1.4', more: (dir: string) => void = () => {}) =>
  (dir: string, installSpec: string) => {
    expect(installSpec).toBe(updateSpec('1.1.4'))
    writeFileSync(join(dir, 'package.json'), pkgJson('^1.1.4'))
    writeFileSync(join(dir, 'package-lock.json'), lockJson('^1.1.4', to, NEW_SHA))
    more(dir)
  }
const noPrs = async (): Promise<string[]> => []
const versions = (sha: string) => ({ [OLD_SHA]: 2, [NEW_SHA]: 2 })[sha] ?? null
const opts = (over: Partial<Parameters<typeof runUpdate>[1]> = {}): Parameters<typeof runUpdate>[1] => ({
  install: npm(),
  openPrs: noPrs,
  release: '1.1.4',
  consentVersionAt: versions,
  ...over,
})

describe('run.ts update', () => {
  test('parseUpdateArgs: one site dir', () => {
    expect(parseUpdateArgs(['site'])).toEqual({ dir: 'site' })
    expect(() => parseUpdateArgs([])).toThrow(/usage: tsx ci\/rollout\/run\.ts update <site dir>/)
    expect(() => parseUpdateArgs(['a', 'b'])).toThrow(/one site dir only/)
    expect(() => parseUpdateArgs(['--dry-run', 'a'])).toThrow(/unknown option --dry-run/)
  })

  test('one commit on astro-consent-update from origin/main: package.json and the lockfile, nothing else', async () => {
    const dir = live()
    const { code, output } = await runUpdate(dir, opts())
    expect(code).toBe(0)
    expect(git(dir, 'branch', '--show-current')).toBe(UPDATE_BRANCH)
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('chore: astro-consent 1.1.2 → 1.1.4')
    expect(git(dir, 'rev-list', '--count', 'origin/main..HEAD')).toBe('1')
    expect(git(dir, 'diff', '--name-only', 'origin/main...HEAD').split('\n')).toEqual(['package-lock.json', 'package.json'])
    expect(status(dir)).toBe('')
    expect(output).toContain('update: astro-consent 1.1.2 → 1.1.4 (github:visionmediahq/astro-consent#semver:^1.1.4)')
    expect(output).toContain(`allowed node_modules/${PKG}: 1.1.2 → 1.1.4`)
    expect(output).toContain('visitors are not asked again (CONSENT_VERSION 2 on both)')
    expect(output).toContain(`committed on ${UPDATE_BRANCH}`)
  })

  test('a 1.0.2 site: the output says every visitor is asked again', async () => {
    const dir = live('^1.0.2', '1.0.2')
    const { code, output } = await runUpdate(dir, opts({ consentVersionAt: (sha) => ({ [OLD_SHA]: 1, [NEW_SHA]: 2 })[sha] ?? null }))
    expect(code).toBe(0)
    expect(output).toContain('update: astro-consent 1.0.2 → 1.1.4')
    expect(output).toContain('EVERY VISITOR IS ASKED AGAIN: CONSENT_VERSION 1 → 2')
  })

  test('asks GitHub about the other two flows; an open PR or an unmerged branch of either refuses (exit 3), nothing written', async () => {
    const asked: string[] = []
    const dir = live()
    expect((await runUpdate(dir, opts({ openPrs: async (_r, b) => (asked.push(b), []) }))).code).toBe(0)
    expect(asked).toEqual(['consent-banner', 'fonts-selfhost'])

    const open = live()
    const refused = await runUpdate(open, opts({ openPrs: async (_r, b) => (b === 'fonts-selfhost' ? ['https://github.com/visionmediahq/site/pull/7'] : []) }))
    expect(refused.code).toBe(3)
    expect(refused.output).toContain('update: refused, nothing was written')
    expect(refused.output).toContain('open fonts-selfhost PR https://github.com/visionmediahq/site/pull/7: merge or close it first, then detect and update again')
    expect(git(open, 'branch', '--show-current')).toBe('main')
    expect(git(open, 'branch', '--list', UPDATE_BRANCH)).toBe('')

    const branch = live()
    git(branch, 'push', '-q', 'origin', 'main:consent-banner')
    git(branch, 'switch', '-q', '-c', 'x')
    writeFileSync(join(branch, 'x.txt'), 'x')
    git(branch, 'add', 'x.txt')
    git(branch, 'commit', '-q', '-m', 'banner')
    git(branch, 'push', '-q', '-f', 'origin', 'x:consent-banner')
    git(branch, 'switch', '-q', 'main')
    const unmerged = await runUpdate(branch, opts())
    expect(unmerged.code).toBe(3)
    expect(unmerged.output).toMatch(/origin has a consent-banner branch \([0-9a-f]{7}\) that is not in origin\/main: .*merge or close the banner first\. Then detect and update again/)
  })

  test('refused (exit 3) without the package on main: the banner is not live, wire it', async () => {
    const dir = checkout({ 'package.json': JSON.stringify({ name: 'site', dependencies: { astro: '^6.1.6' } }), 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }) })
    const { code, output } = await runUpdate(dir, opts())
    expect(code).toBe(3)
    expect(output).toContain(`${PKG} is not installed on origin/main: the banner is not live there (run.ts wire)`)
    expect(git(dir, 'branch', '--list', UPDATE_BRANCH)).toBe('')
  })

  test('refused (exit 3) when main is already on the release; nothing installed', async () => {
    const dir = live('^1.1.4', '1.1.4')
    let installs = 0
    const { code, output } = await runUpdate(dir, opts({ install: () => void installs++ }))
    expect(code).toBe(3)
    expect(output).toContain('origin/main already has astro-consent 1.1.4 (the release is 1.1.4): nothing to update')
    expect(installs).toBe(0)
  })

  test('a lockfile change beyond the package: refused (exit 3), the branch is deleted and the checkout is main again, clean', async () => {
    const dir = live()
    const head = git(dir, 'rev-parse', 'HEAD')
    const extra = (d: string) =>
      writeFileSync(join(d, 'package-lock.json'), lockJson('^1.1.4', '1.1.4', NEW_SHA, { 'node_modules/@tailwindcss/oxide-wasm32-wasi/node_modules/tslib': { version: '2.8.1', optional: true } }))
    const { code, output } = await runUpdate(dir, opts({ install: npm('1.1.4', extra) }))
    expect(code).toBe(3)
    expect(output).toContain('update: refused, nothing was written')
    expect(output).toContain('UNKNOWN node_modules/@tailwindcss/oxide-wasm32-wasi/node_modules/tslib: added 2.8.1')
    expect(git(dir, 'branch', '--show-current')).toBe('main')
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(dir, 'branch', '--list', UPDATE_BRANCH)).toBe('')
    expect(status(dir)).toBe('')
  })

  test('the install did not move the version up: refused (exit 3), rolled back', async () => {
    const dir = live()
    const { code, output } = await runUpdate(dir, opts({ install: npm('1.1.2') }))
    expect(code).toBe(3)
    expect(output).toContain('the install left astro-consent at 1.1.2 (main 1.1.2): not an update')
    expect(git(dir, 'branch', '--show-current')).toBe('main')
    expect(status(dir)).toBe('')
  })

  test('a file besides the two changed, or a failing install: an error, rolled back to main, clean', async () => {
    const dir = live()
    await expect(runUpdate(dir, opts({ install: npm('1.1.4', (d) => writeFileSync(join(d, '.npmrc'), 'x')) }))).rejects.toThrow(/changed paths not in the plan[\s\S]*\.npmrc/)
    expect(git(dir, 'branch', '--show-current')).toBe('main')
    expect(git(dir, 'branch', '--list', UPDATE_BRANCH)).toBe('')
    expect(status(dir)).toBe('')

    await expect(
      runUpdate(
        dir,
        opts({
          install: () => {
            throw new Error('npm ERR! 404')
          },
        }),
      ),
    ).rejects.toThrow(/npm ERR! 404/)
    expect(git(dir, 'branch', '--show-current')).toBe('main')
    expect(status(dir)).toBe('')
  })

  test('refused before anything when the checkout is not clean or the branch exists (startBranch)', async () => {
    const dirty = live()
    writeFileSync(join(dirty, 'x.txt'), 'x')
    await expect(runUpdate(dirty, opts())).rejects.toThrow(/not clean/)
    const taken = live()
    git(taken, 'branch', UPDATE_BRANCH)
    await expect(runUpdate(taken, opts())).rejects.toThrow(/astro-consent-update already exists locally/)
  })
})
