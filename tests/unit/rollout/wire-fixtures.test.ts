// planWire against the pilot fixtures (spec C8: expected/ is the oracle, written from C2's rules
// before the code), its idempotence, applyWire on a real git checkout (the npm install injected,
// never run), and the `wire` CLI's dry run.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { detect } from '../../../ci/rollout/detect'
import { fixtureSite, type SiteFiles } from '../../../ci/rollout/lib/site-files'
import { parseWireArgs, runDetect, runWire } from '../../../ci/rollout/run'
import type { Report, WirePlan } from '../../../ci/rollout/types'
import { applyEdits } from '../../../ci/rollout/wire/engine'
import { applyWire, BRANCH, COMMIT_MESSAGE, INSTALL_SPEC, planWire } from '../../../ci/rollout/wire/index'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const SITES = readdirSync(FIXTURES).filter((s) => statSync(join(FIXTURES, s)).isDirectory()).sort()
const REFUSED = (site: string) => join(FIXTURES, site, 'expected', 'REFUSED.md')
const WIRED = SITES.filter((s) => !existsSync(REFUSED(s)))
const NEEDS_HUMAN = SITES.filter((s) => existsSync(REFUSED(s)))

/** Every file under `dir`, site-relative, with the fixture `.txt` suffix removed. */
function treeOf(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const visit = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) visit(full)
      else if (e.name.endsWith('.txt')) out.set(relative(dir, full).split(sep).join('/').slice(0, -'.txt'.length), readFileSync(full, 'utf8'))
    }
  }
  visit(dir)
  return out
}

/** `files` with some paths replaced. */
function overlay(files: SiteFiles, over: Record<string, string>): SiteFiles {
  return {
    root: files.root,
    list: (glob) => files.list(glob),
    read: (path) => over[path] ?? files.read(path),
    exists: (path) => path in over || files.exists(path),
  }
}

function planFor(site: string, tree: 'before' | 'expected', files: SiteFiles = fixtureSite(join(FIXTURES, site, tree))): { files: SiteFiles; report: Report; plan: WirePlan } {
  const report = detect(files, site, [`${site}.se`])
  return { files, report, plan: planWire(files, report) }
}

function okPlan(plan: WirePlan): Extract<WirePlan, { ok: true }> {
  if (!plan.ok) throw new Error(`refused: ${JSON.stringify(plan.refusals, null, 2)}`)
  return plan
}

