// The live stage (spec C5): the checks of C3 steps 3, 4, 6 and 8 against the live domains. Live
// sites are never stubbed: registry and Google Fonts requests are counted, never blocked, and
// nothing is clicked before they are counted. The clone's branch picks the flow (flows.ts), whose
// state files it reads and writes.
//
//   baseline    before the merge: expected RED. Against report.domains and every host of the
//               Coolify apps that follow main (Ruling 37, read-only). Writes the console-error
//               baseline to .rollout/live-baseline-<branch>.txt (one error per line, the domain's
//               host as {host}, newlines as \n) and the hosts it covered to
//               .rollout/live-baseline-hosts-<branch>.json, which merge checks the following apps
//               against. When origin/main already self-hosts the fonts (the tool's fonts.css), every
//               host must also pass the fonts requests check, or it is a STOP.
//   post-merge  the apps recorded in .rollout/apps-<branch>.json before the merge (merge writes
//               it; Ruling 14 decides which follow main). For each app that follows main, wait for
//               its deployment of the merge commit (`sha`): failed, cancelled or a timeout is a
//               STOP. An app that does not follow main gets an issue "<fqdn> redeployar inte från
//               main" (unless one is open) and its domains are skipped. Then every domain of the
//               waited-for apps: banner shown (not on CMS admin pages) and zero registry requests
//               (DOM included) on every page, no console error that is not in the baseline, the
//               consent paths on pages with an embed, every contrast row ok; and when the merged
//               main self-hosts the fonts, zero Google Fonts requests, every /fonts/*.woff2 200 and
//               every face used loaded, at 360 and 1280 px. fonts-selfhost on a site without the
//               banner on main checks the fonts and console errors only. A failing domain is
//               checked again after 30 s; a second failure is a STOP. A pass deletes the clone's
//               node_modules and dist (#23).
//
// The result goes to .rollout/live-<mode>-<branch>.json.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Browser } from '@playwright/test'
import { type ConsentPathResult, checkConsentPaths } from './checks/consent-paths'
import { type ContrastRow, checkContrast } from './checks/contrast'
import { checkFonts, type DeclaredFace, type FontsPage, judgeFontsPage, parseFontsCss } from './checks/fonts'
import { isCmsAdminRoute, listPages } from './checks/pages'
import { checkRequests, formatRequests, type RequestResult } from './checks/requests'
import { type App, appsFor, type Deployment, type DeployStatus, followsMain, listApps, listDeployments, waitDeployed } from './coolify'
import { currentFlow, fontsCssAt, readStatePath, statePath } from './flows'
import { type Exec, exec as realExec, tail } from './lib/exec'
import { originRepo } from './pr'
import { normaliseReport } from './lib/report'
import type { Report } from './types'
import { embedPagesByFetch, hasPackage } from './verify'

/** State names in .rollout/, per branch (flows.ts statePath; consent-banner reads the old names too). */
export const BASELINE_FILE = 'live-baseline.txt'
/** `{ head, hosts, apps }`: every host live baseline checked, and the apps following main then (Ruling 37). */
export const BASELINE_HOSTS_FILE = 'live-baseline-hosts.json'
export const APPS_FILE = 'apps.json'
const HOST = '{host}'
const RETRY_MS = 30_000

/** An app of the site as recorded right before the merge. `autoDeploy`: it follows main (Ruling 14). */
export type RecordedApp = App & { lastDeployed: string | null }

export interface RecordedApps {
  /** origin/main before the merge. */
  head: string
  apps: RecordedApp[]
}

export interface LiveResult {
  /** baseline: 'red' (expected) or 'pass' (already green, noted). post-merge: 'pass' or 'stop'. */
  status: 'pass' | 'red' | 'stop'
  reason?: string
  lines: string[]
  /** Domains not checked because their app does not redeploy from main. */
  skipped: string[]
  /** Issue URLs for those apps (opened now or already open). */
  issues: string[]
}

/** The browser side of live, behind one interface so tests can answer it. Never stubbed. */
export interface LiveChecks {
  pages(base: string): Promise<string[]>
  embedPages(base: string, paths: string[]): Promise<string[]>
  requests(base: string, paths: string[], opts: { baseline: Set<string>; expectBanner?: (path: string) => boolean }): Promise<RequestResult[]>
  consentPaths(base: string, paths: string[]): Promise<ConsentPathResult[]>
  contrast(base: string, paths: string[]): Promise<ContrastRow[]>
  /** Every path at 360 and 1280 px, Google Fonts counted (not blocked). */
  fonts(base: string, paths: string[]): Promise<FontsPage[]>
  close(): Promise<void>
}

