import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const path = new URL('../../src/text/sv.json', import.meta.url)
const sv = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}

function get(key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], sv)
}

function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(allStrings)
  return []
}

const KEYS = [
  'region',
  'notice.title', 'notice.body', 'notice.ok', 'notice.more',
  'consent.title', 'consent.body', 'consent.acceptAll', 'consent.decline', 'consent.settings',
  'consent.save', 'consent.back', 'consent.more', 'consent.alwaysOn', 'consent.serviceRow',
  'categories.necessary.label', 'categories.necessary.description',
  'categories.external.label', 'categories.external.description',
  'categories.statistics.label', 'categories.statistics.description',
  'categories.marketing.label', 'categories.marketing.description',
  'embed.show', 'embed.remember', 'embed.info', 'embed.open',
  'links.settings', 'links.policy',
]

test('sv.json has every key the components and runtime use', () => {
  for (const key of KEYS) {
    const value = get(key)
    expect(typeof value, key).toBe('string')
    expect(value, key).not.toBe('')
  }
})

test('no string claims there are no cookies or no third parties', () => {
  const strings = allStrings(sv)
  expect(strings.length).toBeGreaterThan(0)
  for (const text of strings) {
    expect(text).not.toMatch(/inga (spårnings)?cookies|inga tredjepart|inga externa/i)
  }
})

test('placeholders are consistent', () => {
  expect(get('embed.show')).toContain('{name}')
  expect(get('embed.show')).not.toContain('{title}')
  expect(get('embed.remember')).toContain('{name}')
  expect(get('embed.info')).toContain('{title}')
  expect(get('embed.info')).toContain('{name}')
  expect(get('embed.open')).toContain('{name}')
  expect(get('consent.serviceRow')).toContain('{name}')
})

test('the button labels are the agreed Swedish wording', () => {
  expect(get('consent.acceptAll')).toBe('Acceptera alla')
  expect(get('consent.decline')).toBe('Neka')
  expect(get('consent.settings')).toBe('Inställningar')
  expect(get('consent.save')).toBe('Spara val')
  expect(get('categories.necessary.label')).toBe('Nödvändiga')
  expect(get('categories.external.label')).toBe('Externt innehåll')
  expect(get('categories.statistics.label')).toBe('Statistik')
  expect(get('categories.marketing.label')).toBe('Marknadsföring')
  expect(get('embed.open')).toBe('Öppna i {name}')
})