/** The reasons listed in REFUSED.md, one `- ` bullet each. */
function refusedReasons(site: string): string[] {
  return readFileSync(REFUSED(site), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
}

/** Targets that exist only while there is an iframe to convert; the expected/ tree has none. */
const embedTarget = (t: string): boolean => t.startsWith('embed') || t.startsWith('ConsentEmbed import')

describe('planWire on the pilot fixtures', () => {
  test('the fixture set: 5 wired, 2 refused', () => {
    expect(WIRED).toHaveLength(5)
    expect(NEEDS_HUMAN).toEqual(['a-tak', 'nhrk'])
  })

  test.each(NEEDS_HUMAN)('%s: needs-human, refused whole with exactly the REFUSED.md reasons', (site) => {
    const { plan } = planFor(site, 'before')
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.refusals.map((r) => r.reason)).toEqual(refusedReasons(site))
    expect(plan.refusals.every((r) => r.target === 'classification')).toBe(true)
  })

  test.each(WIRED)('%s: every file comes out as expected/, byte for byte, and privacy.json is the one new file', (site) => {
    const { files, plan } = planFor(site, 'before')
    const ok = okPlan(plan)
    const before = treeOf(join(FIXTURES, site, 'before'))
    const expected = treeOf(join(FIXTURES, site, 'expected'))
    for (const e of ok.edits) expect(before.has(e.file), `edit in a file that does not exist: ${e.file}`).toBe(true)
    for (const [path, text] of before) {
      const after = applyEdits(text, ok.edits.filter((e) => e.file === path))
      expect(after, path).toBe(expected.get(path))
    }
    const created = [...expected.keys()].filter((p) => !before.has(p))
    expect(ok.newFiles.map((f) => f.path)).toEqual(created)
    for (const f of ok.newFiles) expect(f.text, f.path).toBe(expected.get(f.path))
    expect(files.exists('src/data/privacy.json')).toBe(false)
  })

  test.each(WIRED)('%s idempotent: planWire on the expected/ tree has zero edits, every target skipped', (site) => {
    const first = okPlan(planFor(site, 'before').plan)
    const again = okPlan(planFor(site, 'expected').plan)
    expect(again.edits).toEqual([])
    expect(again.newFiles).toEqual([])
    const targets = [...new Set([...first.edits.map((e) => e.target), 'privacy.json'])].filter((t) => !embedTarget(t))
    expect(again.skipped).toEqual(expect.arrayContaining(targets))
  })

  test('idempotent after a hand edit (Review Focus 5): <ConsentBanner /> moved to another line of the layout', () => {
    const site = 'aspomad'
    const files = fixtureSite(join(FIXTURES, site, 'expected'))
    const layout = 'src/layouts/Base.astro'
    const text = files.read(layout)
    const line = /^[ \t]*<ConsentBanner \/>\r?\n/m.exec(text)
    expect(line).not.toBeNull()
    const without = text.slice(0, line!.index) + text.slice(line!.index + line![0].length)
    const body = /<body[^>]*>\r?\n/.exec(without)!
    const at = body.index + body[0].length
    const moved = `${without.slice(0, at)}    <ConsentBanner />\n${without.slice(at)}`
    expect(moved).not.toBe(text)
    const { plan } = planFor(site, 'expected', overlay(files, { [layout]: moved }))
    const ok = okPlan(plan)
    expect(ok.edits).toEqual([])
    expect(ok.newFiles).toEqual([])
    expect(ok.skipped).toEqual(expect.arrayContaining([`banner (${layout})`, `ConsentBanner import (${layout})`]))
  })

  test('a needs-human report is refused before any part is planned: only its reasons, no other refusal', () => {
    const files = fixtureSite(join(FIXTURES, 'aspomad', 'before'))
    const report = detect(files, 'aspomad', ['aspomad.se'])
    // A config that is not there would be a refusal of its own if wireConfig ran.
    const plan = planWire(files, { ...report, config: { ...report.config, path: 'missing.config.ts' }, classification: 'needs-human', reasons: ['tracker gtm'] })
    expect(plan).toEqual({ ok: false, refusals: [{ file: '', target: 'classification', reason: 'tracker gtm' }] })
  })

  test('the policy_url host is report.domains[0] (Ruling 3)', () => {
    const files = fixtureSite(join(FIXTURES, 'vasshallakatthotell', 'before'))
    const report = detect(files, 'vasshallakatthotell', ['www.example.se', 'example.se'])
    const ok = okPlan(planWire(files, report))
    expect(JSON.parse(ok.newFiles.find((f) => f.path === 'src/data/privacy.json')!.text).policy_url).toBe('https://www.example.se/gdpr')
  })
})

// ── applyWire on disk ────────────────────────────────────────────────────────────────────────

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function writeTree(dir: string, tree: Map<string, string>): void {
  for (const [path, text] of tree) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
}

/** Every file in a checkout (no .git, no .rollout), site-relative. */
function diskTree(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const visit = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === '.rollout') continue
      const full = join(d, e.name)
      if (e.isDirectory()) visit(full)
      else out.set(relative(dir, full).split(sep).join('/'), readFileSync(full, 'utf8'))
    }
  }
  visit(dir)
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)))
}

/** A clone of a bare origin whose main holds the fixture's before/ tree, as the rollout clones a site. */
function checkout(site: string): string {
  const origin = temp('wire-origin-')
  git(origin, 'init', '-q', '--bare', '-b', 'main')
  const seed = temp('wire-seed-')
  git(seed, 'init', '-q', '-b', 'main')
  writeTree(seed, treeOf(join(FIXTURES, site, 'before')))
  git(seed, 'add', '-A')
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@example.se', 'commit', '-q', '-m', 'site')
  git(seed, 'push', '-q', origin, 'main')
  const parent = temp('wire-clone-')
  git(parent, 'clone', '-q', origin, 'site')
  const dir = join(parent, 'site')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'user.email', 't@example.se')
  return dir
}

const expectedTree = (site: string): Map<string, string> => treeOf(join(FIXTURES, site, 'expected'))

