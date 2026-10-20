// The rollout CLI. Each stage writes its JSON to <site dir>/.rollout/, which is excluded from git
// through .git/info/exclude, so stages can be rerun one at a time.
//
//   tsx ci/rollout/run.ts detect <site dir> --domain <d> [--domain <d2>]
//   tsx ci/rollout/run.ts wire   <site dir> [--dry-run] [--no-fonts]
//   tsx ci/rollout/run.ts fonts  <site dir> [--dry-run]       Google Fonts alone, branch fonts-selfhost
//   tsx ci/rollout/run.ts fonts-files <site dir> --url <css2 url> [--entry <css>] [--dry-run]   files only, no git
//   tsx ci/rollout/run.ts verify <site dir>
//   tsx ci/rollout/run.ts verify --demo <dist dir>   CI/self-test: a built demo, no git/npm/Docker
//   tsx ci/rollout/run.ts pr     <site dir> --shots-dir <path> --shots-base <url> [--issue <url>]...
//   tsx ci/rollout/run.ts live   <site dir> baseline | post-merge [--sha <merge commit>]
//   tsx ci/rollout/run.ts merge  <site dir> <pr number>
//
// Exit codes: 0 ok, 1 error/failed check/STOP, 2 usage, 3 wire plan refused (see USAGE).
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff'
import { detect } from './detect/index'
import { diskSite } from './lib/site-files'
import { exec } from './lib/exec'
import { type FlowBranch, isFlowBranch, openPrsFrom, statePath } from './flows'
import { classificationLine, normaliseReport } from './lib/report'
import type { Report } from './types'
import { formatLive, live } from './live'
import { merge } from './merge'
import { openPr, originRepo } from './pr'
import { formatVerify, verify } from './verify'
import { main as mainFontsFiles } from './fonts-files'
import { commitFonts, FONTS_BRANCH, type FontFetch, type FontsFile, fontsFiles, fontsTargetsTaken, planFonts } from './wire/fonts'
import { applyWire, BRANCH, planFiles, planWire, refusalLines } from './wire/index'

const DETECT_USAGE = 'usage: tsx ci/rollout/run.ts detect <site dir> --domain <domain> [--domain <domain>]'
const WIRE_USAGE = 'usage: tsx ci/rollout/run.ts wire <site dir> [--dry-run] [--no-fonts]'
const FONTS_USAGE = 'usage: tsx ci/rollout/run.ts fonts <site dir> [--dry-run]'
const FONTS_FILES_USAGE = 'usage: tsx ci/rollout/run.ts fonts-files <site dir> --url <css2 url> [--entry <css file>] [--dry-run]'
const VERIFY_USAGE = 'usage: tsx ci/rollout/run.ts verify <site dir> | verify --demo <dist dir>'
const PR_USAGE =
  'usage: tsx ci/rollout/run.ts pr <site dir> --shots-dir <path in site-factory> --shots-base <github url of that folder> [--issue <url>]... [--domain <d>]'
const LIVE_USAGE = 'usage: tsx ci/rollout/run.ts live <site dir> baseline | post-merge [--sha <merge commit>]'
const MERGE_USAGE = 'usage: tsx ci/rollout/run.ts merge <site dir> <pr number>'
export const USAGE = [
  DETECT_USAGE,
  WIRE_USAGE,
  FONTS_USAGE,
  FONTS_FILES_USAGE,
  VERIFY_USAGE,
  PR_USAGE,
  LIVE_USAGE,
  MERGE_USAGE,
  '',
  'Every stage reads and writes <site dir>/.rollout/ (kept out of git through .git/info/exclude);',
  'verify --demo writes to a temp folder instead.',
  '',
  'exit codes:',
  '  0  ok (live baseline: also the expected RED)',
  '  1  error, a failed verify step, or a live/merge STOP',
  '  2  usage: bad command or arguments',
  '  3  wire, fonts, fonts-files: the plan was refused (dry run or not); nothing was written',
].join('\n')
/** Exit code of a refused wire plan (Ruling 32). */
export const EXIT_REFUSED = 3
const DEMO_REPORT = join(import.meta.dirname, '../../tests/unit/rollout/fixtures/demo-report.json')

