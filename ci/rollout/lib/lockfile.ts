// package-lock.json helpers: the installed major of a package, and a check that installing
// astro-consent changed nothing in a site's lockfile beyond what it is known to change.

type Entry = Record<string, unknown>

export interface Lockfile {
  lockfileVersion?: number
  packages?: Record<string, Entry>
  /** lockfileVersion 1 only. */
  dependencies?: Record<string, Entry>
}

export interface AllowRule {
  /** Package name; a rule also covers platform builds named `<name>-…` (lightningcss-darwin-arm64). */
  name: string
  /** version: a version change within the same major. dev: the `dev: true` flag dropped. */
  changes: ('version' | 'dev')[]
  why: string
}

/** Lockfile changes outside astro-consent's own entries that installing it may cause. */
export const ALLOWLIST: readonly AllowRule[] = [
  {
    name: 'zod',
    changes: ['version'],
    why: 'astro-consent depends on zod ^4.6.5, so npm lifts an older zod 4 to satisfy both',
  },
  {
    name: 'lightningcss',
    changes: ['dev'],
    why: 'npm may drop the dev flag from lightningcss and its platform builds (seen on munkforstradgardstjanst in the pilot)',
  },
]

const toLock = (lock: string | Lockfile): Lockfile => (typeof lock === 'string' ? (JSON.parse(lock) as Lockfile) : lock)

function majorOfVersion(version: unknown): number | null {
  const m = typeof version === 'string' ? /^v?(\d+)\./.exec(version) : null
  return m ? Number(m[1]) : null
}

/** The major version of the top-level install of `pkg`, or null when absent or not semver. */
export function majorOf(lockJson: string | Lockfile, pkg: string): number | null {
  const lock = toLock(lockJson)
  const entry = lock.packages?.[`node_modules/${pkg}`] ?? lock.dependencies?.[pkg]
  return majorOfVersion(entry?.['version'])
}

/** `node_modules/a/node_modules/@s/b` → `@s/b`. */
function nameOfKey(key: string): string {
  const i = key.lastIndexOf('node_modules/')
  return i < 0 ? key : key.slice(i + 'node_modules/'.length)
}

const ruleFor = (name: string): AllowRule | undefined =>
  ALLOWLIST.find((r) => name === r.name || name.startsWith(`${r.name}-`))

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

function changedFields(before: Entry, after: Entry): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((k) => !same(before[k], after[k])).sort()
}

/** True when the root entry ("") changed only in `dependencies[pkgName]`. */
function rootOnlyAddsPkg(before: Entry, after: Entry, pkgName: string): boolean {
  const strip = (e: Entry): Entry => {
    const deps = { ...((e['dependencies'] as Record<string, unknown> | undefined) ?? {}) }
    delete deps[pkgName]
    return { ...e, dependencies: deps }
  }
  return changedFields(strip(before), strip(after)).length === 0
}

/**
 * Sorts every changed `packages` entry into allowed (astro-consent's own entries, the root's
 * dependency on it, and the ALLOWLIST) and unknown (everything else, for a human to look at).
 * Each item reads `<key>: <what changed>`; the root entry's key is shown as `(root)`.
 */
export function diffLock(
  before: string | Lockfile,
  after: string | Lockfile,
  pkgName: string,
): { allowed: string[]; unknown: string[] } {
  const a = toLock(before).packages
  const b = toLock(after).packages
  if (!a || !b) return { allowed: [], unknown: ['lockfile has no packages map (lockfileVersion < 2)'] }

  const allowed: string[] = []
  const unknown: string[] = []
  const own = `node_modules/${pkgName}`
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()

  for (const key of keys) {
    const was = a[key]
    const now = b[key]
    if (same(was, now)) continue
    const label = key === '' ? '(root)' : key
    const name = nameOfKey(key)
    const rule = ruleFor(name)

    if (key === own) {
      allowed.push(`${label}: ${was ? `${String(was['version'])} → ` : 'added '}${String(now?.['version'] ?? 'removed')}`)
      continue
    }
    if (!was || !now) {
      const what = now ? `added ${String(now['version'])}` : `removed ${String(was?.['version'])}`
      // A dependency nested under astro-consent itself (its own zod) is its business.
      if (now && key.startsWith(`${own}/node_modules/`) && rule) allowed.push(`${label}: ${what}`)
      else unknown.push(`${label}: ${what}`)
      continue
    }
    if (key === '') {
      if (rootOnlyAddsPkg(was, now, pkgName)) allowed.push(`${label}: dependency on ${pkgName}`)
      else unknown.push(`${label}: ${changedFields(was, now).join(', ')} changed`)
      continue
    }

    const fields = changedFields(was, now)
    const notes: string[] = []
    const rest = fields.filter((f) => {
      if (rule?.changes.includes('dev') && f === 'dev' && was['dev'] === true && now['dev'] === undefined) {
        notes.push('dev flag removed')
        return false
      }
      if (
        rule?.changes.includes('version') &&
        ['version', 'resolved', 'integrity'].includes(f) &&
        majorOfVersion(was['version']) !== null &&
        majorOfVersion(was['version']) === majorOfVersion(now['version'])
      ) {
        if (f === 'version') notes.push(`${String(was['version'])} → ${String(now['version'])}`)
        return false
      }
      return true
    })
    if (rest.length === 0) allowed.push(`${label}: ${notes.join(', ')}`)
    else {
      const version = fields.includes('version') ? `${String(was['version'])} → ${String(now['version'])}; ` : ''
      unknown.push(`${label}: ${version}${fields.join(', ')} changed`)
    }
  }
  return { allowed, unknown }
}
