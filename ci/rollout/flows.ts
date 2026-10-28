// The flows of the rollout tool, keyed by the branch they live on (site-factory#220):
//
//   consent-banner        wire: the banner, and (unless --no-fonts) a second commit self-hosting the
//                         site's Google Fonts
//   fonts-selfhost        fonts: the Google Fonts commit alone, for a site whose banner is already live
//   astro-consent-update  update: the lockfile on the latest astro-consent release, for a site whose
//                         banner is already live
//
// verify, pr, merge and live read the clone's current branch and refuse one that is not here.
// consent-banner keeps the state names it always had in .rollout/ (`verify.json`, `pushed.txt`,
// `pr-body.md`, …), which the operator's scripts read; every other flow has its own
// (`verify-fonts-selfhost.json`, …), so one flow's run never overwrites or reads another's.
import { join } from 'node:path'
import { type Exec, tail } from './lib/exec'
import { FONTS_BRANCH, FONTS_CSS } from './wire/fonts'
import { BRANCH } from './wire/index'
import { UPDATE_BRANCH } from './wire/update'

/** verify's steps, in order; the number of a step is its place here (1-based) in every flow. */
export const STEPS = ['lockfile', 'build', 'requests', 'consent-paths', 'clip', 'contrast', 'screenshots', 'fonts', 'docker'] as const
export type StepName = (typeof STEPS)[number]

export type FlowBranch = typeof BRANCH | typeof FONTS_BRANCH | typeof UPDATE_BRANCH

export interface Flow {
  branch: FlowBranch
  /** The PR title. */
  title: string
  /** Titles this tool gave its PRs from this branch before; an open PR with one of them is still its own. */
  ownTitles: readonly string[]
  /** The Swedish PR body template. */
  template: string
  /**
   * The verify steps this flow runs. The others are recorded as skipped with `skipWhy`, except
   * `fonts` on consent-banner, which runs whenever the branch self-hosts fonts (selfHostsFonts).
   */
  steps: readonly StepName[]
  skipWhy: string
  /** The other flows: an unmerged branch or an open PR of any of them on GitHub refuses this one (they would conflict). */
  others: readonly FlowBranch[]
}

export const FLOWS: Record<FlowBranch, Flow> = {
  'consent-banner': {
    branch: BRANCH,
    // No version (#51): the range wire installs moves with each release, and the diff shows it.
    title: 'Samtyckesbanner (astro-consent)',
    ownTitles: ['Samtyckesbanner (astro-consent)', 'Samtyckesbanner (astro-consent 1.0)'],
    template: join(import.meta.dirname, 'pr-body.sv.md'),
    steps: ['lockfile', 'build', 'requests', 'consent-paths', 'clip', 'contrast', 'screenshots', 'docker'],
    skipWhy: 'no self-hosted fonts on the branch (no src/styles/fonts.css from this tool)',
    others: [FONTS_BRANCH, UPDATE_BRANCH],
  },
  'fonts-selfhost': {
    branch: FONTS_BRANCH,
    title: 'Google Fonts från sajten själv',
    ownTitles: ['Google Fonts från sajten själv'],
    template: join(import.meta.dirname, 'pr-body.fonts.sv.md'),
    steps: ['lockfile', 'build', 'requests', 'clip', 'screenshots', 'fonts', 'docker'],
    skipWhy: 'banner-only check: not run on fonts-selfhost (the banner is already live)',
    others: [BRANCH, UPDATE_BRANCH],
  },
  'astro-consent-update': {
    branch: UPDATE_BRANCH,
    // No version, like the banner's (#51): the commit message and the body name them.
    title: 'Uppdatera astro-consent',
    ownTitles: ['Uppdatera astro-consent'],
    template: join(import.meta.dirname, 'pr-body.update.sv.md'),
    // The banner, its texts and its styles change with the package: every banner step runs.
    steps: ['lockfile', 'build', 'requests', 'consent-paths', 'clip', 'contrast', 'screenshots', 'docker'],
    skipWhy: 'no self-hosted fonts on the branch (no src/styles/fonts.css from this tool)',
    others: [BRANCH, FONTS_BRANCH],
  },
}

export const isFlowBranch = (branch: string): branch is FlowBranch => Object.hasOwn(FLOWS, branch)

/** The flow of `branch`; throws for any other branch, naming the stage and the checkout. */
export function flowOf(branch: string, stage: string, root: string): Flow {
  if (isFlowBranch(branch)) return FLOWS[branch]
  throw new Error(`${stage} runs on branch ${Object.keys(FLOWS).join(' or ')}; ${root} is on ${branch || '(unknown)'}`)
}

