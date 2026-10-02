// Pure consent-record logic. Runs in the browser and in unit tests; no DOM access of its own.
import { CATEGORIES, SERVICES, SERVICE_SLUGS, isCategory, type Category, type ServiceSlug, type Target } from './services'

export type Choice = 'all' | 'none' | 'custom' | 'notice_ok'

export interface ConsentRecord {
  id: string
  version: string
  saved_at: string
  /** What the visitor answered in the banner; null while only an embed grant has been saved. */
  choice: Choice | null
  categories: Category[]
  services: ServiceSlug[]
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const STORAGE_KEY = 'vm_consent'
export const MAX_AGE_MS = 365 * 24 * 3600 * 1000

const CHOICES: readonly string[] = ['all', 'none', 'custom', 'notice_ok']

function isRecordShape(value: unknown): value is ConsentRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.version === 'string' &&
    typeof record.saved_at === 'string' &&
    (record.choice === null || (typeof record.choice === 'string' && CHOICES.includes(record.choice))) &&
    Array.isArray(record.categories) &&
    record.categories.every((item) => (CATEGORIES as readonly unknown[]).includes(item)) &&
    Array.isArray(record.services) &&
    record.services.every((item) => (SERVICE_SLUGS as unknown[]).includes(item))
  )
}

export function parseRecord(raw: string | null, version: string, now: Date): ConsentRecord | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecordShape(parsed)) return null
  if (parsed.version !== version) return null
  const savedAt = Date.parse(parsed.saved_at)
  if (Number.isNaN(savedAt) || now.getTime() - savedAt > MAX_AGE_MS) return null
  return parsed
}

/** Never writes: a stale or corrupt value is ignored, not removed. */
export function readRecord(storage: StorageLike | null, version: string, now: Date): ConsentRecord | null {
  if (!storage) return null
  let raw: string | null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  return parseRecord(raw, version, now)
}

export function writeRecord(storage: StorageLike | null, record: ConsentRecord): boolean {
  if (!storage) return false
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(record))
    return true
  } catch {
    return false
  }
}

export function hasConsent(record: ConsentRecord | null, target: Target): boolean {
  if (target === 'necessary') return true
  if (!record) return false
  if (isCategory(target)) return record.categories.includes(target)
  return record.services.includes(target) || record.categories.includes(SERVICES[target].category)
}

/** Targets in effect on this page that the record granted before and no longer grants. */
export function lostConsent(
  before: ConsentRecord | null,
  after: ConsentRecord | null,
  active: Iterable<Target>,
): Target[] {
  return [...active].filter((target) => hasConsent(before, target) && !hasConsent(after, target))
}

export interface CookieNames {
  exact: string[]
  prefixes: string[]
}

export function cookiesFor(lost: Target[]): CookieNames {
  const categories = new Set(lost.map((target) => (isCategory(target) ? target : SERVICES[target].category)))
  const names: CookieNames = { exact: [], prefixes: [] }
  if (categories.has('statistics')) {
    names.exact.push('_ga', '_gid')
    names.prefixes.push('_ga_')
  }
  if (categories.has('marketing')) {
    names.exact.push('_fbp')
    names.prefixes.push('_gcl_')
  }
  return names
}

/** Expires first-party cookies host-only and on every hostname suffix with at least two labels. */
export function deleteCookies(doc: { cookie: string }, hostname: string, secure: boolean, names: CookieNames): string[] {
  const present = doc.cookie
    .split(';')
    .map((pair) => pair.trim().split('=')[0] ?? '')
    .filter(Boolean)
  const targets = present.filter(
    (name) => names.exact.includes(name) || names.prefixes.some((prefix) => name.startsWith(prefix)),
  )
  const labels = hostname.split('.')
  const suffixes =
    labels.length === 1 ? [hostname] : labels.slice(0, -1).map((_, index) => labels.slice(index).join('.'))
  for (const name of targets) {
    const base = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${secure ? '; secure' : ''}`
    doc.cookie = base
    for (const suffix of suffixes) {
      doc.cookie = `${base}; domain=${suffix}`
      doc.cookie = `${base}; domain=.${suffix}`
    }
  }
  return targets
}

export function newId(source: Pick<Crypto, 'getRandomValues'> & { randomUUID?: () => string }): string {
  if (typeof source.randomUUID === 'function') return source.randomUUID()
  const bytes = source.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
