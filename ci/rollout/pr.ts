// The pr stage (spec C4): opens the PR of the checkout's flow (flows.ts) on a client site repo with
// a Swedish body. consent-banner: built from the branch's src/data/privacy.json (which template
// block: Ruling 40), plus a fonts paragraph when the branch self-hosts the Google Fonts.
// fonts-selfhost: from the families in the branch's src/styles/fonts.css. astro-consent-update: the
// versions from main's and the branch's lockfiles, the CHANGELOG.md entries in between, and whether
// every visitor is asked again (CONSENT_VERSION). Each takes the Report,
// the flow's verify result (step names and results, never evidence text), the changed file names
// and issue links. Screenshots are not committed to the site repo: openPr returns the files to copy
// into site-factory (`screenshotsDir`), and the body links them under `screenshotsBase`. The copy,
// commit and push of site-factory is the controller's job.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseFontsCss } from './checks/fonts'
import { currentFlow, FLOWS, fontsCssAt, openPrsFrom, statePath, unmergedBranch } from './flows'
import { type Exec, exec as realExec, tail } from './lib/exec'
import { normaliseReport } from './lib/report'
import { toolNote } from './lib/tool-version'
import { SERVICES, type ServiceSlug } from '../../src/services'
import sv from '../../src/text/sv.json'
import type { Report, VerifyResult } from './types'
import { ORIGIN, VERIFY_FILE, verify as realVerify } from './verify'
import { FONTS_BRANCH, FONTS_CSS } from './wire/fonts'
import { CHANGELOG_PATH, changelogBetween, consentVersionAt, reaskLine, UPDATE_BRANCH, updateSummary } from './wire/update'

/** The consent-banner PR's title. No version (#51): the range wire installs moves with each release. */
export const TITLE = FLOWS['consent-banner'].title
export const TEMPLATE_PATH = FLOWS['consent-banner'].template
export const FONTS_TEMPLATE_PATH = FLOWS['fonts-selfhost'].template

export interface BodyInput {
  /**
   * Which template block: `consent` or `notice` from the branch's privacy.json (`templateKind`),
   * not the classification; `fonts` for the fonts-selfhost template, `update` for astro-consent-update's.
   */
  kind: 'consent' | 'notice' | 'fonts' | 'update'
  /** The services of the consent block, in registry order; empty otherwise. */
  services: ServiceSlug[]
  verify: VerifyResult
  /** Issue URLs. */
  issues: string[]
  domain: string
  files?: string[]
  screenshots?: { file: string; url: string }[]
  /** The self-hosted families (fonts.css): the `{{#fonts}}` blocks are kept, and fill `{{families}}`. */
  fonts?: { families: string[] }
  /** astro-consent-update: the versions, the changelog entries in between, and `{{#reask}}` or `{{#noreask}}`. */
  update?: { from: string; to: string; reasks: boolean; changelog: { version: string; text: string }[] }
}

// Fills the placeholder texts exactly as src/components/EmbedPlaceholder.astro does.
const fill = (text: string, vars: Record<string, string>): string => text.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match)

const list = (items: string[]): string => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} och ${items[items.length - 1]}`)

/** Numbered test steps 2.. of the consent block: Neka, one step per service, then "Cookie-inställningar". */
function consentSteps(services: ServiceSlug[]): string {
  const steps = [
    'Klicka "Neka" och gå till en sida med externt innehåll: bara platshållare visas, inget innehåll laddas.',
    ...services.map((slug) => {
      const { name } = SERVICES[slug]
      return `Klicka "${fill(sv.embed.show, { name })}": innehållet laddas. Kryssa "${fill(sv.embed.remember, { name })}" så laddas det direkt framöver.`
    }),
    'Klicka "Cookie-inställningar" i sidfoten: bannern öppnas igen.',
  ]
  return steps.map((t, i) => `${i + 2}. ${t}`).join('\n')
}

/** The banner body's last test step, for the self-hosted fonts: numbered after the banner's own. */
function fontsStep(kind: BodyInput['kind'], services: ServiceSlug[]): string {
  const n = kind === 'consent' ? services.length + 4 : 4
  return `${n}. Öppna webbläsarens nätverksflik och ladda om sidan: inga anrop till \`fonts.googleapis.com\` eller \`fonts.gstatic.com\`, typsnitten hämtas från \`/fonts/\`.`
}

