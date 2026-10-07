// The wire stage (spec C2): planWire turns a site's Report into one all-or-nothing plan, and
// applyWire writes it: branch consent-banner from origin/main, the edits and new files, the npm
// install of the package, one commit. Nothing is written unless the whole plan was planned.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { SiteFiles } from '../lib/site-files'
import type { Report, WirePlan } from '../types'
import { wireConfig } from './config'
import { wireCss } from './css'
import { wireEmbeds } from './embeds'
import { applyEdits, Planner, refuseNeedsHuman } from './engine'
import { wireLayout } from './layout'
import { wireLinks } from './links'
import { wirePrivacy } from './privacy'

export const BRANCH = 'consent-banner'
export const INSTALL_SPEC = 'github:visionmediahq/astro-consent#semver:^1.0.2'
export const COMMIT_MESSAGE = 'feat: samtyckesbanner (astro-consent)'

/**
 * The whole plan for a site, or only refusals. A `needs-human` report is refused first, with one
 * refusal per reason, before any part looks at the site. The domain for `policy_url` is
 * `report.domains[0]` (Ruling 3).
 */
export function planWire(files: SiteFiles, report: Report): WirePlan {
  const planner = new Planner(files)
  if (refuseNeedsHuman(planner, report)) return planner.result()
  for (const part of [wireConfig, wireCss, wireLayout, wireLinks, wirePrivacy, wireEmbeds]) part(planner, report)
  return planner.result()
}

/** Each changed or new file with its text before (null for a new file) and after. */
export function planFiles(read: (path: string) => string, plan: Extract<WirePlan, { ok: true }>): { path: string; before: string | null; after: string }[] {
  const out: { path: string; before: string | null; after: string }[] = []
  for (const path of [...new Set(plan.edits.map((e) => e.file))]) {
    const before = read(path)
    out.push({ path, before, after: applyEdits(before, plan.edits.filter((e) => e.file === path)) })
  }
  for (const f of plan.newFiles) out.push({ path: f.path, before: null, after: f.text })
  return out
}

export function refusalLines(plan: Extract<WirePlan, { ok: false }>): string[] {
  return plan.refusals.map((r) => `refused ${r.target}${r.file ? ` (${r.file})` : ''}: ${r.reason}`)
}

/** `npm install` of the package on top of the existing lockfile. */
export function npmInstall(dir: string): void {
  execFileSync('npm', ['install', '--no-audit', '--no-fund', INSTALL_SPEC], { cwd: dir, stdio: 'inherit' })
}

const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function gitOk(dir: string, ...args: string[]): boolean {
  try {
    git(dir, ...args)
    return true
  } catch {
    return false
  }
}

/** What the install may change besides the planned files. */
const INSTALL_PATHS = ['package.json', 'package-lock.json']

export const RECOVERY = `the checkout is left on ${BRANCH}, uncommitted; to retry: git reset --hard && git clean -fd && git switch main && git branch -D ${BRANCH}, or re-clone`

/** Every changed, deleted or untracked path (not ignored ones), from `git status --porcelain -z`. */
function changedPaths(dir: string): string[] {
  const out = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const fields = out.split('\0')
  const paths: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!
    if (entry.length < 4) continue
    paths.push(entry.slice(3))
    // A rename or copy is followed by its source path.
    if (entry[0] === 'R' || entry[0] === 'C') paths.push(fields[++i]!)
  }
  return paths
}

export interface ApplyOptions {
  /**
   * true: the full C2 apply (branch, edits, install, commit), which refuses a checkout that is not
   * a clean origin/main or that already has a consent-banner branch, locally or on origin. false: the edits and new files
   * only (no git, no install).
   */
  commit: boolean
  /** The install step; `npmInstall` unless a test injects its own. Runs only with commit: true. */
  install?: (dir: string) => void
}

/**
 * Writes `plan` into the checkout at `dir`. Every check and every new file text is worked out
 * before the first write, so a refusal leaves the checkout as it was. Throws with the reason.
 */
export function applyWire(dir: string, plan: WirePlan, opts: ApplyOptions): void {
  const root = resolve(dir)
  if (!plan.ok) throw new Error(`wire refused, nothing written:\n${refusalLines(plan).join('\n')}`)
  const files = planFiles((path) => readFileSync(join(root, path), 'utf8'), plan)
  for (const f of files) {
    if (f.before === null && existsSync(join(root, f.path))) throw new Error(`${f.path} already exists, nothing written`)
  }

  if (opts.commit) {
    if (!gitOk(root, 'rev-parse', '--git-dir')) throw new Error(`${root} is not a git checkout`)
    const dirty = git(root, 'status', '--porcelain', '--untracked-files=all')
    if (dirty !== '') throw new Error(`the working tree is not clean, nothing written:\n${dirty}`)
    if (gitOk(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`)) {
      throw new Error(`branch ${BRANCH} already exists locally, nothing written (delete it by hand if it is stale)`)
    }
    // A consent-banner on GitHub is someone's work (or an earlier run's): verify would push over it.
    // A rerun after this tool's own push has the local branch, which is refused above anyway.
    const tracking = gitOk(root, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${BRANCH}`) ? git(root, 'rev-parse', `refs/remotes/origin/${BRANCH}`) : ''
    let listed: string
    try {
      listed = git(root, 'ls-remote', '--heads', 'origin', BRANCH)
    } catch (e) {
      throw new Error(`git ls-remote --heads origin ${BRANCH} failed, so whether GitHub has the branch is unknown; nothing written\n${(e as Error).message}`)
    }
    const remote = listed.split(/\s+/)[0] ?? ''
    for (const sha of [tracking, remote]) {
      if (sha) {
        throw new Error(`origin already has a ${BRANCH} branch (${sha.slice(0, 7)}), nothing written: find out whose it is and delete it on GitHub by hand if it is stale`)
      }
    }
    if (!gitOk(root, 'rev-parse', '--verify', '--quiet', 'origin/main^{tree}')) throw new Error('no origin/main to branch from')
    // The plan was made on the working tree; branching from origin/main must not change it.
    if (git(root, 'rev-parse', 'HEAD^{tree}') !== git(root, 'rev-parse', 'origin/main^{tree}')) {
      throw new Error('HEAD is not origin/main, so the plan does not fit the branch; nothing written')
    }
    git(root, 'switch', '-c', BRANCH, 'origin/main')
  }

  try {
    for (const f of files) {
      mkdirSync(dirname(join(root, f.path)), { recursive: true })
      writeFileSync(join(root, f.path), f.after)
    }

    if (opts.commit) {
      ;(opts.install ?? npmInstall)(root)
      // Ruling 32: commit only what the plan wrote and what the install may change.
      const allowed = new Set([...files.map((f) => f.path), ...INSTALL_PATHS])
      const extra = changedPaths(root).filter((p) => !allowed.has(p)).sort()
      if (extra.length) throw new Error(`changed paths not in the plan, nothing committed:\n${extra.map((p) => `  ${p}`).join('\n')}`)
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', COMMIT_MESSAGE)
    }
  } catch (e) {
    if (!opts.commit) throw e
    throw new Error(`${(e as Error).message}\n${RECOVERY}`)
  }
}
