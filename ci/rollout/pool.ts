// Detect across the pool: every visionmediahq Astro repo with a live domain in stats-config,
// minus the pilot and spam-guard sites. One shallow clone at a time, deleted right after.
//
//   tsx ci/rollout/pool.ts [--out <pool.json>] [--work <clone dir>] [--stats <clients dir>]
//                          [--limit N] [--only <repo>]... [--rescan]
//
// $WORK defaults to ~/sites/consent-rollout. pool.json holds client data: it is never committed.
// The scan is resumable: rows already in pool.json with a report that lists `services` are skipped; rows that ended in
// an error are scanned again. --rescan detects every row again: a site can change after its scan. Each
// row is saved as it is done, but an interrupted --rescan starts over from the first repo.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isEntryScript } from './lib/is-entry'
import { listApps, type App } from './coolify'
import { detect } from './detect/index'
import { classificationLine } from './lib/report'
import { diskSite } from './lib/site-files'
import type { PoolRow, Report } from './types'

/** Sites left out of the pool, by numeric GitHub repo ID (`gh api repositories/<id>`): the tree names no client. */
export interface Exclusions {
  pilot7: number[]
  spamGuard: number[]
}

export interface OrgRepo {
  /** The numeric GitHub repo ID, which exclusions.json lists. */
  id: number
  name: string
  isArchived: boolean
  /** Whether package.json depends on `astro`. */
  astro: boolean
  homepageUrl?: string | null
}

export interface PoolInput {
  orgRepos: OrgRepo[]
  /** Every `sites[].label` in stats-config, `enabled: false` included. */
  statsDomains: string[]
  exclusions: Exclusions
  apps: App[]
}

export interface PoolFile {
  rows: PoolRow[]
  /** Astro repos, not excluded, with no Coolify fqdn or homepage among the stats-config labels. */
  unmatched: string[]
}

export interface PoolTarget {
  repo: string
  domains: string[]
}

const unquote = (v: string): string =>
  v
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim()
    .toLowerCase()

/**
 * The `label` of each entry under `sites:` in a stats-config client file. `enabled` is ignored on
 * purpose: two pilot sites were `enabled: false` yet live. Labels deeper down (landing pages)
 * are not sites.
 */
export function statsLabels(yml: string): string[] {
  const out: string[] = []
  let inSites = false
  let itemIndent = -1
  for (const line of yml.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inSites = /^sites:\s*(#.*)?$/.test(line)
      itemIndent = -1
      continue
    }
    if (!inSites) continue
    const dash = /^(\s*)-\s+(.*)$/.exec(line)
    let value: string | null = null
    if (dash && (itemIndent < 0 || dash[1]!.length === itemIndent)) {
      itemIndent = dash[1]!.length
      const m = /^label:\s*(.*)$/.exec(dash[2]!)
      if (m) value = m[1]!
    } else if (itemIndent >= 0) {
      const m = /^(\s*)label:\s*(.*)$/.exec(line)
      if (m && m[1]!.length === itemIndent + 2) value = m[2]!
    }
    if (value !== null) {
      const label = unquote(value)
      if (label && !out.includes(label)) out.push(label)
    }
  }
  return out
}

export function hasAstroDep(packageJson: string): boolean {
  try {
    const pkg = JSON.parse(packageJson) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    return Boolean(pkg.dependencies?.astro ?? pkg.devDependencies?.astro)
  } catch {
    return false
  }
}

const bare = (host: string): string => host.toLowerCase().replace(/^www\./, '')

function hostOf(url: string): string | null {
  const host = url
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[/:?#].*$/, '')
  return host || null
}

/**
 * The repo's stats-config labels: the hosts of its Coolify apps (main branch first) and its GitHub
 * homepage, kept when they are a label. `www.` is ignored when matching.
 */
export function domainsFor(repo: OrgRepo, apps: App[], labels: string[]): string[] {
  const byHost = new Map<string, string>()
  for (const label of labels) if (!byHost.has(bare(label))) byHost.set(bare(label), label)
  const own = apps.filter((a) => a.repo === repo.name)
  const ordered = [...own.filter((a) => a.branch === 'main'), ...own.filter((a) => a.branch !== 'main')]
  const hosts = ordered.flatMap((a) => a.fqdns)
  const home = repo.homepageUrl ? hostOf(repo.homepageUrl) : null
  if (home) hosts.push(home)
  const out: string[] = []
  for (const host of hosts) {
    const label = byHost.get(bare(host))
    if (label && !out.includes(label)) out.push(label)
  }
  return out
}

const excludedIds = (exclusions: Exclusions): Set<number> => new Set([...exclusions.pilot7, ...exclusions.spamGuard])

/**
 * The org listing from `gh api --paginate orgs/<org>/repos` with ORG_REPO_FIELDS: one JSON object per
 * line. A repo without a numeric id could never match exclusions.json, so it is an error.
 */
export function parseOrgRepos(out: string): Omit<OrgRepo, 'astro'>[] {
  return out
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const r = JSON.parse(line) as Partial<Omit<OrgRepo, 'astro'>>
      if (!Number.isSafeInteger(r.id)) throw new Error(`org repo listing: no numeric id in ${line}`)
      if (typeof r.name !== 'string' || !r.name) throw new Error(`org repo listing: no name in ${line}`)
      return { id: r.id!, name: r.name, isArchived: Boolean(r.isArchived), homepageUrl: r.homepageUrl ?? null }
    })
}