/** Fills `{{name}}` values and `{{#consent}}`, `{{#notice}}`, `{{#fonts}}` … `{{/…}}` blocks. */
export function renderBody(template: string, input: BodyInput): string {
  const { kind, services, verify, issues, domain } = input
  if (!verify.pass) throw new Error('verify did not pass: no PR body')
  const active = new Set<string>([kind, ...(input.fonts ? ['fonts'] : []), ...(input.update ? [input.update.reasks ? 'reask' : 'noreask'] : [])])
  const values: Record<string, string> = {
    domain,
    serviceNames: list(services.map((slug) => SERVICES[slug].name)),
    serviceSlugs: services.map((slug) => `\`${slug}\``).join(', '),
    consentSteps: consentSteps(services),
    fontsStep: fontsStep(kind, services),
    families: list(input.fonts?.families ?? []),
    files: (input.files?.length ? input.files : ['(se diffen)']).map((f) => `- \`${f}\``).join('\n'),
    tool: toolNote(verify.tool),
    steps: verify.steps.map((s) => `- ${s.skipped ? 'hoppades över' : s.pass ? 'ok' : 'FEL'}: ${s.step}. ${s.name}`).join('\n'),
    screenshots: input.screenshots?.length ? input.screenshots.map((s) => `- [${s.file}](${s.url})`).join('\n') : 'Inga.',
    issues: issues.length ? issues.map((i) => `- ${i}`).join('\n') : 'Inga',
    fromVersion: input.update?.from ?? '',
    toVersion: input.update?.to ?? '',
    changelog: (input.update?.changelog ?? []).map((e) => `#### ${e.version}\n\n${e.text}`).join('\n\n'),
  }
  const out = template
    .replace(/\{\{#(consent|notice|fonts|reask|noreask)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, name: string, text: string) => (active.has(name) ? text : ''))
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
  /** astro-consent-update: CONSENT_VERSION at an astro-consent commit (this checkout's git unless a test injects it). */
  consentVersionAt?: (sha: string) => number | null
  /** astro-consent-update: the CHANGELOG.md text (this checkout's unless a test gives one). */
  changelog?: string
}

export interface PrResult {
  url: string
  /** Screenshots to copy: absolute source, destination relative to site-factory. */
  files: { from: string; to: string }[]
}

/**
 * Ruling 40: the template block for the branch's src/data/privacy.json text: `consent` with its
 * services (registry order) when it lists any, else `notice`. A hand-wired needs-human site gets
 * its PR this way. A slug the registry does not know is refused.
 */
export function templateKind(privacyJson: string): { kind: 'consent' | 'notice'; services: ServiceSlug[] } {
  let json: unknown
  try {
    json = JSON.parse(privacyJson)
  } catch (e) {
    throw new Error(`src/data/privacy.json on the branch is not JSON: ${(e as Error).message}`)
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error('src/data/privacy.json on the branch is not an object')
  const listed = (json as { services?: unknown }).services
  const slugs = Array.isArray(listed) ? listed : []
  for (const slug of slugs) if (typeof slug !== 'string' || !Object.hasOwn(SERVICES, slug)) throw new Error(`unknown service ${String(slug)} in privacy.json`)
  const services = (Object.keys(SERVICES) as ServiceSlug[]).filter((slug) => slugs.includes(slug))
  return { kind: services.length ? 'consent' : 'notice', services }
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

/** The distinct families of a fonts.css, in order. */
export const familiesOf = (css: string): string[] => [...new Set(parseFontsCss(css).map((f) => f.family))]

/**
 * Opens the PR for the site in `dir` (on a branch of FLOWS, verified). Refuses while the other
 * flow has an open PR (they would conflict). Rebases onto origin/main first if it moved and
 * verifies again in full. An open PR from the branch with one of the flow's titles is returned as
 * it is; one with another title is someone else's and is refused.
 */
export async function openPr(dir: string, opts: PrOptions): Promise<PrResult> {
  const exec = opts.exec ?? realExec
  const root = resolve(dir)
  const rollout = join(root, '.rollout')
  const git = (...args: string[]) => exec('git', args, root)
  const report = normaliseReport(readJson<unknown>(join(rollout, 'report.json'), 'run detect first'))

  const flow = await currentFlow(exec, root, 'pr')
  const branch = flow.branch
  const repo = originRepo((await git('remote', 'get-url', 'origin')).out.trim())
  for (const other of flow.others) {
    const prs = await openPrsFrom(exec, root, repo, other)
    if (prs.length) throw new Error(`an open ${other} PR (${prs.map((p) => p.url).join(', ')}) would conflict with ${branch}: merge or close it first`)
  }
  for (const other of flow.others) {
    const unmerged = await unmergedBranch(exec, root, other)
    if (unmerged) throw new Error(`${unmerged}; it would conflict with ${branch}`)
  }

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
  // Only a passing verify run of this exact commit counts; verify wipes the flow's shots when it
  // starts, so the screenshots below always belong to that run.
  const current = (await git('rev-parse', 'HEAD')).out.trim()
  const verifyPath = statePath(rollout, VERIFY_FILE, branch)
  const stored = existsSync(verifyPath) ? readJson<Partial<VerifyResult>>(verifyPath, '') : null
  let result: VerifyResult
  if (!rebased && stored?.pass === true && stored.sha && stored.sha === current) {
    result = stored as VerifyResult
  } else {
    result = await (opts.verify ?? ((d, r) => realVerify(d, r)))(root, report)
    if (!result.pass) throw new Error('verify did not pass: fix and run verify again before the PR')
    if (result.sha !== current) throw new Error(`verify ran for ${result.sha ?? '(no commit)'}, HEAD is ${current}`)
  }

  const shotsDir = statePath(rollout, 'shots', branch)
  const names = existsSync(shotsDir) ? readdirSync(shotsDir).filter((f) => f.endsWith('.png')).sort() : []
  const files = names.map((n) => ({ from: join(shotsDir, n), to: `${opts.screenshotsDir.replace(/\/+$/, '')}/${n}` }))

  const changed = (await git('diff', '--name-only', 'origin/main...HEAD')).out.split('\n').filter(Boolean)
  // The fonts paragraph (consent-banner) and the fonts body name the families the branch self-hosts.
  const fontsCss = branch === FONTS_BRANCH || changed.includes(FONTS_CSS) ? await fontsCssAt(exec, root, 'HEAD') : null
  if (branch === FONTS_BRANCH && fontsCss === null) throw new Error(`${FONTS_CSS} from this tool is not on the branch: run.ts fonts first`)
  let kind: BodyInput['kind'] = 'fonts'
  let services: ServiceSlug[] = []
  let update: BodyInput['update']
  if (branch === UPDATE_BRANCH) {
    kind = 'update'
    const show = async (ref: string) => {
      const r = await git('show', `${ref}:package-lock.json`)
      if (r.code !== 0) throw new Error(`git show ${ref}:package-lock.json failed:\n${tail(r.out)}`)
      return r.out
    }
    const [mainLock, branchLock] = [await show('origin/main'), await show('HEAD')]
    const versionAt = opts.consentVersionAt ?? consentVersionAt
    const { from, to, reasks } = updateSummary(mainLock, branchLock, versionAt)
    // The body says whether every visitor is asked again: never a guess.
    if (reasks === null) throw new Error(reaskLine(mainLock, branchLock, versionAt))
    update = { from, to, reasks, changelog: changelogBetween(opts.changelog ?? readFileSync(CHANGELOG_PATH, 'utf8'), from, to) }
  } else if (branch !== FONTS_BRANCH) {
    const privacy = await git('show', 'HEAD:src/data/privacy.json')
    if (privacy.code !== 0) throw new Error(`src/data/privacy.json is not on the branch: wire the site first\n${tail(privacy.out)}`)
    ;({ kind, services } = templateKind(privacy.out))
  }

  const open = (await openPrsFrom(exec, root, repo, branch))[0]
  if (open && !flow.ownTitles.includes(open.title)) {
    throw new Error(`an open PR from ${branch} is not this tool's: ${open.url} "${open.title}" (expected "${flow.title}"); resolve it by hand`)
  }
  if (open) return { url: open.url, files }

  const body = renderBody(readFileSync(flow.template, 'utf8'), {
    kind,
    services,
    verify: result,
    issues: opts.issues ?? [],
    domain: opts.domain ?? report.domains[0] ?? report.site,
    files: changed,
    screenshots: names.map((n) => ({ file: n, url: `${opts.screenshotsBase.replace(/\/+$/, '')}/${n}` })),
    ...(fontsCss !== null ? { fonts: { families: familiesOf(fontsCss) } } : {}),
    ...(update ? { update } : {}),
  })
  const bodyFile = statePath(rollout, 'pr-body.md', branch)
  writeFileSync(bodyFile, body)
  const created = await exec('gh', ['pr', 'create', '-R', repo, '-H', branch, '-B', 'main', '-t', flow.title, '-F', bodyFile], root)
  const link = created.out.trim().split('\n').pop() ?? ''
  if (created.code !== 0 || !/^https:\/\/github\.com\//.test(link)) throw new Error(`gh pr create failed:\n${tail(created.out)}`)
  return { url: link, files }
}
