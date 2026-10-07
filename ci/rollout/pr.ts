// The pr stage (spec C4): opens the consent-banner PR on a client site repo with a Swedish body.
// The body is built only from the Report, verify.json (step names and results, never evidence text),
// the changed file names and issue links. Screenshots are not committed to the site repo: openPr
// returns the files to copy into site-factory (`screenshotsDir`), and the body links them under
// `screenshotsBase`. The copy, commit and push of site-factory is the controller's job.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type Exec, exec as realExec, tail } from './lib/exec'
import type { Report, VerifyResult } from './types'
import { ORIGIN, verify as realVerify } from './verify'
import { BRANCH } from './wire/index'

export const TITLE = 'Samtyckesbanner (astro-consent 1.0)'
export const TEMPLATE_PATH = join(import.meta.dirname, 'pr-body.sv.md')

export interface BodyInput {
  report: Report
  verify: VerifyResult
  /** Issue URLs. */
  issues: string[]
  domain: string
  files?: string[]
  screenshots?: { file: string; url: string }[]
}

/** Fills `{{name}}` values and `{{#maps}}…{{/maps}}` / `{{#notice}}…{{/notice}}` blocks. */
export function renderBody(template: string, input: BodyInput): string {
  const { report, verify, issues, domain } = input
  if (!verify.pass) throw new Error('verify did not pass: no PR body')
  const kind = report.classification
  if (kind !== 'maps' && kind !== 'notice') throw new Error(`classification ${kind} is not wired by the rollout`)
  const values: Record<string, string> = {
    domain,
    files: (input.files?.length ? input.files : ['(se diffen)']).map((f) => `- \`${f}\``).join('\n'),
    steps: verify.steps.map((s) => `- ${s.skipped ? 'hoppades över' : s.pass ? 'ok' : 'FEL'}: ${s.step}. ${s.name}`).join('\n'),
    screenshots: input.screenshots?.length ? input.screenshots.map((s) => `- [${s.file}](${s.url})`).join('\n') : 'Inga.',
    issues: issues.length ? issues.map((i) => `- ${i}`).join('\n') : 'Inga',
  }
  const out = template
    .replace(/\{\{#(maps|notice)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, name: string, text: string) => (name === kind ? text : ''))
    .replace(/\{\{(\w+)\}\}/g, (m, name: string) => values[name] ?? m)
  const left = out.match(/\{\{[^}]*\}\}/)
  if (left) throw new Error(`unfilled placeholder ${left[0]} in the PR body template`)
  return out
}

export interface PrOptions {
  exec?: Exec
  issues?: string[]
  /** Folder in site-factory the screenshots are copied to, e.g. docs/rollout/2026-10-06-astro-consent/<site>. */
  screenshotsDir: string
  /** The GitHub URL of that folder (no trailing slash). */
  screenshotsBase: string
  /** Replaces the full verify run (which pushes the branch) after a rebase. */
  verify?: (dir: string, report: Report) => Promise<VerifyResult>
  domain?: string
}

export interface PrResult {
  url: string
  /** Screenshots to copy: absolute source, destination relative to site-factory. */
  files: { from: string; to: string }[]
}

/** 'visionmediahq/<repo>' from the origin URL; throws for any other remote. */
export function originRepo(url: string): string {
  const repo = ORIGIN.test(url) ? url.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '').replace(/\/+$/, '') : null
  if (!repo || !/^visionmediahq\/[\w.-]+$/.test(repo)) throw new Error(`origin is ${url || '(none)'}, not a github.com/visionmediahq repo`)
  return repo
}

const readJson = <T>(path: string, what: string): T => {
  if (!existsSync(path)) throw new Error(`${path} not found: ${what}`)
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/**
 * Opens the PR for the site in `dir` (on consent-banner, verified). Rebases onto origin/main first
 * if it moved and verifies again in full. An open PR from consent-banner is returned as it is.
 */
export async function openPr(dir: string, opts: PrOptions): Promise<PrResult> {
  const exec = opts.exec ?? realExec
  const root = resolve(dir)
  const git = (...args: string[]) => exec('git', args, root)
  const report = readJson<Report>(join(root, '.rollout/report.json'), 'run detect first')

  const head = (await git('rev-parse', '--abbrev-ref', 'HEAD')).out.trim()
  if (head !== BRANCH) throw new Error(`pr runs on branch ${BRANCH}; ${root} is on ${head || '(unknown)'}`)
  const repo = originRepo((await git('remote', 'get-url', 'origin')).out.trim())

  const fetched = await git('fetch', 'origin', 'main')
  if (fetched.code !== 0) throw new Error(`git fetch origin main failed:\n${tail(fetched.out)}`)
  const ancestor = await git('merge-base', '--is-ancestor', 'origin/main', 'HEAD')
  if (ancestor.code === 1) {
    const rebase = await git('rebase', 'origin/main')
    if (rebase.code !== 0) {
      await git('rebase', '--abort')
      throw new Error(`rebase onto origin/main conflicts, aborted: resolve by hand\n${tail(rebase.out)}`)
    }
  } else if (ancestor.code !== 0) {
    throw new Error(`git merge-base --is-ancestor failed:\n${tail(ancestor.out)}`)
  }
  const rebased = ancestor.code === 1
  // Only a passing verify run of this exact commit counts; verify wipes .rollout/shots when it
  // starts, so the screenshots below always belong to that run.
  const current = (await git('rev-parse', 'HEAD')).out.trim()
  const stored = existsSync(join(root, '.rollout/verify.json')) ? readJson<Partial<VerifyResult>>(join(root, '.rollout/verify.json'), '') : null
  let result: VerifyResult
  if (!rebased && stored?.pass === true && stored.sha && stored.sha === current) {
    result = stored as VerifyResult
  } else {
    result = await (opts.verify ?? ((d, r) => realVerify(d, r)))(root, report)
    if (!result.pass) throw new Error('verify did not pass: fix and run verify again before the PR')
    if (result.sha !== current) throw new Error(`verify ran for ${result.sha ?? '(no commit)'}, HEAD is ${current}`)
  }

  const shotsDir = join(root, '.rollout/shots')
  const names = existsSync(shotsDir) ? readdirSync(shotsDir).filter((f) => f.endsWith('.png')).sort() : []
  const files = names.map((n) => ({ from: join(shotsDir, n), to: `${opts.screenshotsDir.replace(/\/+$/, '')}/${n}` }))

  const existing = await exec('gh', ['pr', 'list', '-R', repo, '--head', BRANCH, '--state', 'open', '--json', 'url'], root)
  if (existing.code !== 0) throw new Error(`gh pr list failed:\n${tail(existing.out)}`)
  const open = (JSON.parse(existing.out || '[]') as { url: string }[])[0]
  if (open) return { url: open.url, files }

  const changed = (await git('diff', '--name-only', 'origin/main...HEAD')).out.split('\n').filter(Boolean)
  const body = renderBody(readFileSync(TEMPLATE_PATH, 'utf8'), {
    report,
    verify: result,
    issues: opts.issues ?? [],
    domain: opts.domain ?? report.domains[0] ?? report.site,
    files: changed,
    screenshots: names.map((n) => ({ file: n, url: `${opts.screenshotsBase.replace(/\/+$/, '')}/${n}` })),
  })
  const bodyFile = join(root, '.rollout/pr-body.md')
  writeFileSync(bodyFile, body)
  const created = await exec('gh', ['pr', 'create', '-R', repo, '-H', BRANCH, '-B', 'main', '-t', TITLE, '-F', bodyFile], root)
  const link = created.out.trim().split('\n').pop() ?? ''
  if (created.code !== 0 || !/^https:\/\/github\.com\//.test(link)) throw new Error(`gh pr create failed:\n${tail(created.out)}`)
  return { url: link, files }
}