export function parseDetectArgs(args: string[]): { dir: string; domains: string[] } {
  let dir: string | null = null
  const domains: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    let value: string | undefined
    if (arg === '--domain') value = args[++i]
    else if (arg.startsWith('--domain=')) value = arg.slice('--domain='.length)
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}\n${DETECT_USAGE}`)
    else if (dir === null) {
      dir = arg
      continue
    } else throw new Error(`one site dir only\n${DETECT_USAGE}`)
    if (!value) throw new Error(`--domain needs a value\n${DETECT_USAGE}`)
    if (!/^[a-z0-9.-]+$/i.test(value)) throw new Error(`--domain takes a bare host, not ${value}`)
    domains.push(value.toLowerCase())
  }
  if (dir === null) throw new Error(DETECT_USAGE)
  if (domains.length === 0) throw new Error(`at least one --domain is required\n${DETECT_USAGE}`)
  return { dir, domains }
}

/** The checkout's own info/exclude. Refuses a dir that is not the top of a git checkout. */
function excludeFile(dir: string): string {
  let top: string
  let path: string
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    path = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    throw new Error(`${dir} is not a git checkout`)
  }
  if (realpathSync(top) !== realpathSync(dir)) throw new Error(`${dir} is not the top of its git checkout (${top})`)
  return isAbsolute(path) ? path : join(dir, path)
}

function excludeRollout(dir: string): void {
  const file = excludeFile(dir)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (text.split(/\r?\n/).includes('.rollout/')) return
  mkdirSync(join(file, '..'), { recursive: true })
  appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}.rollout/\n`)
}

/** Detects the site in `dir`, writes `.rollout/report.json` and keeps `.rollout/` out of git. */
export function runDetect(dir: string, domains: string[]): Report {
  const root = resolve(dir)
  excludeRollout(root)
  const report = detect(diskSite(root), basename(root), domains)
  mkdirSync(join(root, '.rollout'), { recursive: true })
  writeFileSync(join(root, '.rollout/report.json'), `${JSON.stringify(report, null, 2)}\n`)
  return report
}

export function summary(report: Report): string {
  const lines = [
    `${report.site} (${report.domains.join(', ')}): ${classificationLine(report)}`,
    `  astro ${report.astro.major} ${report.astro.output}, config ${report.config.path}`,
    `  iframes ${report.iframes.length}, footers ${report.footers.length}, policy page ${report.policyPage ?? 'none'}`,
  ]
  if (report.trackers.length) lines.push(`  trackers: ${report.trackers.join(', ')}`)
  if (report.banners.length) lines.push(`  banners: ${report.banners.join(', ')}`)
  for (const reason of report.reasons) lines.push(`  - ${reason}`)
  if (report.fonts) {
    lines.push(`  google fonts: ${report.fonts.status}${report.fonts.url ? ` ${report.fonts.url}` : ''}`)
    for (const reason of report.fonts.reasons) lines.push(`    - ${reason}`)
  }
  return lines.join('\n')
}

/** Fonts are self-hosted by default (site-factory#220); `--no-fonts` wires the banner alone. */
export function parseWireArgs(args: string[]): { dir: string; dryRun: boolean; fonts: boolean } {
  let dir: string | null = null
  let dryRun = false
  let fonts = true
  for (const arg of args) {
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--no-fonts') fonts = false
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}${arg === '--fonts' ? ' (fonts are self-hosted by default now; --no-fonts skips them)' : ''}\n${WIRE_USAGE}`)
    else if (dir === null) dir = arg
    else throw new Error(`one site dir only\n${WIRE_USAGE}`)
  }
  if (dir === null) throw new Error(WIRE_USAGE)
  return { dir, dryRun, fonts }
}

export function parseFontsArgs(args: string[]): { dir: string; dryRun: boolean } {
  let dir: string | null = null
  let dryRun = false
  for (const arg of args) {
    if (arg === '--dry-run') dryRun = true
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}\n${FONTS_USAGE}`)
    else if (dir === null) dir = arg
    else throw new Error(`one site dir only\n${FONTS_USAGE}`)
  }
  if (dir === null) throw new Error(FONTS_USAGE)
  return { dir, dryRun }
}

