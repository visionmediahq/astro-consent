// Read-only access to Coolify's application list.
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
// autoDeploy is true, Coolify's default for a GitHub-app source.
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

export async function listApps(opts: { env?: CoolifyEnv; fetch?: Fetch } = {}): Promise<App[]> {
  const env = opts.env ?? coolifyEnv(readFileSync(ENV_FILE, 'utf8'))
  const get = opts.fetch ?? fetch
  const res = await get(`${env.url}/api/v1/applications`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${env.token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Coolify GET /api/v1/applications answered ${res.status}`)
  const body = (await res.json()) as unknown
  if (!Array.isArray(body)) throw new Error('Coolify GET /api/v1/applications did not return a list')
  return (body as CoolifyApplication[]).map(toApp)
}