describe('applyWire', () => {
  test('constants: the branch, the install spec and the commit message (spec C2, global constraints)', () => {
    expect(BRANCH).toBe('consent-banner')
    expect(INSTALL_SPEC).toBe('github:visionmediahq/astro-consent#semver:^1.0.2')
    expect(COMMIT_MESSAGE).toBe('feat: samtyckesbanner (astro-consent)')
  })

  test('commit: false writes the edits and new files only: the checkout becomes expected/', () => {
    const dir = temp('wire-plain-')
    writeTree(dir, treeOf(join(FIXTURES, 'aspomad', 'before')))
    const report = detect(fixtureSite(join(FIXTURES, 'aspomad', 'before')), 'aspomad', ['aspomad.se'])
    let installs = 0
    applyWire(dir, planWire(fixtureSite(join(FIXTURES, 'aspomad', 'before')), report), { commit: false, install: () => void installs++ })
    expect(diskTree(dir)).toEqual(expectedTree('aspomad'))
    expect(installs).toBe(0)
  })

  test('commit: true: branch consent-banner from origin/main, edits, the install, one commit with everything', () => {
    const dir = checkout('domeijstapetserarverkstad')
    const main = git(dir, 'rev-parse', 'origin/main')
    const report = runDetect(dir, ['domeijstapetserarverkstad.se'])
    const calls: { dir: string; layout: string }[] = []
    applyWire(dir, planWire(fixtureSite(join(FIXTURES, 'domeijstapetserarverkstad', 'before')), report), {
      commit: true,
      install: (d) => {
        // The install runs on the edited tree, before the commit.
        calls.push({ dir: d, layout: readFileSync(join(d, 'src/layouts/Base.astro'), 'utf8') })
        writeFileSync(join(d, 'package.json'), '{"installed":true}\n')
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.dir).toBe(dir)
    expect(calls[0]!.layout).toContain('<ConsentBanner />')
    expect(git(dir, 'branch', '--show-current')).toBe('consent-banner')
    expect(git(dir, 'rev-parse', 'HEAD~1')).toBe(main)
    expect(git(dir, 'log', '-1', '--format=%s%n%b')).toBe('feat: samtyckesbanner (astro-consent)')
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    const want = expectedTree('domeijstapetserarverkstad')
    want.set('package.json', '{"installed":true}\n')
    expect(diskTree(dir)).toEqual(new Map([...want].sort(([a], [b]) => a.localeCompare(b))))
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toContain('src/data/privacy.json')
  })

  test('a refused plan writes nothing and says why', () => {
    const dir = checkout('nhrk')
    const report = runDetect(dir, ['nhrk.se'])
    const plan = planWire(fixtureSite(join(FIXTURES, 'nhrk', 'before')), report)
    expect(() => applyWire(dir, plan, { commit: true, install: () => {} })).toThrow(/unresolved iframe src/)
    expect(git(dir, 'branch', '--show-current')).toBe('main')
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('')
  })

  test('a dirty working tree: refused before anything is switched or written', () => {
    const dir = checkout('munkforstradgardstjanst')
    const report = runDetect(dir, ['munkforstradgardstjanst.se'])
    const plan = planWire(fixtureSite(join(FIXTURES, 'munkforstradgardstjanst', 'before')), report)
    writeFileSync(join(dir, 'stray.txt'), 'x\n')
    expect(() => applyWire(dir, plan, { commit: true, install: () => {} })).toThrow(/not clean/)
    expect(git(dir, 'branch', '--show-current')).toBe('main')
    expect(git(dir, 'status', '--porcelain')).toBe('?? stray.txt')
    expect(existsSync(join(dir, 'src/data/privacy.json'))).toBe(false)
  })

  test('a consent-banner branch that already exists: refused, never clobbered', () => {
    const dir = checkout('munkforstradgardstjanst')
    const report = runDetect(dir, ['munkforstradgardstjanst.se'])
    const plan = planWire(fixtureSite(join(FIXTURES, 'munkforstradgardstjanst', 'before')), report)
    git(dir, 'branch', 'consent-banner')
    const tip = git(dir, 'rev-parse', 'consent-banner')
    expect(() => applyWire(dir, plan, { commit: true, install: () => {} })).toThrow(/consent-banner already exists/)
    expect(git(dir, 'branch', '--show-current')).toBe('main')
    expect(git(dir, 'rev-parse', 'consent-banner')).toBe(tip)
    expect(existsSync(join(dir, 'src/data/privacy.json'))).toBe(false)
  })

  test('finding 2: a consent-banner on origin (fetched with the clone) is refused, never pushed over', () => {
    const dir = checkout('munkforstradgardstjanst')
    const report = runDetect(dir, ['munkforstradgardstjanst.se'])
    const plan = planWire(fixtureSite(join(FIXTURES, 'munkforstradgardstjanst', 'before')), report)
    git(dir, 'push', '-q', 'origin', 'main:refs/heads/consent-banner')
    git(dir, 'fetch', '-q', 'origin')
    expect(git(dir, 'rev-parse', 'refs/remotes/origin/consent-banner')).toBeTruthy()
    expect(() => applyWire(dir, plan, { commit: true, install: () => {} })).toThrow(/origin already has a consent-banner branch/)
    expect(git(dir, 'branch', '--show-current')).toBe('main')
    expect(existsSync(join(dir, 'src/data/privacy.json'))).toBe(false)
  })

  test('finding 2: a consent-banner pushed to origin after the clone (only ls-remote sees it) is refused too', () => {
    const dir = checkout('munkforstradgardstjanst')
    const report = runDetect(dir, ['munkforstradgardstjanst.se'])
    const plan = planWire(fixtureSite(join(FIXTURES, 'munkforstradgardstjanst', 'before')), report)
    git(dir, 'push', '-q', 'origin', 'main:refs/heads/consent-banner')
    git(dir, 'update-ref', '-d', 'refs/remotes/origin/consent-banner')
    expect(() => applyWire(dir, plan, { commit: true, install: () => {} })).toThrow(/origin already has a consent-banner branch/)
    expect(git(dir, 'branch', '--show-current')).toBe('main')
  })

  test('pre-run: another branch ending in /consent-banner on origin does not block wiring', () => {
    const dir = checkout('munkforstradgardstjanst')
    const report = runDetect(dir, ['munkforstradgardstjanst.se'])
    const plan = planWire(fixtureSite(join(FIXTURES, 'munkforstradgardstjanst', 'before')), report)
    git(dir, 'push', '-q', 'origin', 'main:refs/heads/feature/consent-banner')
    applyWire(dir, plan, { commit: true, install: () => {} })
    expect(git(dir, 'branch', '--show-current')).toBe('consent-banner')
  })

  test('a checkout whose HEAD is not origin/main: refused (the plan was made on another tree)', () => {
    const dir = checkout('munkforstradgardstjanst')
    const report = runDetect(dir, ['munkforstradgardstjanst.se'])
    const plan = planWire(fixtureSite(join(FIXTURES, 'munkforstradgardstjanst', 'before')), report)
    writeFileSync(join(dir, 'README.md'), 'local\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'local')
    expect(() => applyWire(dir, plan, { commit: true, install: () => {} })).toThrow(/origin\/main/)
    expect(git(dir, 'branch', '--show-current')).toBe('main')
  })

  test('Ruling 32: a failure after the branch switch names the recovery steps', () => {
    const dir = checkout('munkforstradgardstjanst')
    const report = runDetect(dir, ['munkforstradgardstjanst.se'])
    const plan = planWire(fixtureSite(join(FIXTURES, 'munkforstradgardstjanst', 'before')), report)
    const err = (() => {
      try {
        applyWire(dir, plan, {
          commit: true,
          install: () => {
            throw new Error('npm install failed: E404')
          },
        })
      } catch (e) {
        return (e as Error).message
      }
      return ''
    })()
    expect(err).toContain('npm install failed: E404')
    expect(err).toContain('git reset --hard && git clean -fd && git switch main && git branch -D consent-banner')
    expect(err).toContain('re-clone')
    // Stopped uncommitted, on the branch, as the hint says.
    expect(git(dir, 'branch', '--show-current')).toBe('consent-banner')
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(dir, 'rev-parse', 'origin/main'))
  })

  test('Ruling 32: a path the plan did not name (besides package.json and the lockfile) stops the commit and is listed', () => {
    const dir = checkout('munkforstradgardstjanst')
    const report = runDetect(dir, ['munkforstradgardstjanst.se'])
    const plan = planWire(fixtureSite(join(FIXTURES, 'munkforstradgardstjanst', 'before')), report)
    expect(() =>
      applyWire(dir, plan, {
        commit: true,
        install: (d) => {
          writeFileSync(join(d, 'package.json'), '{"installed":true}\n')
          writeFileSync(join(d, 'package-lock.json'), '{}\n')
          mkdirSync(join(d, 'node_modules/x'), { recursive: true })
          writeFileSync(join(d, 'node_modules/x/index.js'), '\n')
          writeFileSync(join(d, 'src/pages/index.astro'), 'changed\n')
        },
      }),
    ).toThrow(/not in the plan[\s\S]*node_modules\/x\/index\.js[\s\S]*src\/pages\/index\.astro[\s\S]*git reset --hard/)
    expect(git(dir, 'branch', '--show-current')).toBe('consent-banner')
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(dir, 'rev-parse', 'origin/main'))
  })

  test('Ruling 32: package.json and package-lock.json changed by the install are allowed', () => {
    const dir = checkout('munkforstradgardstjanst')
    const report = runDetect(dir, ['munkforstradgardstjanst.se'])
    const plan = planWire(fixtureSite(join(FIXTURES, 'munkforstradgardstjanst', 'before')), report)
    applyWire(dir, plan, {
      commit: true,
      install: (d) => {
        writeFileSync(join(d, 'package.json'), '{"installed":true}\n')
        writeFileSync(join(d, 'package-lock.json'), '{}\n')
      },
    })
    expect(git(dir, 'log', '-1', '--format=%s')).toBe(COMMIT_MESSAGE)
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toEqual(expect.arrayContaining(['package.json', 'package-lock.json']))
  })

  test('a new file that already exists on disk: refused before anything is written', () => {
    const dir = temp('wire-exists-')
    writeTree(dir, treeOf(join(FIXTURES, 'aspomad', 'before')))
    const plan = planWire(fixtureSite(join(FIXTURES, 'aspomad', 'before')), detect(fixtureSite(join(FIXTURES, 'aspomad', 'before')), 'aspomad', ['aspomad.se']))
    mkdirSync(join(dir, 'src/data'), { recursive: true })
    writeFileSync(join(dir, 'src/data/privacy.json'), '{}\n')
    const base = readFileSync(join(dir, 'src/layouts/Base.astro'), 'utf8')
    expect(() => applyWire(dir, plan, { commit: false })).toThrow(/privacy\.json already exists/)
    expect(readFileSync(join(dir, 'src/layouts/Base.astro'), 'utf8')).toBe(base)
  })
})

// ── the CLI ──────────────────────────────────────────────────────────────────────────────────

describe('run.ts wire', () => {
  test('parseWireArgs: a dir and an optional --dry-run', () => {
    expect(parseWireArgs(['site'])).toEqual({ dir: 'site', dryRun: false })
    expect(parseWireArgs(['--dry-run', 'site'])).toEqual({ dir: 'site', dryRun: true })
    expect(() => parseWireArgs([])).toThrow(/usage/)
    expect(() => parseWireArgs(['site', '--dry'])).toThrow(/--dry/)
    expect(() => parseWireArgs(['a', 'b'])).toThrow(/one site dir/)
  })

  test('--dry-run prints the summary and a unified diff, and writes nothing (spec C2)', () => {
    const dir = checkout('aspomad')
    runDetect(dir, ['aspomad.se'])
    const rollout = readdirSync(join(dir, '.rollout'))
    const tree = diskTree(dir)
    const { code, output } = runWire(dir, { dryRun: true })
    expect(code).toBe(0)
    expect(output).toContain('site (aspomad.se): maps')
    expect(output).toMatch(/edits in \d+ files/)
    expect(output).toContain('--- a/src/layouts/Base.astro')
    expect(output).toContain('+++ b/src/layouts/Base.astro')
    expect(output).toContain("+import ConsentBanner from '@visionmediahq/astro-consent/components/ConsentBanner.astro'")
    expect(output).toContain('--- /dev/null')
    expect(output).toContain('+++ b/src/data/privacy.json')
    expect(diskTree(dir)).toEqual(tree)
    expect(readdirSync(join(dir, '.rollout'))).toEqual(rollout)
    expect(git(dir, 'branch', '--show-current')).toBe('main')
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('')
  })

  test('--dry-run of a needs-human site prints the refusals and exits 3 (Ruling 32)', () => {
    const dir = checkout('a-tak')
    runDetect(dir, ['a-tak.se'])
    const { code, output } = runWire(dir, { dryRun: true })
    expect(code).toBe(3)
    for (const reason of refusedReasons('a-tak')) expect(output).toContain(reason)
    expect(output).not.toContain('+++')
  })

  test('a refused plan without --dry-run also exits 3 and leaves the checkout alone (Ruling 32)', () => {
    const dir = checkout('a-tak')
    runDetect(dir, ['a-tak.se'])
    const { code, output } = runWire(dir, { dryRun: false })
    expect(code).toBe(3)
    expect(output).toContain('nothing was written')
    expect(git(dir, 'branch', '--show-current')).toBe('main')
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('')
  })

  test('without .rollout/report.json: an error that says to run detect first', () => {
    const dir = checkout('aspomad')
    expect(() => runWire(dir, { dryRun: true })).toThrow(/run detect first/)
  })
})
