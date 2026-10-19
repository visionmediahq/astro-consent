// The two flows of the rollout tool, keyed by the branch they live on (site-factory#220):
//
//   consent-banner  wire: the banner, and (unless --no-fonts) a second commit self-hosting the
//                   site's Google Fonts
//   fonts-selfhost  fonts: the Google Fonts commit alone, for a site whose banner is already live
//
// verify, pr, merge and live read the clone's current branch and refuse one that is not here. Each
// flow keeps its own state in .rollout/ (`verify-<branch>.json`, `pushed-<branch>.txt`, …), so a
// fonts verify never overwrites a banner verify. consent-banner falls back to the names used before
// the flows (`verify.json`, `pushed.txt`, …) when its own file is missing, so existing clones keep
// working.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type Exec, tail } from './lib/exec'
import { FONTS_BRANCH, FONTS_CSS } from './wire/fonts'
import { BRANCH } from './wire/index'

/** verify's steps, in order; the number of a step is its place here (1-based) in every flow. */
export const STEPS = ['lockfile', 'build', 'requests', 'consent-paths', 'clip', 'contrast', 'screenshots', 'fonts', 'docker'] as const
export type StepName = (typeof STEPS)[number]

export type FlowBranch = typeof BRANCH | typeof FONTS_BRANCH

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
  /** The other flow: its branch or open PR on GitHub refuses this one (they would conflict). */
  other: FlowBranch
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
    other: FONTS_BRANCH,
  },
  'fonts-selfhost': {
    branch: FONTS_BRANCH,
    title: 'Google Fonts från sajten själv',
    ownTitles: ['Google Fonts från sajten själv'],
    template: join(import.meta.dirname, 'pr-body.fonts.sv.md'),
    steps: ['lockfile', 'build', 'requests', 'clip', 'screenshots', 'fonts', 'docker'],
    skipWhy: 'banner-only check: not run on fonts-selfhost (the banner is already live)',
    other: BRANCH,
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
 * The per-branch name of a state file or folder in .rollout/: `verify.json` → `verify-<branch>.json`,
 * `evidence` → `evidence-<branch>`. Written under this name in every flow.
 */
export function stateName(name: string, branch: FlowBranch): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)}-${branch}${name.slice(dot)}` : `${name}-${branch}`
}

/** Where a stage writes state `name` of `branch` in the folder `rollout` (`<site>/.rollout`). */
export const statePath = (rollout: string, name: string, branch: FlowBranch): string => join(rollout, stateName(name, branch))

/**
 * Where a stage reads state `name` of `branch`: the per-branch file; for consent-banner, when that
 * is missing and the name used before the flows exists, that one.
 */
export function readStatePath(rollout: string, name: string, branch: FlowBranch): string {
  const own = statePath(rollout, name, branch)
  const legacy = join(rollout, name)
  return branch === BRANCH && !existsSync(own) && existsSync(legacy) ? legacy : own
}

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
