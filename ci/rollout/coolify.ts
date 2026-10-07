// Read-only access to Coolify's applications and their deployments.
//
// Field names, as GET /api/v1/applications returns them (checked 2026-10-07):
//   uuid, name
//   git_repository  'visionmediahq/<repo>' (other owners appear as '<owner>/<repo>'); the
//                   https and git@ forms are accepted too
//   git_branch      'main', or 'staging', 'production', a feature branch...
//   fqdn            comma-separated URLs ('https://x.se,https://www.x.se'), sometimes with a
//                   trailing slash, or null
//   git_full_url    null
// No auto-deploy flag is returned, neither in the list nor in GET /api/v1/applications/{uuid}.
// `is_auto_deploy_enabled` (top level or under `settings`) is read when present; otherwise
// autoDeploy is true, Coolify's default for a GitHub-app source. Whether an app really follows
// `main` is inferred from its deployments instead (Ruling 14, `followsMain`).
//
// GET /api/v1/deployments/applications/{uuid}?take=N (checked 2026-10-08) answers
// { count, deployments: [...] }, newest first. Per deployment:
//   id               increasing
//   commit           the full 40-character sha
//   status           'queued', 'in_progress', 'finished', 'failed', 'cancelled-by-user'
//   pull_request_id  0 for a deployment of the app's branch, the PR number for a preview
//   is_webhook, created_at, finished_at, commit_message, logs, ... (not used)
//
// Credentials: COOLIFY_URL and COOLIFY_READ_TOKEN, parsed from ~/sites/vision-books/.env (never
// sourced). Only the read token is used, only for GET. Neither value is ever printed.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface App {
  uuid: string
  name: string
  /** The visionmediahq repo name, or null for another owner or no git source. */
  repo: string | null
  branch: string
  /** Lower-case hosts from `fqdn`, in the order Coolify lists them. */
  fqdns: string[]
  autoDeploy: boolean
}

export interface CoolifyApplication {
  uuid: string
  name: string
  git_repository?: string | null
  git_branch?: string | null
  fqdn?: string | null
  is_auto_deploy_enabled?: boolean
  settings?: { is_auto_deploy_enabled?: boolean } | null
}

export interface CoolifyEnv {
  url: string
  token: string
}

const ORG = 'visionmediahq'

/**
 * The repo a Coolify git_repository names, when it is in visionmediahq:
 * 'git@github.com:visionmediahq/x.git', 'https://github.com/visionmediahq/x(.git)' and
 * 'visionmediahq/x' are all 'x'.
 */