/** The flow of the checkout's current branch (git rev-parse --abbrev-ref HEAD); throws for any other. */
export async function currentFlow(exec: Exec, root: string, stage: string): Promise<Flow> {
  const head = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root)
  return flowOf(head.code === 0 ? head.out.trim() : '', stage, root)
}

/**
 * The name of a state file or folder in .rollout/ for `branch`: consent-banner's as it always was
 * (`verify.json`); any other flow's with its branch (`verify-fonts-selfhost.json`, `evidence-fonts-selfhost`).
 */
export function stateName(name: string, branch: FlowBranch): string {
  if (branch === BRANCH) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)}-${branch}${name.slice(dot)}` : `${name}-${branch}`
}

/** Where a stage reads and writes state `name` of `branch` in the folder `rollout` (`<site>/.rollout`). */
export const statePath = (rollout: string, name: string, branch: FlowBranch): string => join(rollout, stateName(name, branch))

/** The marker in the header of a fonts.css this tool wrote (wire/fonts planFonts). */
export const FONTS_MARKER = 'by the astro-consent rollout tool'

/** Whether `css` (a src/styles/fonts.css) is one this tool wrote. */
export const isToolFontsCss = (css: string | null): boolean => css !== null && css.includes(FONTS_MARKER)

/** The tool's src/styles/fonts.css at `ref` (a commit or origin/main), or null. */
export async function fontsCssAt(exec: Exec, root: string, ref: string): Promise<string | null> {
  const r = await exec('git', ['show', `${ref}:${FONTS_CSS}`], root)
  return r.code === 0 && isToolFontsCss(r.out) ? r.out : null
}

/** Open PRs from `branch` on `repo` (gh); throws when gh fails, so "none" is never a guess. */
export async function openPrsFrom(exec: Exec, root: string, repo: string, branch: FlowBranch): Promise<{ url: string; title: string }[]> {
  const r = await exec('gh', ['pr', 'list', '-R', repo, '--head', branch, '--state', 'open', '--json', 'url,title'], root)
  if (r.code !== 0) throw new Error(`gh pr list failed, so whether a ${branch} PR is open is unknown:\n${tail(r.out)}`)
  return JSON.parse(r.out || '[]') as { url: string; title: string }[]
}

/**
 * Why origin's `branch` would conflict: it exists and origin/main does not contain it (squash
 * merges delete the branch on GitHub, so one left there is unmerged work). null when there is
 * none or it is merged. Throws when git cannot tell, so "no obstacle" is never a guess.
 */
export async function unmergedBranch(exec: Exec, root: string, branch: FlowBranch): Promise<string | null> {
  const git = (...args: string[]) => exec('git', args, root)
  const listed = await git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`)
  if (listed.code !== 0) throw new Error(`git ls-remote --heads origin refs/heads/${branch} failed, so whether origin has a ${branch} branch is unknown:\n${tail(listed.out)}`)
  const sha = listed.out.split('\n').map((l) => l.trim().split(/\s+/)).find(([, ref]) => ref === `refs/heads/${branch}`)?.[0]
  if (!sha) return null
  // Both tips as GitHub has them now.
  const fetched = await git('fetch', '-q', 'origin', 'main', branch)
  if (fetched.code !== 0) throw new Error(`git fetch origin main ${branch} failed:\n${tail(fetched.out)}`)
  const merged = await git('merge-base', '--is-ancestor', sha, 'origin/main')
  if (merged.code === 0) return null
  if (merged.code !== 1) throw new Error(`git merge-base --is-ancestor ${sha.slice(0, 7)} origin/main failed:\n${tail(merged.out)}`)
  return `origin has a ${branch} branch (${sha.slice(0, 7)}) that is not in origin/main: merge or close that flow first (if it was squash-merged already, delete the branch on GitHub)`
}

/** Both obstacles from the other flow's `branch` (merge): an unmerged branch on origin, an open PR. */
export async function flowObstacles(exec: Exec, root: string, repo: string, branch: FlowBranch): Promise<string[]> {
  const out: string[] = []
  const unmerged = await unmergedBranch(exec, root, branch)
  if (unmerged) out.push(unmerged)
  for (const pr of await openPrsFrom(exec, root, repo, branch)) out.push(`open ${branch} PR ${pr.url}: merge or close it first`)
  return out
}