export interface LiveDeps {
  checks: () => Promise<LiveChecks>
  /** gh, for the issues; git, for the branch and main. */
  exec: Exec
  sleep: (ms: number) => Promise<void>
  waitDeployed: (app: App, sha: string) => Promise<DeployStatus>
  /** Coolify, read-only: for the hosts live baseline covers. */
  listApps: () => Promise<App[]>
  deployments: (uuid: string) => Promise<Deployment[]>
}

/** The real checks: one Chromium, launched on first use, `stub: false` everywhere. */
export function liveChecks(): LiveChecks {
  let browser: Promise<Browser> | null = null
  const get = (): Promise<Browser> => (browser ??= import('@playwright/test').then((p) => p.chromium.launch()))
  return {
    pages: (base) => listPages(base, { ssr: true }),
    embedPages: embedPagesByFetch,
    requests: async (base, paths, opts) =>
      checkRequests(await get(), base, paths, { baseline: opts.baseline, stub: false, ...(opts.expectBanner ? { expectBanner: opts.expectBanner } : {}) }),
    consentPaths: async (base, paths) => checkConsentPaths(await get(), base, paths, { stub: false }),
    contrast: async (base, paths) => checkContrast(await get(), base, paths, { stub: false }),
    fonts: async (base, paths) => checkFonts(await get(), base, paths, { stub: false, block: false }),
    async close() {
      if (browser) await (await browser).close()
    },
  }
}

const realDeps = (): LiveDeps => ({
  checks: async () => liveChecks(),
  exec: realExec,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  waitDeployed: (app, sha) => waitDeployed(app, sha),
  listApps: () => listApps(),
  deployments: (uuid) => listDeployments(uuid),
})

/** CMS admin shells (Ruling 26) never show the banner. */
const expectBanner = (path: string): boolean => !isCmsAdminRoute(path)

const escape = (e: string): string => e.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n')
const unescape = (line: string): string => line.replace(/\\(\\|n)/g, (_, c: string) => (c === 'n' ? '\n' : '\\'))

/** The baseline file's text: each domain's errors with its host as {host}, deduplicated. */
export function encodeBaseline(entries: { host: string; errors: string[] }[]): string {
  const lines = new Set<string>()
  for (const { host, errors } of entries) for (const e of errors) lines.add(escape(e.replaceAll(host, HOST)))
  return [...lines].map((l) => `${l}\n`).join('')
}

/** The baseline for one domain. */
export function decodeBaseline(text: string, host: string): Set<string> {
  return new Set(
    text
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => unescape(l).replaceAll(HOST, host)),
  )
}

export const issueTitle = (fqdn: string): string => `${fqdn} redeployar inte från main`

function issueBody(app: RecordedApp, head: string, skipped: string[]): string {
  const short = (s: string | null) => (s ? `\`${s.slice(0, 7)}\`` : 'ingen')
  return [
    `Coolify-appen **${app.name}** för **${app.fqdns[0] ?? app.uuid}** bygger inte om när \`main\` ändras.`,
    '',
    `- \`main\` var ${short(head)} före mergen; appens senaste avslutade deploy är ${short(app.lastDeployed)}.`,
    `- Livekontrollen efter mergen hoppade över ${skipped.join(', ')}.`,
    '',
    'Följd: appen visar en äldre version av sajten än den som deployas från `main`.',
    '',
    'Förslag: slå på automatisk deploy från `main` för appen, eller deploya den manuellt efter varje merge. Ingen kodändring behövs i repot.',
    '',
  ].join('\n')
}

