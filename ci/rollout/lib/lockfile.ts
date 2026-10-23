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
  /** Package name, matched exactly. */
  name: string
  /** Also covers the package's platform builds, `<name>-<os>-<cpu>…` (lightningcss-darwin-arm64). */
  platformBuilds?: boolean
  /** version: a version change within `major` (both sides). dev: the `dev: true` flag dropped. */
  changes: ('version' | 'dev')[]
  /** Required with 'version': the one major the change may move within. */
  major?: number
  why: string
}

/** Lockfile changes outside astro-consent's own entries that installing it may cause. */
export const ALLOWLIST: readonly AllowRule[] = [
  {
    name: 'zod',
    changes: ['version'],
    major: 4,
    why: 'astro-consent depends on zod ^4.6.5, so npm lifts an older zod 4 to satisfy both',
  },
  {
    name: 'lightningcss',
    platformBuilds: true,
    changes: ['dev'],
    why: 'npm may drop the dev flag from lightningcss and its platform builds (seen on a pilot site)',
  },
]

/**
 * A package the banner needs that a site may not have: added at `major` where main had none of it,
 * it is part of the wiring (site 1243331215 had no daisyUI). An install on main, or another major, is not.
 */
export const REQUIRED = {
  name: 'daisyui',
  major: 5,
  why: 'the banner requires daisyUI 5; main had none',
} as const

const toLock = (lock: string | Lockfile): Lockfile => (typeof lock === 'string' ? (JSON.parse(lock) as Lockfile) : lock)

function majorOfVersion(version: unknown): number | null {
  const m = typeof version === 'string' ? /^v?(\d+)\./.exec(version) : null
  return m ? Number(m[1]) : null
}

