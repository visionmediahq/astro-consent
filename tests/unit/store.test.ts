import { describe, expect, test, vi } from 'vitest'
import {
  MAX_AGE_MS,
  STORAGE_KEY,
  cookiesFor,
  deleteCookies,
  hasConsent,
  lostConsent,
  newId,
  parseRecord,
  readRecord,
  writeRecord,
  type ConsentRecord,
  type StorageLike,
} from '../../src/store'

const V = '1:aaaaaa'
const NOW = new Date('2026-10-02T10:00:00Z')
const DAY = 24 * 3600 * 1000

function rec(overrides: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    id: 'abc',
    version: V,
    saved_at: NOW.toISOString(),
    choice: 'all',
    categories: ['necessary', 'external'],
    services: [],
    ...overrides,
  }
}

function memStorage(initial?: string, options: { throws?: boolean } = {}) {
  const map = new Map<string, string>()
  if (initial !== undefined) map.set(STORAGE_KEY, initial)
  const storage = {
    getItem: vi.fn((key: string) => {
      if (options.throws) throw new Error('blocked')
      return map.get(key) ?? null
    }),
    setItem: vi.fn((key: string, value: string) => {
      if (options.throws) throw new Error('blocked')
      map.set(key, value)
    }),
  }
  return { storage: storage satisfies StorageLike, map }
}

describe('parseRecord', () => {
  test('returns the record when valid', () => {
    expect(parseRecord(JSON.stringify(rec()), V, NOW)).toEqual(rec())
  })
  test('returns null for null input', () => {
    expect(parseRecord(null, V, NOW)).toBeNull()
  })
  test('returns null on corrupt JSON', () => {
    expect(parseRecord('{not json', V, NOW)).toBeNull()
  })
  test('returns null on version mismatch', () => {
    expect(parseRecord(JSON.stringify(rec({ version: '1:bbbbbb' })), V, NOW)).toBeNull()
  })
  test('returns null when older than 12 months', () => {
    const old = new Date(NOW.getTime() - 366 * DAY).toISOString()
    expect(parseRecord(JSON.stringify(rec({ saved_at: old })), V, NOW)).toBeNull()
  })
  test('returns the record when 364 days old', () => {
    const recent = new Date(NOW.getTime() - 364 * DAY).toISOString()
    expect(parseRecord(JSON.stringify(rec({ saved_at: recent })), V, NOW)).not.toBeNull()
  })
  test('returns null when a field has the wrong type', () => {
    expect(parseRecord(JSON.stringify({ ...rec(), categories: 'all' }), V, NOW)).toBeNull()
    expect(parseRecord(JSON.stringify({ ...rec(), id: 7 }), V, NOW)).toBeNull()
    expect(parseRecord(JSON.stringify({ ...rec(), choice: 'maybe' }), V, NOW)).toBeNull()
    expect(parseRecord(JSON.stringify({ ...rec(), saved_at: 'yesterday' }), V, NOW)).toBeNull()
    expect(parseRecord('"a string"', V, NOW)).toBeNull()
  })
  test('returns null for an unknown category or service', () => {
    expect(parseRecord(JSON.stringify({ ...rec(), categories: ['necessary', 'fun'] }), V, NOW)).toBeNull()
    expect(parseRecord(JSON.stringify({ ...rec(), services: ['elfsight'] }), V, NOW)).toBeNull()
  })
  test('accepts choice null', () => {
    expect(parseRecord(JSON.stringify(rec({ choice: null })), V, NOW)?.choice).toBeNull()
  })
})

describe('readRecord', () => {
  test('reads through parseRecord', () => {
    const { storage } = memStorage(JSON.stringify(rec()))
    expect(readRecord(storage, V, NOW)).toEqual(rec())
  })
  test('returns null when the key is missing', () => {
    expect(readRecord(memStorage().storage, V, NOW)).toBeNull()
  })
  test('returns null when storage is null', () => {
    expect(readRecord(null, V, NOW)).toBeNull()
  })
  test('returns null when storage throws', () => {
    expect(readRecord(memStorage(undefined, { throws: true }).storage, V, NOW)).toBeNull()
  })
  test('never writes during read', () => {
    const valid = memStorage(JSON.stringify(rec()))
    readRecord(valid.storage, V, NOW)
    expect(valid.storage.setItem).not.toHaveBeenCalled()
    const corrupt = memStorage('{not json')
    readRecord(corrupt.storage, V, NOW)
    expect(corrupt.storage.setItem).not.toHaveBeenCalled()
    expect(corrupt.map.get(STORAGE_KEY)).toBe('{not json')
  })
})