/** The issue for an app that does not redeploy from main: an open one with the same title, or a new one. */
async function ensureIssue(exec: Exec, repo: string, title: string, body: string, cwd: string): Promise<string> {
  const list = await exec('gh', ['issue', 'list', '-R', repo, '--state', 'open', '--search', `${title} in:title`, '--json', 'title,url', '--limit', '100'], cwd)
  if (list.code !== 0) throw new Error(`gh issue list failed:\n${tail(list.out)}`)
  const open = (JSON.parse(list.out || '[]') as { title: string; url: string }[]).find((i) => i.title === title)
  if (open) return open.url
  const created = await exec('gh', ['issue', 'create', '-R', repo, '-t', title, '-b', body], cwd)
  const url = created.out.trim().split('\n').pop() ?? ''
  if (created.code !== 0 || !/^https:\/\/github\.com\//.test(url)) throw new Error(`gh issue create failed:\n${tail(created.out)}`)
  return url
}

/** What a domain is checked for: the banner (steps 3, 4, 6), the self-hosted fonts (step 8), or both. */
interface DomainChecks {
  banner: boolean
  /** The faces of main's fonts.css, when main self-hosts them. */
  fonts: DeclaredFace[] | null
}

/** Step 8's browser part on every page: no Google Fonts request, woff2 200, faces used loaded. */
async function fontsLines(c: LiveChecks, base: string, paths: string[], declared: DeclaredFace[]): Promise<{ pass: boolean; lines: string[] }> {
  const judged = (await c.fonts(base, paths)).map((p) => judgeFontsPage(p, declared))
  return { pass: judged.length > 0 && judged.every((j) => j.ok), lines: ['  self-hosted fonts:', ...judged.flatMap((j) => j.lines).map((l) => `    ${l}`)] }
}

/** C3 steps 3, 4, 6 (and 8) on one live domain. */
async function checkDomain(c: LiveChecks, host: string, baseline: Set<string>, what: DomainChecks): Promise<{ pass: boolean; lines: string[] }> {
  const base = `https://${host}`
  const lines = [`${base}:`]
  try {
    const paths = await c.pages(base)
    lines.push(`  pages (${paths.length}): ${paths.join(' ')}`)
    const results = await c.requests(base, paths, { baseline, expectBanner: what.banner ? expectBanner : () => false })
    lines.push(...formatRequests(results).map((l) => `  ${l}`))
    // Without the banner (fonts-selfhost first), registry requests are the site's own: noted only.
    let pass = results.length > 0 && results.every((r) => (what.banner ? r.ok : r.errors.length === 0 && r.banners === 0))
    if (!what.banner && results.some((r) => r.blocked.length)) lines.push('  registry requests: the site has no banner yet, so they are its own (noted, not checked)')
    if (what.banner) {
      const mapPages = (await c.embedPages(base, paths)).filter(expectBanner)
      lines.push(`  pages with an embed: ${mapPages.join(' ') || '(none)'}`)
      if (mapPages.length) {
        for (const r of await c.consentPaths(base, mapPages)) {
          const ok = r.visaLoadsOnlyClicked && r.rememberAutoShows && r.nekaLoadsNothing && r.filterKept !== false
          pass &&= ok
          lines.push(
            `  ${r.path}: visa=${r.visaLoadsOnlyClicked} visa-alltid=${r.rememberAutoShows} neka=${r.nekaLoadsNothing} open=${r.openHref ?? '-'} ${ok ? 'ok' : 'FAIL'}`,
            ...r.notes.map((n) => `    ${n}`),
          )
        }
      }
      const rows = await c.contrast(base, paths)
      lines.push(
        ...rows.map(
          (r) => `  ${r.path ?? ''} ${r.kind} "${r.button}" ${r.ratio.toFixed(2)}:1 ${r.ok ? 'ok' : 'FAIL'}${r.indeterminate ? ` (indeterminate: ${r.indeterminate})` : ''}`,
        ),
      )
      if (!rows.some((r) => r.kind === 'banner')) lines.push('  no banner button measured')
      pass &&= rows.some((r) => r.kind === 'banner') && rows.every((r) => r.ok)
    }
    if (what.fonts) {
      const f = await fontsLines(c, base, paths, what.fonts)
      lines.push(...f.lines)
      pass &&= f.pass
    }
    return { pass, lines }
  } catch (e) {
    return { pass: false, lines: [...lines, `  check threw: ${(e as Error).message}`] }
  }
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T

/**
 * Spec C5. `baseline` runs before the merge against report.domains; `post-merge` after it, with
 * `sha` the merge commit to wait for (without `sha` nothing is waited for: a rerun once deployed).
 */
export async function live(
  dir: string,
  mode: 'baseline' | 'post-merge',
  sha?: string,
  opts: { deps?: Partial<LiveDeps> } = {},
): Promise<LiveResult> {
  const deps: LiveDeps = { ...realDeps(), ...opts.deps }
  const root = resolve(dir)
  const rollout = join(root, '.rollout')
  const result: LiveResult = { status: 'stop', lines: [], skipped: [], issues: [] }
  const reportPath = join(rollout, 'report.json')
  if (!existsSync(reportPath)) throw new Error(`${reportPath} not found: run detect first`)
  const report = normaliseReport(readJson<unknown>(reportPath))
  const flow = await currentFlow(deps.exec, root, 'live')
  const branch = flow.branch
  const done = (r: Partial<LiveResult>): LiveResult => {
    Object.assign(result, r)
    writeFileSync(statePath(rollout, `live-${mode}.json`, branch), `${JSON.stringify(result, null, 2)}\n`)
    return result
  }
  const repo = `visionmediahq/${report.site}`
  const git = (...args: string[]) => deps.exec('git', args, root)
  let checks: LiveChecks | null = null
  const getChecks = async () => (checks ??= await deps.checks())
  /** What main at `ref` asks of each domain: the banner unless fonts-selfhost has none; the fonts when main self-hosts them. */
  const domainChecks = async (ref: string): Promise<DomainChecks> => {
    const css = await fontsCssAt(deps.exec, root, ref)
    const banner = branch !== 'fonts-selfhost' || hasPackage((await git('show', `${ref}:package.json`)).out)
    return { banner, fonts: css === null ? null : parseFontsCss(css) }
  }

  try {
    if (mode === 'baseline') {
      if (report.domains.length === 0) return done({ reason: 'report.json has no domain' })
      // Ruling 37: also every host of the apps that follow main, since live post-merge checks those.
      const fetched = await git('fetch', 'origin', 'main')
      if (fetched.code !== 0) return done({ reason: `git fetch origin main failed:\n${tail(fetched.out)}` })
      const revParsed = await git('rev-parse', 'origin/main')
      if (revParsed.code !== 0) return done({ reason: `git rev-parse origin/main failed:\n${tail(revParsed.out)}` })
      const mainHead = revParsed.out.trim()
      const repoName = originRepo((await git('remote', 'get-url', 'origin')).out.trim()).split('/')[1]!
      const hosts = [...report.domains]
      const following: { uuid: string; name: string; fqdns: string[] }[] = []
      for (const app of appsFor(await deps.listApps(), repoName)) {
        if (!app.autoDeploy || !followsMain(await deps.deployments(app.uuid), mainHead)) continue
        following.push({ uuid: app.uuid, name: app.name, fqdns: app.fqdns })
        for (const h of app.fqdns) if (!hosts.includes(h)) hosts.push(h)
        result.lines.push(`${app.name} follows main: ${app.fqdns.join(', ') || '(no domain)'}`)
      }
      // Main already self-hosts the fonts: live must not ask Google for them, before any merge.
      const mainFonts = (await domainChecks('origin/main')).fonts
      const entries: { host: string; errors: string[] }[] = []
      const fontsFailed: string[] = []
      let green = true
      const c = await getChecks()
      for (const host of hosts) {
        const base = `https://${host}`
        const paths = await c.pages(base)
        const results = await c.requests(base, paths, { baseline: new Set(), expectBanner })
        result.lines.push(`${base} (expected RED: no banner, registry requested on map pages):`, ...formatRequests(results).map((l) => `  ${l}`))
        entries.push({ host, errors: results.flatMap((r) => r.errors) })
        const visitor = results.filter((r) => expectBanner(r.path))
        green &&= visitor.length > 0 && visitor.every((r) => r.banner && r.blocked.length === 0)
        if (mainFonts) {
          const f = await fontsLines(c, base, paths, mainFonts)
          result.lines.push(...f.lines)
          if (!f.pass) fontsFailed.push(host)
        }
      }
      const text = encodeBaseline(entries)
      const baselinePath = statePath(rollout, BASELINE_FILE, branch)
      writeFileSync(baselinePath, text)
      writeFileSync(statePath(rollout, BASELINE_HOSTS_FILE, branch), `${JSON.stringify({ head: mainHead, hosts, apps: following }, null, 2)}\n`)
      result.lines.push(`console baseline: ${text.split('\n').filter(Boolean).length} errors → ${baselinePath}`, `hosts baselined: ${hosts.join(', ')}`)
      if (fontsFailed.length) return done({ reason: `main self-hosts the fonts, but ${fontsFailed.join(', ')} failed the fonts check live` })
      if (green) result.lines.push('live site already green: shows the banner and requests nothing from the registry (noted, not a failure)')
      return done({ status: green ? 'pass' : 'red' })
    }

    const appsPath = readStatePath(rollout, APPS_FILE, branch)
    if (!existsSync(appsPath)) return done({ reason: `${statePath('.rollout', APPS_FILE, branch)} not found: merge records the apps before merging` })
    const baselinePath = readStatePath(rollout, BASELINE_FILE, branch)
    if (!existsSync(baselinePath)) return done({ reason: `${statePath('.rollout', BASELINE_FILE, branch)} not found: run live baseline before the merge` })
    const baselineText = readFileSync(baselinePath, 'utf8')
    const recorded = readJson<RecordedApps>(appsPath)
    const following = recorded.apps.filter((a) => a.autoDeploy)
    const idle = recorded.apps.filter((a) => !a.autoDeploy)
    if (following.length === 0) return done({ reason: `no Coolify app of ${repo} follows main` })

    if (sha) {
      for (const app of following) {
        const status = await deps.waitDeployed(app, sha)
        result.lines.push(`${app.name} (${app.fqdns.join(', ')}): deployment of ${sha.slice(0, 7)} ${status}`)
        if (status !== 'finished') return done({ reason: `${app.name}: deployment of ${sha.slice(0, 7)} ${status}` })
      }
    } else result.lines.push('no merge commit given: not waiting for a deployment')

    const domains = [...new Set(following.flatMap((a) => a.fqdns))]
    for (const app of idle) {
      const skipped = app.fqdns.filter((d) => !domains.includes(d))
      result.skipped.push(...skipped)
      result.lines.push(`${app.name} does not redeploy from main (last deployed ${app.lastDeployed?.slice(0, 7) ?? 'never'}): skipped ${skipped.join(', ') || '(no own domain)'}`)
      const url = await ensureIssue(deps.exec, repo, issueTitle(app.fqdns[0] ?? app.name), issueBody(app, recorded.head, skipped), root)
      result.issues.push(url)
      result.lines.push(`  issue ${url}`)
    }
    if (domains.length === 0) return done({ reason: 'the apps that follow main have no domain' })

    // What the merged main asks of the live site: the merge commit, else origin/main as fetched now.
    const fetched = await git('fetch', 'origin', 'main')
    if (fetched.code !== 0) return done({ reason: `git fetch origin main failed, so whether main self-hosts the fonts is unknown:\n${tail(fetched.out)}` })
    const what = await domainChecks(sha ?? 'origin/main')
    result.lines.push(`checks: ${[...(what.banner ? ['banner'] : []), ...(what.fonts ? ['self-hosted fonts'] : [])].join(' and ') || 'console errors only'}`)

    const c = await getChecks()
    let failed: string[] = []
    for (const host of domains) {
      const r = await checkDomain(c, host, decodeBaseline(baselineText, host), what)
      result.lines.push(...r.lines)
      if (!r.pass) failed.push(host)
    }
    if (failed.length) {
      result.lines.push(`failed: ${failed.join(', ')}; checking again in ${RETRY_MS / 1000} s`)
      await deps.sleep(RETRY_MS)
      const again: string[] = []
      for (const host of failed) {
        const r = await checkDomain(c, host, decodeBaseline(baselineText, host), what)
        result.lines.push(...r.lines.map((l) => (l.startsWith('  ') ? l : `${l} (retry)`)))
        if (!r.pass) again.push(host)
      }
      failed = again
    }
    if (failed.length) return done({ reason: `live check failed twice, 30 s apart: ${failed.join(', ')}` })
    // #23: the site is live and checked; its clone's install and build only take disk now (verify
    // runs npm ci again if the clone is ever used). A stop keeps them for the next verify.
    const removed = ['node_modules', 'dist'].filter((d) => existsSync(join(root, d)))
    for (const d of removed) rmSync(join(root, d), { recursive: true, force: true })
    if (removed.length) result.lines.push(`cleanup: removed ${removed.join(', ')} (npm ci restores them)`)
    return done({ status: 'pass' })
  } catch (e) {
    return done({ reason: (e as Error).message })
  } finally {
    if (checks) await (checks as LiveChecks).close().catch(() => undefined)
  }
}

/** One line per result, as run.ts prints them. */
export function formatLive(mode: string, r: LiveResult): string[] {
  return [...r.lines, `live ${mode}: ${r.status.toUpperCase()}${r.reason ? ` (${r.reason})` : ''}`]
}