/** Unified diffs of text files; a line for each other file (woff2, licences). */
function diffOf(files: { path: string; before: string | null; after: string | Uint8Array }[], showNew: (path: string) => boolean = () => true): string {
  return files
    .filter((f) => typeof f.after === 'string' && (f.before !== null || showNew(f.path)))
    .map((f) =>
      createTwoFilesPatch(f.before === null ? '/dev/null' : `a/${f.path}`, `b/${f.path}`, f.before ?? '', f.after as string, undefined, undefined, {
        context: 3,
        headerOptions: FILE_HEADERS_ONLY,
      }),
    )
    .join('')
}

const fileLines = (files: FontsFile[]): string[] =>
  files.map((f) => (f.before === null ? `  new  ${f.path}${typeof f.after === 'string' && f.path.endsWith('.css') ? '' : ` (${typeof f.after === 'string' ? Buffer.byteLength(f.after) : f.after.length} bytes)`}` : `  edit ${f.path}`))

export interface WireRunOptions {
  dryRun: boolean
  /** Self-host the Google Fonts too, as a second commit (default true; false: --no-fonts). */
  fonts?: boolean
  /** The network for the fonts; real fetch unless a test injects recordings. */
  fetch?: FontFetch
  now?: Date
  /** The npm install of the package; real unless a test injects its own. */
  install?: (dir: string) => void
  /** Open PRs from a branch on the site's GitHub repo; gh unless a test injects its own. */
  openPrs?: OpenPrs
}

/** Open PRs (their URLs) from `branch` on the site's GitHub repo. */
export type OpenPrs = (root: string, branch: FlowBranch) => Promise<string[]>

function readReport(root: string): Report {
  const path = join(root, '.rollout/report.json')
  if (!existsSync(path)) throw new Error(`${path} not found: run detect first`)
  return normaliseReport(JSON.parse(readFileSync(path, 'utf8')))
}

/**
 * Plans the wiring of the site in `dir` from its `.rollout/report.json`. A dry run returns the
 * report summary, the plan summary, the unified diff and any refusals, and writes nothing at all
 * (spec C2). Otherwise the plan is applied and committed on branch consent-banner. Exit code 3
 * when the plan is refused, dry run or not (Ruling 32), and (not a dry run) while origin has a
 * fonts-selfhost branch main does not contain or an open fonts-selfhost PR: the two would conflict.
 *
 * When `report.fonts.status` is `wire` (and not `fonts: false`, --no-fonts), the site's Google
 * Fonts are self-hosted too, planned in full (network included) before anything is written, and
 * committed as a second commit on consent-banner. A refused fonts plan refuses the whole wire.
 */
export async function runWire(dir: string, opts: WireRunOptions): Promise<{ code: number; output: string }> {
  const root = resolve(dir)
  const report = readReport(root)
  const site = diskSite(root)
  const plan = planWire(site, report)
  const lines = [summary(report)]
  const nothing = `nothing ${opts.dryRun ? 'would be' : 'was'} written`
  if (!plan.ok) {
    lines.push(`wire: refused, ${nothing}`, ...refusalLines(plan).map((l) => `  ${l}`))
    return { code: EXIT_REFUSED, output: `${lines.join('\n')}\n` }
  }
  if (!opts.dryRun) {
    const conflicts = await flowConflicts(root, FONTS_BRANCH, 'wire', opts.openPrs ?? openPrsOn)
    if (conflicts.length) {
      lines.push(`wire: refused, ${nothing}`, ...conflicts.map((l) => `  ${l}`))
      return { code: EXIT_REFUSED, output: `${lines.join('\n')}\n` }
    }
  }
  const read = (path: string) => site.read(path)
  const files = planFiles(read, plan)
  let fonts: FontsFile[] | null = null
  let fontNotes: string[] = []
  if (opts.fonts !== false && report.fonts?.status === 'wire') {
    const refusedFonts = (reasons: string[]) => {
      lines.push(`wire: google fonts refused, ${nothing} (wire --no-fonts wires the banner alone)`, ...reasons.map((l) => `  ${l}`))
      return { code: EXIT_REFUSED, output: `${lines.join('\n')}\n` }
    }
    const taken = fontsTargetsTaken(root)
    if (taken) return refusedFonts([taken])
    const fp = await planFonts(site, report, { ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.now ? { now: opts.now } : {}) })
    if (!fp.ok) return refusedFonts(refusalLines(fp))
    try {
      fonts = fontsFiles(read, fp, plan.edits)
    } catch (e) {
      return refusedFonts([(e as Error).message])
    }
    fontNotes = fp.notes
  }
  lines.push(
    `wire: ${plan.edits.length} edits in ${new Set(plan.edits.map((e) => e.file)).size} files, ${plan.newFiles.length} new files, ${plan.skipped.length} skipped`,
    ...files.map((f) => `  ${f.before === null ? 'new ' : 'edit'} ${f.path}`),
    ...plan.skipped.map((t) => `  skip ${t}`),
  )
  if (fonts) lines.push(...fontNotes, ...fileLines(fonts))
  if (opts.dryRun) {
    const diff = diffOf(files)
    const fontsDiff = fonts ? diffOf(fonts, (p) => p.endsWith('.css')) : ''
    return { code: 0, output: `${lines.join('\n')}\n\n${diff}${fontsDiff}` }
  }
  lines.push(...applyWire(root, plan, { commit: true, ...(opts.install ? { install: opts.install } : {}) }))
  if (fonts) commitFonts(root, fonts, { onto: BRANCH })
  lines.push(`committed on ${BRANCH}${fonts ? ' (2 commits)' : ''}`)
  return { code: 0, output: `${lines.join('\n')}\n` }
}

