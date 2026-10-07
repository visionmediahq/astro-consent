// The pr stage (spec C4): opens the consent-banner PR on a client site repo with a Swedish body.
// The body is built only from the branch's src/data/privacy.json (which template block: Ruling 40),
// the Report, verify.json (step names and results, never evidence text),
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
  /** Which template block: from the branch's privacy.json (`templateKind`), not the classification. */
  kind: 'maps' | 'notice'
  verify: VerifyResult
  /** Issue URLs. */
  issues: string[]
  domain: string
  files?: string[]
  screenshots?: { file: string; url: string }[]
}

/** Fills `{{name}}` values and `{{#maps}}…{{/maps}}` / `{{#notice}}…{{/notice}}` blocks. */
export function renderBody(template: string, input: BodyInput): string {
  const { kind, verify, issues, domain } = input
  if (!verify.pass) throw new Error('verify did not pass: no PR body')
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

/**
 * Ruling 40: the template block for the branch's src/data/privacy.json text: `maps` when its
 * services list google-maps, else `notice`. A hand-wired needs-human site gets its PR this way.
 */
export function templateKind(privacyJson: string): 'maps' | 'notice' {
  let json: unknown
  try {
    json = JSON.parse(privacyJson)
  } catch (e) {
    throw new Error(`src/data/privacy.json on the branch is not JSON: ${(e as Error).message}`)
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error('src/data/privacy.json on the branch is not an object')
  const services = (json as { services?: unknown }).services
  return Array.isArray(services) && services.includes('google-maps') ? 'maps' : 'notice'
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
 * if it moved and verifies again in full. An open PR from consent-banner titled TITLE is returned as
 * it is; one with another title is someone else's and is refused.
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

  const privacy = await git('show', 'HEAD:src/data/privacy.json')
  if (privacy.code !== 0) throw new Error(`src/data/privacy.json is not on the branch: wire the site first\n${tail(privacy.out)}`)
  const kind = templateKind(privacy.out)

  const existing = await exec('gh', ['pr', 'list', '-R', repo, '--head', BRANCH, '--state', 'open', '--json', 'url,title'], root)
  if (existing.code !== 0) throw new Error(`gh pr list failed:\n${tail(existing.out)}`)
  const open = (JSON.parse(existing.out || '[]') as { url: string; title: string }[])[0]
  if (open && open.title !== TITLE) {
    throw new Error(`an open PR from ${BRANCH} is not this tool's: ${open.url} "${open.title}" (expected "${TITLE}"); resolve it by hand`)
  }
  if (open) return { url: open.url, files }

  const changed = (await git('diff', '--name-only', 'origin/main...HEAD')).out.split('\n').filter(Boolean)
  const body = renderBody(readFileSync(TEMPLATE_PATH, 'utf8'), {
    kind,
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