describe('writeRecord', () => {
  test('writes JSON under vm_consent and returns true', () => {
    const { storage, map } = memStorage()
    expect(writeRecord(storage, rec())).toBe(true)
    expect(STORAGE_KEY).toBe('vm_consent')
    expect(JSON.parse(map.get('vm_consent')!)).toEqual(rec())
  })
  test('returns false when storage throws', () => {
    expect(writeRecord(memStorage(undefined, { throws: true }).storage, rec())).toBe(false)
  })
  test('returns false when storage is null', () => {
    expect(writeRecord(null, rec())).toBe(false)
  })
})

describe('hasConsent', () => {
  test('necessary is always true, even with a null record', () => {
    expect(hasConsent(null, 'necessary')).toBe(true)
  })
  test('a granted category is true for the category and for every service in it', () => {
    const record = rec({ categories: ['necessary', 'marketing'] })
    expect(hasConsent(record, 'marketing')).toBe(true)
    expect(hasConsent(record, 'google-ads')).toBe(true)
    expect(hasConsent(record, 'meta-pixel')).toBe(true)
    expect(hasConsent(record, 'google-maps')).toBe(false)
  })
  test('a service granted on its own is true for that service only', () => {
    const record = rec({ categories: ['necessary'], services: ['google-maps'] })
    expect(hasConsent(record, 'google-maps')).toBe(true)
    expect(hasConsent(record, 'external')).toBe(false)
    expect(hasConsent(record, 'google-analytics')).toBe(false)
  })
  test('null record is false for everything except necessary', () => {
    expect(hasConsent(null, 'external')).toBe(false)
    expect(hasConsent(null, 'google-maps')).toBe(false)
  })
})

describe('lostConsent', () => {
  const none = rec({ choice: 'none', categories: ['necessary'] })
  test('returns active targets that had consent before and do not after', () => {
    expect(lostConsent(rec(), none, ['google-maps'])).toEqual(['google-maps'])
  })
  test('ignores targets that are not active', () => {
    expect(lostConsent(rec(), none, [])).toEqual([])
  })
  test('ignores active targets that never had record consent', () => {
    expect(lostConsent(null, null, ['google-maps'])).toEqual([])
    expect(lostConsent(null, none, ['google-maps'])).toEqual([])
  })
  test('a service kept alive by its category is not lost', () => {
    const before = rec({ categories: ['necessary'], services: ['google-maps'] })
    const after = rec({ categories: ['necessary', 'external'], services: [] })
    expect(lostConsent(before, after, ['google-maps'])).toEqual([])
  })
  test('a service kept by its own grant survives its category being removed', () => {
    const before = rec({ categories: ['necessary', 'external'], services: ['google-maps'] })
    const after = rec({ categories: ['necessary'], services: ['google-maps'] })
    expect(lostConsent(before, after, ['google-maps'])).toEqual([])
  })
  test('after null loses every active target the record granted', () => {
    const before = rec({ categories: ['necessary', 'external', 'statistics'] })
    expect(lostConsent(before, null, ['google-maps', 'google-analytics', 'meta-pixel'])).toEqual([
      'google-maps',
      'google-analytics',
    ])
  })
})