export function repoName(gitUrl: string | null | undefined): string | null {
  if (!gitUrl) return null
  const path = gitUrl
    .trim()
    .replace(/^git@github\.com:/i, '')
    .replace(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\//i, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(path)
  if (!m || m[1]!.toLowerCase() !== ORG) return null
  return m[2]!
}

function hosts(fqdn: string | null | undefined): string[] {
  if (!fqdn) return []
  const out: string[] = []
  for (const part of fqdn.split(',')) {
    const host = part
      .trim()
      .replace(/^[a-z]+:\/\//i, '')
      .replace(/[/:?#].*$/, '')
      .toLowerCase()
    if (host && !out.includes(host)) out.push(host)
  }
  return out
}

export function toApp(raw: CoolifyApplication): App {
  return {
    uuid: raw.uuid,
    name: raw.name,
    repo: repoName(raw.git_repository),
    branch: raw.git_branch ?? '',
    fqdns: hosts(raw.fqdn),
    autoDeploy: raw.is_auto_deploy_enabled ?? raw.settings?.is_auto_deploy_enabled ?? true,
  }
}

/** Takes the two lines from an env file's text. Errors name the variable, never a value. */
export function coolifyEnv(text: string): CoolifyEnv {
  const found: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(COOLIFY_URL|COOLIFY_READ_TOKEN)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) found[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  for (const name of ['COOLIFY_URL', 'COOLIFY_READ_TOKEN']) {
    if (!found[name]) throw new Error(`${name} is missing from the env file`)
  }
  return { url: found.COOLIFY_URL!.replace(/\/+$/, ''), token: found.COOLIFY_READ_TOKEN! }
}

export const ENV_FILE = join(homedir(), 'sites/vision-books/.env')

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export interface CoolifyOptions {
  env?: CoolifyEnv
  fetch?: Fetch
}

/** One GET with the read token. Errors name the path and status, never the URL host or token. */
async function getJson(path: string, opts: CoolifyOptions): Promise<unknown> {
  const env = opts.env ?? coolifyEnv(readFileSync(ENV_FILE, 'utf8'))
  const get = opts.fetch ?? fetch
  const res = await get(`${env.url}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${env.token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Coolify GET ${path.replace(/\?.*$/, '')} answered ${res.status}`)
  return (await res.json()) as unknown
}

export async function listApps(opts: CoolifyOptions = {}): Promise<App[]> {
  const body = await getJson('/api/v1/applications', opts)
  if (!Array.isArray(body)) throw new Error('Coolify GET /api/v1/applications did not return a list')
  return (body as CoolifyApplication[]).map(toApp)
}

/** The apps that deploy `repo`'s `main` branch (spec C5 "Which apps"). */
export function appsFor(apps: App[], repo: string): App[] {
  return apps.filter((a) => a.repo !== null && a.repo.toLowerCase() === repo.toLowerCase() && a.branch === 'main')
}

export interface Deployment {
  id: number
  commit: string
  status: string
  /** 0 for a deployment of the app's own branch, else the PR of a preview deployment. */
  pullRequestId: number
}

interface CoolifyDeployment {
  id: number
  commit?: string | null
  status?: string | null
  pull_request_id?: number | null
}

/**
 * Ruling 36: enough history that the last main deployment is still in the page when an app also
 * builds many preview deployments.
 */
export const DEPLOYMENTS_TAKE = 50

/** The app's latest deployments (DEPLOYMENTS_TAKE of them), newest first. */
export async function listDeployments(uuid: string, opts: CoolifyOptions & { take?: number } = {}): Promise<Deployment[]> {
  const body = await getJson(`/api/v1/deployments/applications/${encodeURIComponent(uuid)}?take=${opts.take ?? DEPLOYMENTS_TAKE}`, opts)
  const list = Array.isArray(body) ? body : (body as { deployments?: unknown }).deployments
  if (!Array.isArray(list)) throw new Error('Coolify GET /api/v1/deployments/applications did not return a list')
  return (list as CoolifyDeployment[])
    .map((d) => ({ id: d.id, commit: (d.commit ?? '').toLowerCase(), status: d.status ?? '', pullRequestId: d.pull_request_id ?? 0 }))
    .sort((a, b) => b.id - a.id)
}

/** Same commit, allowing an abbreviated sha (7+ characters) on either side. */
export function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x))
}

/** Deployments of the app's own branch (not PR previews), newest first. */
const ofBranch = (deployments: Deployment[]): Deployment[] => deployments.filter((d) => d.pullRequestId === 0).sort((a, b) => b.id - a.id)

/** The commit of the app's latest finished deployment of its branch, or null. */
export function lastDeployed(deployments: Deployment[]): string | null {
  return ofBranch(deployments).find((d) => d.status === 'finished')?.commit ?? null
}

/**
 * Ruling 14: Coolify has no auto-deploy flag, so an app follows `main` when it deployed the
 * current `main` head: its latest finished deployment is `head`, or `head` is queued or in progress
 * (the push already triggered it). Anything else, e.g. nhrk.vmedia.se still on a commit from the
 * week before, is treated as not redeploying from main.
 */
export function followsMain(deployments: Deployment[], head: string): boolean {
  const own = ofBranch(deployments)
  if (own.some((d) => sameCommit(d.commit, head) && (d.status === 'queued' || d.status === 'in_progress'))) return true
  const last = lastDeployed(own)
  return last !== null && sameCommit(last, head)
}

export type DeployStatus = 'finished' | 'failed' | 'cancelled' | 'timeout'

export interface WaitOptions extends CoolifyOptions {
  /** Default 20 s (spec C5). */
  pollMs?: number
  /** Default 15 min (spec C5). */
  maxMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Called after each poll with the newest matching deployment's status ('none' before it appears). */
  onPoll?: (status: string, elapsedMs: number) => void
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Polls the app's deployments until its deployment of `sha` (on its own branch, not a PR preview)
 * is finished, failed or cancelled; 'timeout' after `maxMs`. The first poll is immediate. An API
 * error counts as "not yet" and is polled again.
 */
export async function waitDeployed(app: App, sha: string, opts: WaitOptions = {}): Promise<DeployStatus> {
  const pollMs = opts.pollMs ?? 20_000
  const maxMs = opts.maxMs ?? 900_000
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? realSleep
  const start = now()
  for (;;) {
    let status = 'none'
    try {
      const match = ofBranch(await listDeployments(app.uuid, opts)).find((d) => sameCommit(d.commit, sha))
      if (match) status = match.status
    } catch (e) {
      status = `error (${(e as Error).message})`
    }
    const elapsed = now() - start
    opts.onPoll?.(status, elapsed)
    if (status === 'finished' || status === 'failed') return status
    if (status.startsWith('cancelled')) return 'cancelled'
    if (elapsed >= maxMs) return 'timeout'
    await sleep(Math.min(pollMs, maxMs - elapsed))
  }
}