/** Open PRs from `branch` on the site's GitHub repo (gh); a non-GitHub origin is an error. */
export async function openPrsOn(root: string, branch: FlowBranch): Promise<string[]> {
  const repo = originRepo(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim())
  return (await openPrsFrom(exec, root, repo, branch)).map((p) => p.url)
}

/**
 * Why a flow would conflict with the other flow's `branch` (flows.ts): a `branch` on origin that
 * origin/main does not contain, or an open PR from it. A local branch left behind by a squash merge
 * is not one (merge deletes the branch on GitHub). `stage` names the command to rerun.
 */
async function flowConflicts(root: string, branch: FlowBranch, stage: string, openPrs: OpenPrs): Promise<string[]> {
  const out: string[] = []
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const unknown = (what: string, e: unknown) =>
    new Error(`${what} failed, so whether origin has a ${branch} branch is unknown; nothing written\n${(e as Error).message}`)
  let listed: string
  try {
    listed = git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`)
  } catch (e) {
    throw unknown(`git ls-remote --heads origin refs/heads/${branch}`, e)
  }
  const sha = listed.split('\n').map((l) => l.trim().split(/\s+/)).find(([, ref]) => ref === `refs/heads/${branch}`)?.[0]
  const what = branch === BRANCH ? 'the banner' : 'the fonts'
  if (sha) {
    // Both tips as GitHub has them now: main may have moved since the clone's last fetch.
    try {
      git('fetch', '-q', 'origin', `+refs/heads/main:refs/remotes/origin/main`, `refs/heads/${branch}`)
    } catch (e) {
      throw unknown(`git fetch origin main ${branch}`, e)
    }
    let merged: boolean
    try {
      git('merge-base', '--is-ancestor', sha, 'origin/main')
      merged = true
    } catch {
      merged = false
    }
    if (!merged) {
      out.push(
        `origin has a ${branch} branch (${sha.slice(0, 7)}) that is not in origin/main: if it was already merged (squash), delete it on GitHub; otherwise merge or close ${what} first. Then detect and ${stage} again`,
      )
    }
  }
  for (const url of await openPrs(root, branch)) out.push(`open ${branch} PR ${url}: merge or close it first, then detect and ${stage} again`)
  return out
}

/**
 * fonts <site dir>: self-hosts the Google Fonts of a site whose banner is already live, on a new
 * branch fonts-selfhost from origin/main with one commit. A dry run prints the diff and writes
 * nothing. Exit code 3 when the plan is refused, or while origin has a consent-banner branch main
 * does not contain or an open consent-banner PR.
 */
export async function runFonts(
  dir: string,
  opts: { dryRun: boolean; fetch?: FontFetch; now?: Date; openPrs?: OpenPrs },
): Promise<{ code: number; output: string }> {
  const root = resolve(dir)
  const report = readReport(root)
  const site = diskSite(root)
  const lines = [summary(report)]
  const refused = (reasons: string[]) => {
    lines.push(`fonts: refused, nothing ${opts.dryRun ? 'would be' : 'was'} written`, ...reasons.map((l) => `  ${l}`))
    return { code: EXIT_REFUSED, output: `${lines.join('\n')}\n` }
  }
  const conflicts = await flowConflicts(root, BRANCH, 'fonts', opts.openPrs ?? openPrsOn)
  if (conflicts.length) return refused(conflicts)
  const fp = await planFonts(site, report, { ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.now ? { now: opts.now } : {}) })
  if (!fp.ok) return refused(refusalLines(fp))
  const files = fontsFiles((path) => site.read(path), fp)
  lines.push(...fp.notes, ...fileLines(files))
  if (opts.dryRun) return { code: 0, output: `${lines.join('\n')}\n\n${diffOf(files, (p) => p.endsWith('.css'))}` }
  commitFonts(root, files, { branch: FONTS_BRANCH })
  lines.push(`committed on ${FONTS_BRANCH}`)
  return { code: 0, output: `${lines.join('\n')}\n` }
}


export function parseVerifyArgs(args: string[]): { dir: string; demo: boolean } {
  let dir: string | null = null
  let demo = false
  for (const arg of args) {
    if (arg === '--demo') demo = true
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}\n${VERIFY_USAGE}`)
    else if (dir === null) dir = arg
    else throw new Error(`one dir only\n${VERIFY_USAGE}`)
  }
  if (dir === null) throw new Error(VERIFY_USAGE)
  return { dir, demo }
}