describe('cookiesFor', () => {
  test('statistics or google-analytics → _ga, _gid exact and _ga_ prefix', () => {
    const expected = { exact: ['_ga', '_gid'], prefixes: ['_ga_'] }
    expect(cookiesFor(['statistics'])).toEqual(expected)
    expect(cookiesFor(['google-analytics'])).toEqual(expected)
  })
  test('marketing, google-ads or meta-pixel → _fbp exact and _gcl_ prefix', () => {
    const expected = { exact: ['_fbp'], prefixes: ['_gcl_'] }
    expect(cookiesFor(['marketing'])).toEqual(expected)
    expect(cookiesFor(['google-ads'])).toEqual(expected)
    expect(cookiesFor(['meta-pixel'])).toEqual(expected)
  })
  test('external, google-maps and necessary → nothing', () => {
    expect(cookiesFor(['external', 'google-maps', 'necessary'])).toEqual({ exact: [], prefixes: [] })
  })
})

describe('deleteCookies', () => {
  function spyDoc(jar: string) {
    const writes: string[] = []
    const doc = {
      get cookie() {
        return jar
      },
      set cookie(value: string) {
        writes.push(value)
      },
    }
    return { doc, writes }
  }
  const statistics = cookiesFor(['statistics'])

  test('expires exact and prefixed names host-only and for every ≥2-label suffix with and without a leading dot', () => {
    const { doc, writes } = spyDoc('_ga=1; _ga_ABC=2; _gid=3; other=4')
    const deleted = deleteCookies(doc, 'www.kund.se', false, statistics)
    expect(deleted).toEqual(['_ga', '_ga_ABC', '_gid'])
    for (const name of deleted) {
      const mine = writes.filter((write) => write.startsWith(`${name}=;`))
      expect(mine).toHaveLength(5)
      expect(mine.filter((write) => !write.includes('domain='))).toHaveLength(1)
      for (const domain of ['www.kund.se', '.www.kund.se', 'kund.se', '.kund.se']) {
        expect(mine.some((write) => write.endsWith(`domain=${domain}`))).toBe(true)
      }
    }
    for (const write of writes) {
      expect(write).toContain('path=/')
      expect(write).toContain('expires=Thu, 01 Jan 1970 00:00:00 GMT')
      expect(write.startsWith('other=')).toBe(false)
    }
  })
  test('adds secure only when secure is true', () => {
    const plain = spyDoc('_ga=1')
    deleteCookies(plain.doc, 'kund.se', false, statistics)
    expect(plain.writes.every((write) => !write.includes('secure'))).toBe(true)
    const secure = spyDoc('_ga=1')
    deleteCookies(secure.doc, 'kund.se', true, statistics)
    expect(secure.writes.every((write) => write.includes('; secure'))).toBe(true)
  })
  test('single-label hostname writes host-only, domain=localhost and domain=.localhost', () => {
    const { doc, writes } = spyDoc('_ga=1')
    deleteCookies(doc, 'localhost', false, statistics)
    expect(writes).toHaveLength(3)
    expect(writes.some((write) => write.endsWith('domain=localhost'))).toBe(true)
    expect(writes.some((write) => write.endsWith('domain=.localhost'))).toBe(true)
  })
  test('never tries a public-suffix-only domain', () => {
    const { doc, writes } = spyDoc('_ga=1')
    deleteCookies(doc, 'kund.se', false, statistics)
    expect(writes.some((write) => /domain=\.?se$/.test(write))).toBe(false)
    expect(writes).toHaveLength(3)
  })
  test('writes nothing when no matching cookie is present', () => {
    const { doc, writes } = spyDoc('other=4; session=abc')
    expect(deleteCookies(doc, 'kund.se', false, statistics)).toEqual([])
    expect(writes).toEqual([])
  })
})

describe('newId', () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  test('uses randomUUID when present', () => {
    const crypto = { randomUUID: () => 'fixed-id', getRandomValues: <T>(array: T) => array }
    expect(newId(crypto as never)).toBe('fixed-id')
  })
  test('falls back to getRandomValues and returns a v4-shaped UUID', () => {
    const crypto = {
      getRandomValues: (array: Uint8Array) => {
        for (let i = 0; i < array.length; i++) array[i] = (i * 37 + 11) % 256
        return array
      },
    }
    expect(newId(crypto as never)).toMatch(UUID_V4)
  })
})

test('MAX_AGE_MS is 365 days', () => {
  expect(MAX_AGE_MS).toBe(365 * DAY)
})