export function planPool(input: PoolInput): { repos: PoolTarget[]; unmatched: string[] } {
  const excluded = excludedIds(input.exclusions)
  const repos: PoolTarget[] = []
  const unmatched: string[] = []
  const sorted = [...input.orgRepos].sort((a, b) => a.name.localeCompare(b.name))
  for (const r of sorted) {
    if (r.isArchived || !r.astro || excluded.has(r.id)) continue
    const domains = domainsFor(r, input.apps, input.statsDomains)
    if (domains.length) repos.push({ repo: r.name, domains })
    else unmatched.push(r.name)
  }
  return { repos, unmatched }
}

/** Astro repos with a stats-config domain, minus exclusions and archived repos, sorted. */
export function poolRepos(input: PoolInput): string[] {
  return planPool(input).repos.map((r) => r.repo)
}

export interface ScanDeps {
  /** Where the repo's clone goes. It is removed after the scan, also when the clone failed. */
  dirFor(repo: string): string
  clone(repo: string, dir: string): Promise<void>
  detect(dir: string, repo: string, domains: string[]): Report
  remove(dir: string): void
  save(file: PoolFile): void
  log?(line: string): void
}

const byRepo = (a: PoolRow, b: PoolRow): number => a.repo.localeCompare(b.repo)

/** One repo at a time: clone, detect, delete, save. Errors become rows with `error`. */
export async function scanPool(
  targets: PoolTarget[],
  existing: PoolFile,
  deps: ScanDeps,
  opts: { limit?: number; rescan?: boolean } = {},
): Promise<PoolFile> {
  const file: PoolFile = { rows: [...existing.rows], unmatched: existing.unmatched }
  // A report stored before `services` existed is detected again; with rescan, every row is.
  const done = new Set(
    opts.rescan ? [] : file.rows.filter((r) => !r.error && r.report !== null && Array.isArray(r.report.services)).map((r) => r.repo),
  )
  let scanned = 0
  for (const { repo, domains } of targets) {
    if (done.has(repo)) continue
    if (opts.limit !== undefined && scanned >= opts.limit) break
    scanned++
    let row: PoolRow
    const dir = deps.dirFor(repo)
    try {
      await deps.clone(repo, dir)
      row = { repo, domains, report: deps.detect(dir, repo, domains) }
    } catch (e) {
      row = { repo, domains, report: null, error: (e as Error).message }
    } finally {
      deps.remove(dir)
    }
    file.rows = [...file.rows.filter((r) => r.repo !== repo), row].sort(byRepo)
    deps.save(file)
    deps.log?.(`${repo}: ${row.error ? `error: ${row.error}` : classificationLine(row.report!)}`)
  }
  file.rows.sort(byRepo)
  return file
}

// ---------------------------------------------------------------------------------------------
// The real run: gh, git, Coolify (read-only), the filesystem.

const ORG = 'visionmediahq'
/** The jq filter for `gh api orgs/<org>/repos`: the REST listing carries the numeric `id`, `gh repo list` does not. */
const ORG_REPO_FIELDS = '.[] | {id, name, isArchived: .archived, homepageUrl: .homepage}'

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}

