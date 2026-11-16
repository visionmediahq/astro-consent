import { expect, test } from 'vitest'
import { LANGS, TEXTS, resolveLang } from '../../src/text/index'

const sv = TEXTS.sv

function keysOf(value: unknown, prefix = ''): string[] {
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => keysOf(v, prefix ? `${prefix}.${k}` : k)).sort()
  }
  return [prefix]
}

function valueAt(root: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], root)
}

function get(key: string): unknown {
  return valueAt(sv, key)
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
  'embed.show', 'embed.remember', 'embed.info', 'embed.open', 'embed.unavailable',
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
  for (const lang of LANGS) {
    const strings = allStrings(TEXTS[lang])
    expect(strings.length, lang).toBeGreaterThan(0)
    for (const text of strings) {
      expect(text, lang).not.toMatch(/inga (spårnings)?cookies|inga tredjepart|inga externa/i)
      expect(text, lang).not.toMatch(/\bno (tracking )?cookies|\bno third[- ]part|\bno external/i)
    }
  }
})

test('every language file has exactly the keys of sv.json, none empty', () => {
  for (const lang of LANGS) expect(keysOf(TEXTS[lang]), lang).toEqual(keysOf(TEXTS.sv))
  for (const lang of LANGS) for (const s of allStrings(TEXTS[lang])) expect(s.trim(), lang).not.toBe('')
})

test('every placeholder in a Swedish value is in the other languages too', () => {
  const placeholders = (v: unknown) => [...new Set(String(v).match(/\{\w+\}/g) ?? [])].sort()
  for (const lang of LANGS) {
    for (const key of keysOf(TEXTS.sv)) {
      expect(placeholders(valueAt(TEXTS[lang], key)), `${lang} ${key}`).toEqual(placeholders(valueAt(TEXTS.sv, key)))
    }
  }
})

test('resolveLang: the prop wins, normalised; unsupported is Swedish', () => {
  expect(resolveLang('en')).toBe('en')
  expect(resolveLang('en-GB')).toBe('en')
  expect(resolveLang('EN')).toBe('en')
  expect(resolveLang('de', 'en')).toBe('sv')
  expect(resolveLang('', 'en')).toBe('en')
  expect(resolveLang(undefined, 'en')).toBe('en')
  expect(resolveLang(undefined, 'sv')).toBe('sv')
  expect(resolveLang(undefined, undefined)).toBe('sv')
  expect(resolveLang(null, 'fr')).toBe('sv')
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
