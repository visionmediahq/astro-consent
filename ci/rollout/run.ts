// The rollout CLI. Each stage writes its JSON to <site dir>/.rollout/, which is excluded from git
// through .git/info/exclude, so stages can be rerun one at a time.
//
//   tsx ci/rollout/run.ts detect <site dir> --domain <d> [--domain <d2>]
//   tsx ci/rollout/run.ts wire   <site dir> [--dry-run]
//   tsx ci/rollout/run.ts verify <site dir>
//   tsx ci/rollout/run.ts verify --demo <dist dir>   CI/self-test: a built demo, no git/npm/Docker
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff'
import { detect } from './detect/index'
import { diskSite } from './lib/site-files'
import type { Report } from './types'
import { formatVerify, verify } from './verify'
import { applyWire, BRANCH, planFiles, planWire, refusalLines } from './wire/index'

const DETECT_USAGE = 'usage: tsx ci/rollout/run.ts detect <site dir> --domain <domain> [--domain <domain>]'
const WIRE_USAGE = 'usage: tsx ci/rollout/run.ts wire <site dir> [--dry-run]'
const VERIFY_USAGE = 'usage: tsx ci/rollout/run.ts verify <site dir> | verify --demo <dist dir>'
const USAGE = `${DETECT_USAGE}\n${WIRE_USAGE}\n${VERIFY_USAGE}`
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
    `${report.site} (${report.domains.join(', ')}): ${report.classification}`,
    `  astro ${report.astro.major} ${report.astro.output}, config ${report.config.path}`,
    `  iframes ${report.iframes.length}, footers ${report.footers.length}, policy page ${report.policyPage ?? 'none'}`,
  ]
  if (report.trackers.length) lines.push(`  trackers: ${report.trackers.join(', ')}`)
  if (report.banners.length) lines.push(`  banners: ${report.banners.join(', ')}`)
  for (const reason of report.reasons) lines.push(`  - ${reason}`)
  return lines.join('\n')
}

export function parseWireArgs(args: string[]): { dir: string; dryRun: boolean } {
  let dir: string | null = null
  let dryRun = false
  for (const arg of args) {
    if (arg === '--dry-run') dryRun = true
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}\n${WIRE_USAGE}`)
    else if (dir === null) dir = arg
    else throw new Error(`one site dir only\n${WIRE_USAGE}`)
  }
  if (dir === null) throw new Error(WIRE_USAGE)
  return { dir, dryRun }
}

function readReport(root: string): Report {
  const path = join(root, '.rollout/report.json')
  if (!existsSync(path)) throw new Error(`${path} not found: run detect first`)
  return JSON.parse(readFileSync(path, 'utf8')) as Report
}

/**
 * Plans the wiring of the site in `dir` from its `.rollout/report.json`. A dry run returns the
 * report summary, the plan summary, the unified diff and any refusals, and writes nothing at all
 * (spec C2). Otherwise the plan is applied and committed on branch consent-banner. Exit code 1
 * when the plan is refused.
 */
export function runWire(dir: string, opts: { dryRun: boolean }): { code: number; output: string } {
  const root = resolve(dir)
  const report = readReport(root)
  const site = diskSite(root)
  const plan = planWire(site, report)
  const lines = [summary(report)]
  if (!plan.ok) {
    lines.push(`wire: refused, nothing ${opts.dryRun ? 'would be' : 'was'} written`, ...refusalLines(plan).map((l) => `  ${l}`))
    return { code: 1, output: `${lines.join('\n')}\n` }
  }
  const files = planFiles((path) => site.read(path), plan)
  lines.push(
    `wire: ${plan.edits.length} edits in ${new Set(plan.edits.map((e) => e.file)).size} files, ${plan.newFiles.length} new files, ${plan.skipped.length} skipped`,
    ...files.map((f) => `  ${f.before === null ? 'new ' : 'edit'} ${f.path}`),
    ...plan.skipped.map((t) => `  skip ${t}`),
  )
  if (opts.dryRun) {
    const diff = files.map((f) =>
      createTwoFilesPatch(f.before === null ? '/dev/null' : `a/${f.path}`, `b/${f.path}`, f.before ?? '', f.after, undefined, undefined, {
        context: 3,
        headerOptions: FILE_HEADERS_ONLY,
      }),
    )
    return { code: 0, output: `${lines.join('\n')}\n\n${diff.join('')}` }
  }
  applyWire(root, plan, { commit: true })
  lines.push(`committed on ${BRANCH}`)
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
 * verify <site dir>: spec C3 on the checkout's consent-banner branch with its .rollout/report.json.
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
    const report = args.demo ? (JSON.parse(readFileSync(DEMO_REPORT, 'utf8')) as Report) : readReport(dir)
    const out = args.demo ? mkdtempSync(join(tmpdir(), 'rollout-verify-demo-')) : join(dir, '.rollout')
    const result = await verify(dir, report, { demo: args.demo, out })
    for (const step of result.steps) {
      console.log(`--- step ${step.step} ${step.name}: ${step.skipped ? 'skipped' : step.pass ? 'pass' : 'FAIL'}`)
      if (!step.skipped) console.log(step.evidence.replace(/^/gm, '  '))
    }
    for (const line of formatVerify(result)) console.log(line)
    console.log(`  → ${join(out, 'verify.json')}`)
    return result.pass ? 0 : 1
  } catch (e) {
    console.error((e as Error).message)
    return 1
  }
}

function mainWire(rest: string[]): number {
  let args: { dir: string; dryRun: boolean }
  try {
    args = parseWireArgs(rest)
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }
  try {
    const { code, output } = runWire(args.dir, { dryRun: args.dryRun })
    process.stdout.write(output)
    return code
  } catch (e) {
    console.error((e as Error).message)
    return 1
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === 'wire') return mainWire(rest)
  if (command === 'verify') return mainVerify(rest)
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
  const report = runDetect(args.dir, args.domains)
  console.log(summary(report))
  console.log(`  → ${join(resolve(args.dir), '.rollout/report.json')}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)))
}