function isAstroRepo(repo: string): boolean {
  let text: string
  try {
    text = gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${ORG}/${repo}/contents/package.json`])
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? '')
    if (/HTTP 404|Not Found/i.test(stderr)) return false
    throw new Error(`package.json of ${repo}: ${stderr.trim() || (e as Error).message}`)
  }
  return hasAstroDep(text)
}

function readStatsDomains(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.yml')).sort()) {
    for (const label of statsLabels(readFileSync(join(dir, name), 'utf8'))) if (!out.includes(label)) out.push(label)
  }
  return out
}

function readPool(path: string): PoolFile {
  if (!existsSync(path)) return { rows: [], unmatched: [] }
  return JSON.parse(readFileSync(path, 'utf8')) as PoolFile
}

function writePool(path: string, file: PoolFile): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, `${JSON.stringify(file, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
}

interface PoolArgs {
  out: string
  work: string
  stats: string
  limit?: number
  only: string[]
  rescan: boolean
}

export function parsePoolArgs(args: string[], env: NodeJS.ProcessEnv = process.env): PoolArgs {
  const WORK = env.WORK ?? join(homedir(), 'sites/consent-rollout')
  const parsed: PoolArgs = { out: join(WORK, 'pool.json'), work: join(WORK, 'pool'), stats: join(homedir(), 'stats-config/clients'), only: [], rescan: false }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!
    if (flag === '--rescan') {
      parsed.rescan = true
      continue
    }
    const value = args[++i]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    if (flag === '--out') parsed.out = resolve(value)
    else if (flag === '--work') parsed.work = resolve(value)
    else if (flag === '--stats') parsed.stats = resolve(value)
    else if (flag === '--only') parsed.only.push(value)
    else if (flag === '--limit') {
      if (!/^\d+$/.test(value)) throw new Error(`--limit takes a number, not ${value}`)
      parsed.limit = Number(value)
    } else throw new Error(`unknown option ${flag}`)
  }
  return parsed
}

async function main(argv: string[]): Promise<number> {
  const args = parsePoolArgs(argv)
  const exclusions = JSON.parse(readFileSync(join(import.meta.dirname, 'exclusions.json'), 'utf8')) as Exclusions
  const existing = readPool(args.out)
  const scanned = new Set(existing.rows.filter((r) => !r.error).map((r) => r.repo))

  const listed = parseOrgRepos(gh(['api', '--paginate', `orgs/${ORG}/repos?per_page=100`, '-q', ORG_REPO_FIELDS]))
  const excluded = excludedIds(exclusions)
  const candidates = listed.filter((r) => !r.isArchived && !excluded.has(r.id) && (args.only.length === 0 || args.only.includes(r.name)))
  const missing = args.only.filter((name) => !listed.some((r) => r.name === name))
  if (missing.length) throw new Error(`--only names no repo in ${ORG}: ${missing.join(', ')}`)

  const statsDomains = readStatsDomains(args.stats)
  const apps = await listApps()
  console.log(`${listed.length} repos, ${candidates.length} candidates, ${statsDomains.length} stats labels, ${apps.length} Coolify apps`)

  // A repo already scanned is known to be Astro, unless --rescan asks again (a site can drop it).
  const orgRepos: OrgRepo[] = candidates.map((r) => ({ ...r, astro: (!args.rescan && scanned.has(r.name)) || isAstroRepo(r.name) }))
  const plan = planPool({ orgRepos, statsDomains, exclusions, apps })
  // With --only, the unmatched list covers only the named repos; keep what a full run found.
  const unmatched = args.only.length
    ? [...new Set([...existing.unmatched.filter((r) => !args.only.includes(r)), ...plan.unmatched])].sort()
    : plan.unmatched
  console.log(`${plan.repos.length} in the pool, ${plan.unmatched.length} Astro repos unmatched, ${args.rescan ? 'every row detected again (--rescan)' : `${scanned.size} already scanned`}`)

  const file = await scanPool(plan.repos, { rows: existing.rows, unmatched }, {
    dirFor: (repo) => join(args.work, repo),
    clone: async (repo, dir) => {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(args.work, { recursive: true })
      gh(['repo', 'clone', `${ORG}/${repo}`, dir, '--', '--depth', '1', '--filter=blob:limit=1m', '--quiet'])
    },
    detect: (dir, repo, domains) => detect(diskSite(dir), repo, domains),
    remove: (dir) => rmSync(dir, { recursive: true, force: true }),
    save: (f) => writePool(args.out, f),
    log: (line) => console.log(line),
  }, { limit: args.limit, rescan: args.rescan })
  writePool(args.out, file)
  console.log(`→ ${args.out} (${file.rows.length} rows, ${file.rows.filter((r) => r.error).length} errors)`)
  return 0
}

if (isEntryScript(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error((e as Error).message)
      process.exit(1)
    },
  )
}