/** `^5.7.47` → 5: the major a dependency range starts at, or null. */
function majorOfRange(range: unknown): number | null {
  const m = typeof range === 'string' ? /^[\^~]?v?(\d+)\./.exec(range) : null
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

const PLATFORM = /^-(?:darwin|linux|win32|android|freebsd|openbsd|netbsd|sunos|aix)-[a-z0-9-]+$/

const ruleFor = (name: string): AllowRule | undefined =>
  ALLOWLIST.find(
    (r) => name === r.name || (r.platformBuilds === true && name.startsWith(r.name) && PLATFORM.test(name.slice(r.name.length))),
  )

/** The version moved within the rule's major: both sides parse and both are `rule.major`. */
const withinMajor = (rule: AllowRule, was: unknown, now: unknown): boolean =>
  rule.major !== undefined && majorOfVersion(was) === rule.major && majorOfVersion(now) === rule.major

/** JSON with object keys sorted at every level: npm re-sorting keys is not a change. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  )

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)

function changedFields(before: Entry, after: Entry): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((k) => !same(before[k], after[k])).sort()
}

const depsOf = (e: Entry | undefined, map = 'dependencies'): Record<string, unknown> =>
  (e?.[map] as Record<string, unknown> | undefined) ?? {}

/** The root entry ("") without its dependency on each of `names`: what is left must not change. */
function stripPkg(e: Entry, names: string[]): Entry {
  const deps = { ...depsOf(e) }
  for (const n of names) delete deps[n]
  return { ...e, dependencies: deps }
}

/** Root-entry fields npm copies from package.json on install. */
const SYNCED_FIELDS = ['name', 'version', 'engines', 'license', 'bin', 'funding']

/**
 * Sorts every changed `packages` entry into allowed (astro-consent's own entries, the root's
 * dependency on it, REQUIRED where main had none, and the ALLOWLIST) and unknown (everything
 * else, for a human to look at).
 * Each item reads `<key>: <what changed>`; the root entry's key is shown as `(root)`.
 *
 * `site` is the branch package.json. npm copies some of its fields (SYNCED_FIELDS) into the root
 * entry on install, so a lockfile left stale on main (another `engines`, astro-starter's `name`)
 * changes there too: allowed only when the new value is exactly package.json's (a field missing
 * from package.json never matches).
 */
export function diffLock(
  before: string | Lockfile,
  after: string | Lockfile,
  pkgName: string,
  site: Record<string, unknown> = {},
): { allowed: string[]; unknown: string[] } {
  const a = toLock(before).packages
  const b = toLock(after).packages
  if (!a || !b) return { allowed: [], unknown: ['lockfile has no packages map (lockfileVersion < 2)'] }

  const allowed: string[] = []
  const unknown: string[] = []
  const own = `node_modules/${pkgName}`
  const required = `node_modules/${REQUIRED.name}`
  // REQUIRED added: nowhere on main, a top-level install and a root dependency of its major on the branch.
  const addsRequired =
    !a[required] &&
    !(REQUIRED.name in depsOf(a[''])) &&
    !(REQUIRED.name in depsOf(a[''], 'devDependencies')) &&
    majorOfVersion(b[required]?.['version']) === REQUIRED.major &&
    majorOfRange(depsOf(b[''])[REQUIRED.name]) === REQUIRED.major
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()

  for (const key of keys) {
    const was = a[key]
    const now = b[key]
    if (same(was, now)) continue
    const label = key === '' ? '(root)' : key
    const name = nameOfKey(key)
    const rule = ruleFor(name)

    if (key === own) {
      // Installing never removes the package itself: a lockfile without it is not what was wired.
      if (!now) {
        unknown.push(`${label}: removed ${String(was?.['version'])}`)
        continue
      }
      allowed.push(`${label}: ${was ? `${String(was['version'])} → ` : 'added '}${String(now?.['version'] ?? 'removed')}`)
      continue
    }
    if (key === required && addsRequired) {
      allowed.push(`${label}: added ${String(now?.['version'])} (${REQUIRED.why})`)
      continue
    }
    if (!was || !now) {
      const what = now ? `added ${String(now['version'])}` : `removed ${String(was?.['version'])}`
      // A dependency nested under astro-consent itself (its own zod) is its business.
      if (now && key.startsWith(`${own}/node_modules/`) && rule && (!rule.changes.includes('version') || withinMajor(rule, now['version'], now['version'])))
        allowed.push(`${label}: ${what}`)
      else unknown.push(`${label}: ${what}`)
      continue
    }
    if (key === '') {
      const added = addsRequired ? [pkgName, REQUIRED.name] : [pkgName]
      const fields = changedFields(stripPkg(was, added), stripPkg(now, added))
      const synced = fields.filter((f) => SYNCED_FIELDS.includes(f) && site[f] !== undefined && same(now[f], site[f]))
      const rest = fields.filter((f) => !synced.includes(f))
      if (rest.length === 0)
        allowed.push(
          `${label}: dependency on ${added.join(' and ')}` +
            synced.map((f) => `; ${f} synced to package.json (${canonical(was[f])} → ${canonical(now[f])})`).join(''),
        )
      else unknown.push(`${label}: ${fields.join(', ')} changed`)
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
        withinMajor(rule, was['version'], now['version'])
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

/** package.json maps npm install drops when empty. */
const DEP_MAPS = ['devDependencies', 'optionalDependencies', 'peerDependencies']

/**
 * What changed in package.json besides `pkgName` (and REQUIRED, where main had none) being added
 * to `dependencies`, compared without regard to key order (npm re-sorts dependencies, spec C3.1). Empty when the package's dependency
 * entry is the only change; otherwise one line per changed field, plus one if the package is missing.
 */
export function diffPackageJson(before: string, after: string, pkgName: string): string[] {
  const a = JSON.parse(before) as Record<string, unknown>
  const b = JSON.parse(after) as Record<string, unknown>
  const out: string[] = []
  const depsA = { ...((a['dependencies'] as Record<string, unknown> | undefined) ?? {}) }
  const depsB = { ...((b['dependencies'] as Record<string, unknown> | undefined) ?? {}) }
  if (typeof depsB[pkgName] !== 'string') out.push(`dependencies.${pkgName}: missing`)
  delete depsA[pkgName]
  delete depsB[pkgName]
  // REQUIRED added to dependencies where main had it in neither map (see diffLock).
  const devA = (a['devDependencies'] as Record<string, unknown> | undefined) ?? {}
  if (!(REQUIRED.name in depsA) && !(REQUIRED.name in devA) && majorOfRange(depsB[REQUIRED.name]) === REQUIRED.major)
    delete depsB[REQUIRED.name]
  for (const k of [...new Set([...Object.keys(depsA), ...Object.keys(depsB)])].sort()) {
    if (!same(depsA[k], depsB[k])) out.push(`dependencies.${k}: ${JSON.stringify(depsA[k] ?? null)} → ${JSON.stringify(depsB[k] ?? null)}`)
  }
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== 'dependencies').sort()) {
    // npm install drops an empty dependency map ("devDependencies": {}): absent and empty are one.
    const empty = (v: unknown): boolean => DEP_MAPS.includes(k) && (v === undefined || same(v, {}))
    if (!same(a[k], b[k]) && !(empty(a[k]) && empty(b[k]))) out.push(`${k}: changed`)
  }
  return out
}

/** The names a package requires: its dependency maps, and a peer only when its meta is not optional. */
function requiredNames(e: Entry): string[] {
  const names = ['dependencies', 'optionalDependencies', 'devDependencies'].flatMap((m) => Object.keys(depsOf(e, m)))
  const meta = (e['peerDependenciesMeta'] as Record<string, { optional?: unknown } | undefined> | undefined) ?? {}
  for (const n of Object.keys(depsOf(e, 'peerDependencies'))) if (meta[n]?.optional !== true) names.push(n)
  return names
}

/** The order npm writes `packages` in. */
const npmCompare = (a: string, b: string): number => a.localeCompare(b, 'en')

/**
 * Puts back the `packages` entries `npm install` pruned that main had and nothing requires: each is
 * marked `optional` (or `devOptional`) on main, and no package on main outside that set names it in
 * `dependencies`, `optionalDependencies`, `devDependencies` or a non-optional peer, so a package and
 * the platform builds only it requires go together. Vite 8 sites still had esbuild 0.28.2 and its 26
 * @esbuild/* builds on main, which vite lists only as an optional peer (site 1240501458, site 1219936814): `npm ci`
 * with them kept installs main's tree. Any other removal is left for verify step 1.
 *
 * Returns the new lockfile text (in the file's own indent and line ending, the kept entries' values
 * exactly main's, slotted into npm's key order) and `name version` of each kept entry, or null when
 * nothing is kept: then the file stays exactly as npm wrote it.
 */
export function keepPrunedOrphans(main: string, installed: string): { text: string; kept: string[] } | null {
  const lock = toLock(installed)
  // Version 2 also keeps a legacy `dependencies` map this does not touch: leave it to verify.
  if (toLock(main).lockfileVersion !== 3 || lock.lockfileVersion !== 3) return null
  const a = toLock(main).packages
  const b = lock.packages
  if (!a || !b) return null
  // Never one the new lockfile requires: npm may have placed its own copy (nested) on purpose.
  const neededNow = new Set(Object.values(b).flatMap(requiredNames))
  const orphans = new Set(
    Object.keys(a).filter((k) => k !== '' && !b[k] && !neededNow.has(nameOfKey(k)) && (a[k]!['optional'] === true || a[k]!['devOptional'] === true)),
  )
  // Drop every candidate something outside the set requires, until the set holds still.
  for (let changed = true; changed && orphans.size > 0; ) {
    changed = false
    const required = new Set(Object.entries(a).flatMap(([k, e]) => (orphans.has(k) ? [] : requiredNames(e))))
    for (const k of orphans) {
      if (required.has(nameOfKey(k))) {
        orphans.delete(k)
        changed = true
      }
    }
  }
  if (orphans.size === 0) return null

  // Each kept entry goes before the first key npm sorts after it; npm's own keys keep their order.
  const sorted = [...orphans].sort(npmCompare)
  const keys = Object.keys(b)
  for (const k of sorted) {
    const at = keys.findIndex((x) => x !== '' && npmCompare(k, x) < 0)
    keys.splice(at < 0 ? keys.length : at, 0, k)
  }
  lock.packages = Object.fromEntries(keys.map((k) => [k, b[k] ?? a[k]!]))
  const indent = /^[{[]\r?\n([ \t]+)/.exec(installed)?.[1] ?? '  '
  const eol = installed.includes('\r\n') ? '\r\n' : '\n'
  const text = `${JSON.stringify(lock, null, indent)}\n`.replace(/\n/g, eol)
  return { text, kept: sorted.map((k) => `${nameOfKey(k)} ${String(a[k]!['version'])}`) }
}