/**
 * verify <site dir>: spec C3 on the checkout's branch (a flow of flows.ts) with its .rollout/report.json.
 * verify --demo <dist dir>: the CI/self-test mode on a built demo (demo/dist-consent) with the
 * hand-written demo report; evidence goes to a temp folder. Exit code 1 when a step fails.
 */
async function mainVerify(rest: string[]): Promise<number> {
  let args: { dir: string; demo: boolean }
  try {
    args = parseVerifyArgs(rest)
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }
  try {
    const dir = resolve(args.dir)
    const report = args.demo ? normaliseReport(JSON.parse(readFileSync(DEMO_REPORT, 'utf8'))) : readReport(dir)
    const out = args.demo ? mkdtempSync(join(tmpdir(), 'rollout-verify-demo-')) : join(dir, '.rollout')
    const result = await verify(dir, report, { demo: args.demo, out })
    for (const step of result.steps) {
      console.log(`--- step ${step.step} ${step.name}: ${step.skipped ? 'skipped' : step.pass ? 'pass' : 'FAIL'}`)
      if (!step.skipped) console.log(step.evidence.replace(/^/gm, '  '))
    }
    for (const line of formatVerify(result)) console.log(line)
    const head = args.demo ? 'consent-banner' : execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    const branch: FlowBranch = isFlowBranch(head) ? head : 'consent-banner'
    console.log(`  → ${statePath(out, 'verify.json', branch)}`)
    return result.pass ? 0 : 1
  } catch (e) {
    console.error((e as Error).message)
    return 1
  }
}

export function parsePrArgs(args: string[]): {
  dir: string
  issues: string[]
  shotsDir: string
  shotsBase: string
  domain?: string
} {
  let dir: string | null = null
  const issues: string[] = []
  const vals: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--issue' || arg === '--shots-dir' || arg === '--shots-base' || arg === '--domain') {
      const value = args[++i]
      if (!value) throw new Error(`${arg} needs a value\n${PR_USAGE}`)
      if (arg === '--issue') issues.push(value)
      else vals[arg] = value
    } else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}\n${PR_USAGE}`)
    else if (dir === null) dir = arg
    else throw new Error(`one site dir only\n${PR_USAGE}`)
  }
  if (dir === null) throw new Error(PR_USAGE)
  if (!vals['--shots-dir'] || !vals['--shots-base']) throw new Error(`--shots-dir and --shots-base are required\n${PR_USAGE}`)
  return { dir, issues, shotsDir: vals['--shots-dir'], shotsBase: vals['--shots-base'], ...(vals['--domain'] ? { domain: vals['--domain'] } : {}) }
}

/** pr <site dir>: opens the PR and prints its URL and the screenshots to copy into site-factory. */
async function mainPr(rest: string[]): Promise<number> {
  let args: ReturnType<typeof parsePrArgs>
  try {
    args = parsePrArgs(rest)
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }
  try {
    const r = await openPr(args.dir, {
      issues: args.issues,
      screenshotsDir: args.shotsDir,
      screenshotsBase: args.shotsBase,
      ...(args.domain ? { domain: args.domain } : {}),
    })
    console.log(r.url)
    for (const f of r.files) console.log(`copy ${f.from} -> ${f.to}`)
    return 0
  } catch (e) {
    console.error((e as Error).message)
    return 1
  }
}

export function parseLiveArgs(args: string[]): { dir: string; mode: 'baseline' | 'post-merge'; sha?: string } {
  const positional: string[] = []
  let sha: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--sha') {
      sha = args[++i]
      if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`--sha takes a full 40-character commit sha\n${LIVE_USAGE}`)
    } else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}\n${LIVE_USAGE}`)
    else positional.push(arg)
  }
  const [dir, mode] = positional
  if (positional.length !== 2 || !dir || (mode !== 'baseline' && mode !== 'post-merge')) throw new Error(LIVE_USAGE)
  if (sha && mode !== 'post-merge') throw new Error(`--sha is for post-merge only\n${LIVE_USAGE}`)
  return { dir, mode, ...(sha ? { sha } : {}) }
}

