// The live stage (spec C5): the checks of C3 steps 3, 4 and 6 against the live domains. Live sites
// are never stubbed: registry requests are counted, never blocked, and nothing is clicked before
// they are counted.
//
//   baseline    before the merge, against report.domains: expected RED. Writes the console-error
//               baseline to .rollout/live-baseline.txt (one error per line, the domain's host as
//               {host}, newlines as \n).
//   post-merge  the apps recorded in .rollout/apps.json before the merge (merge writes it; Ruling
//               14 decides which follow main). For each app that follows main, wait for its
//               deployment of the merge commit (`sha`): failed, cancelled or a timeout is a STOP.
//               An app that does not follow main gets an issue "<fqdn> redeployar inte från main"
//               (unless one is open) and its domains are skipped. Then every domain of the
//               waited-for apps: banner shown and zero registry requests (DOM included) on every
//               page, no console error that is not in the baseline, the consent paths on pages with
//               an embed, every contrast row ok. A failing domain is checked again after 30 s; a
//               second failure is a STOP.
//
// The result goes to .rollout/live-<mode>.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Browser } from '@playwright/test'
import { type ConsentPathResult, checkConsentPaths } from './checks/consent-paths'
import { type ContrastRow, checkContrast } from './checks/contrast'
import { listPages } from './checks/pages'
import { checkRequests, formatRequests, type RequestResult } from './checks/requests'
import { type App, type DeployStatus, waitDeployed } from './coolify'
import { type Exec, exec as realExec, tail } from './lib/exec'
import type { Report } from './types'
import { embedPagesByFetch } from './verify'

export const BASELINE_FILE = '.rollout/live-baseline.txt'
export const APPS_FILE = '.rollout/apps.json'
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
  requests(base: string, paths: string[], opts: { baseline: Set<string> }): Promise<RequestResult[]>
  consentPaths(base: string, paths: string[]): Promise<ConsentPathResult[]>
  contrast(base: string, paths: string[]): Promise<ContrastRow[]>
  close(): Promise<void>
}

export interface LiveDeps {
  checks: () => Promise<LiveChecks>
  /** gh, for the issues. */
  exec: Exec
  sleep: (ms: number) => Promise<void>
  waitDeployed: (app: App, sha: string) => Promise<DeployStatus>
}

/** The real checks: one Chromium, launched on first use, `stub: false` everywhere. */
export function liveChecks(): LiveChecks {
  let browser: Promise<Browser> | null = null
  const get = (): Promise<Browser> => (browser ??= import('@playwright/test').then((p) => p.chromium.launch()))
  return {
    pages: (base) => listPages(base, { ssr: true }),
    embedPages: embedPagesByFetch,
    requests: async (base, paths, opts) => checkRequests(await get(), base, paths, { baseline: opts.baseline, stub: false }),
    consentPaths: async (base, paths) => checkConsentPaths(await get(), base, paths, { stub: false }),
    contrast: async (base, paths) => checkContrast(await get(), base, paths, { stub: false }),
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
})

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
    `- \`main\` var ${short(head)} före mergen av samtyckesbannern; appens senaste avslutade deploy är ${short(app.lastDeployed)}.`,
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

/** C3 steps 3, 4 and 6 on one live domain. */
async function checkDomain(c: LiveChecks, host: string, baseline: Set<string>): Promise<{ pass: boolean; lines: string[] }> {
  const base = `https://${host}`
  const lines = [`${base}:`]
  try {
    const paths = await c.pages(base)
    lines.push(`  pages (${paths.length}): ${paths.join(' ')}`)
    const results = await c.requests(base, paths, { baseline })
    lines.push(...formatRequests(results).map((l) => `  ${l}`))
    let pass = results.length > 0 && results.every((r) => r.ok)
    const mapPages = await c.embedPages(base, paths)
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
  const result: LiveResult = { status: 'stop', lines: [], skipped: [], issues: [] }
  const done = (r: Partial<LiveResult>): LiveResult => {
    Object.assign(result, r)
    writeFileSync(join(root, `.rollout/live-${mode}.json`), `${JSON.stringify(result, null, 2)}\n`)
    return result
  }
  const reportPath = join(root, '.rollout/report.json')
  if (!existsSync(reportPath)) throw new Error(`${reportPath} not found: run detect first`)
  const report = readJson<Report>(reportPath)
  const repo = `visionmediahq/${report.site}`
  let checks: LiveChecks | null = null
  const getChecks = async () => (checks ??= await deps.checks())

  try {
    if (mode === 'baseline') {
      if (report.domains.length === 0) return done({ reason: 'report.json has no domain' })
      const entries: { host: string; errors: string[] }[] = []
      let green = true
      const c = await getChecks()
      for (const host of report.domains) {
        const base = `https://${host}`
        const paths = await c.pages(base)
        const results = await c.requests(base, paths, { baseline: new Set() })
        result.lines.push(`${base} (expected RED: no banner, registry requested on map pages):`, ...formatRequests(results).map((l) => `  ${l}`))
        entries.push({ host, errors: results.flatMap((r) => r.errors) })
        green &&= results.length > 0 && results.every((r) => r.banner && r.blocked.length === 0)
      }
      const text = encodeBaseline(entries)
      writeFileSync(join(root, BASELINE_FILE), text)
      result.lines.push(`console baseline: ${text.split('\n').filter(Boolean).length} errors → ${join(root, BASELINE_FILE)}`)
      if (green) result.lines.push('live site already green: shows the banner and requests nothing from the registry (noted, not a failure)')
      return done({ status: green ? 'pass' : 'red' })
    }

    const appsPath = join(root, APPS_FILE)
    if (!existsSync(appsPath)) return done({ reason: `${APPS_FILE} not found: merge records the apps before merging` })
    const baselinePath = join(root, BASELINE_FILE)
    if (!existsSync(baselinePath)) return done({ reason: `${BASELINE_FILE} not found: run live baseline before the merge` })
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

    const c = await getChecks()
    let failed: string[] = []
    for (const host of domains) {
      const r = await checkDomain(c, host, decodeBaseline(baselineText, host))
      result.lines.push(...r.lines)
      if (!r.pass) failed.push(host)
    }
    if (failed.length) {
      result.lines.push(`failed: ${failed.join(', ')}; checking again in ${RETRY_MS / 1000} s`)
      await deps.sleep(RETRY_MS)
      const again: string[] = []
      for (const host of failed) {
        const r = await checkDomain(c, host, decodeBaseline(baselineText, host))
        result.lines.push(...r.lines.map((l) => (l.startsWith('  ') ? l : `${l} (retry)`)))
        if (!r.pass) again.push(host)
      }
      failed = again
    }
    if (failed.length) return done({ reason: `live check failed twice, 30 s apart: ${failed.join(', ')}` })
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