export function parseMergeArgs(args: string[]): { dir: string; pr: number } {
  if (args.length !== 2 || args.some((a) => a.startsWith('-'))) throw new Error(MERGE_USAGE)
  if (!/^[1-9]\d*$/.test(args[1]!)) throw new Error(`${args[1]} is not a PR number\n${MERGE_USAGE}`)
  return { dir: args[0]!, pr: Number(args[1]) }
}

/** live <site dir> <mode>: exit 0 for pass (and for the expected RED of baseline), 1 for a STOP. */
async function mainLive(rest: string[]): Promise<number> {
  let args: ReturnType<typeof parseLiveArgs>
  try {
    args = parseLiveArgs(rest)
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }
  try {
    const r = await live(args.dir, args.mode, args.sha)
    for (const line of formatLive(args.mode, r)) console.log(line)
    return r.status === 'stop' ? 1 : 0
  } catch (e) {
    console.error((e as Error).message)
    return 1
  }
}

/** merge <site dir> <pr>: exit 0 when merged, deployed and live-checked, 1 for a STOP. */
async function mainMerge(rest: string[]): Promise<number> {
  let args: ReturnType<typeof parseMergeArgs>
  try {
    args = parseMergeArgs(rest)
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }
  const r = await merge(args.dir, args.pr)
  if (r.live) for (const line of formatLive('post-merge', r.live)) console.log(line)
  if (r.mergeCommit) console.log(`merge commit ${r.mergeCommit}`)
  console.log(r.status === 'done' ? 'merge: DONE' : `merge: STOP (${r.reason ?? 'unknown'})`)
  return r.status === 'done' ? 0 : 1
}

async function mainWire(rest: string[]): Promise<number> {
  let args: ReturnType<typeof parseWireArgs>
  try {
    args = parseWireArgs(rest)
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }
  try {
    const { code, output } = await runWire(args.dir, { dryRun: args.dryRun, fonts: args.fonts })
    process.stdout.write(output)
    return code
  } catch (e) {
    console.error((e as Error).message)
    return 1
  }
}

async function mainFonts(rest: string[]): Promise<number> {
  let args: ReturnType<typeof parseFontsArgs>
  try {
    args = parseFontsArgs(rest)
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }
  try {
    const { code, output } = await runFonts(args.dir, { dryRun: args.dryRun })
    process.stdout.write(output)
    return code
  } catch (e) {
    console.error((e as Error).message)
    return 1
  }
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE)
    return 0
  }
  if (command === 'wire') return mainWire(rest)
  if (command === 'fonts') return mainFonts(rest)
  if (command === 'fonts-files') return mainFontsFiles(rest)
  if (command === 'verify') return mainVerify(rest)
  if (command === 'pr') return mainPr(rest)
  if (command === 'live') return mainLive(rest)
  if (command === 'merge') return mainMerge(rest)
  if (command !== 'detect') {
    console.error(USAGE)
    return 2
  }
  let args: { dir: string; domains: string[] }
  try {
    args = parseDetectArgs(rest)
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }
  try {
    const report = runDetect(args.dir, args.domains)
    console.log(summary(report))
    console.log(`  → ${join(resolve(args.dir), '.rollout/report.json')}`)
    return 0
  } catch (e) {
    console.error((e as Error).message)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)))
}
