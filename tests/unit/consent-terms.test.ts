import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { CONSENT_VERSION } from '../../src/config'
import { SERVICES } from '../../src/services'
import { TEXTS } from '../../src/text'

type Json = Record<string, any>

const sv: Json = JSON.parse(readFileSync(new URL('../../src/text/sv.json', import.meta.url), 'utf8'))
const registry: Record<string, string> = JSON.parse(
  readFileSync(new URL('./consent-terms.json', import.meta.url), 'utf8'),
)

const registryEn: Record<string, string> = JSON.parse(
  readFileSync(new URL('./consent-terms.en.json', import.meta.url), 'utf8'),
)

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const obj = value as Json
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function termsHash(svObj: Json, servicesObj: Record<string, Json>): string {
  const terms = canonical({
    sv: {
      consent: svObj.consent,
      categories: svObj.categories,
      embed: { remember: svObj.embed.remember, info: svObj.embed.info },
    },
    services: Object.fromEntries(
      Object.entries(servicesObj).map(([slug, s]) => [
        slug,
        { category: s.category, vendor: s.vendor, description_sv: s.description_sv },
      ]),
    ),
  })
  return createHash('sha256').update(terms).digest('hex')
}

function termsHashEn(en: Json, servicesObj: Record<string, Json>): string {
  const terms = canonical({
    en: {
      consent: en.consent,
      categories: en.categories,
      embed: { remember: en.embed.remember, info: en.embed.info },
    },
    services: Object.fromEntries(
      Object.entries(servicesObj).map(([slug, s]) => [
        slug,
        {
          category: s.category,
          vendor: s.vendor,
          description_en: s.description_en,
          name: s.name_en ?? s.name,
        },
      ]),
    ),
  })
  return createHash('sha256').update(terms).digest('hex')
}

const hash = termsHash(sv, SERVICES)
const hashEn = termsHashEn(TEXTS.en, SERVICES)

describe('consent terms are tied to CONSENT_VERSION', () => {
  test('registered', () => {
    expect(
      registry[String(CONSENT_VERSION)],
      `No consent-terms entry for CONSENT_VERSION=${CONSENT_VERSION}. Add "${CONSENT_VERSION}": "${hash}".`,
    ).toBeDefined()
  })

  test('unchanged', () => {
    expect(
      hash,
      `Consent terms changed (banner/category wording or a service's category, vendor or purpose). ` +
        `Raise CONSENT_VERSION in src/config.ts and add a new entry to both consent-terms.json and consent-terms.en.json; never edit an existing one. Current hash: ${hash}`,
    ).toBe(registry[String(CONSENT_VERSION)])
  })

  test('excluded keys do not change the hash', () => {
    const copy = structuredClone(sv)
    copy.embed.show = 'changed'
    copy.notice.body = 'changed'
    expect(termsHash(copy, SERVICES)).toBe(hash)
  })

  test('included keys change the hash', () => {
    const copy = structuredClone(SERVICES) as Record<string, Json>
    copy['google-maps']!.description_sv += ' x'
    expect(termsHash(sv, copy)).not.toBe(hash)
  })
})

describe('English consent terms are tied to CONSENT_VERSION', () => {
  test('registered', () => {
    expect(
      registryEn[String(CONSENT_VERSION)],
      `No consent-terms.en entry for CONSENT_VERSION=${CONSENT_VERSION}. Add "${CONSENT_VERSION}": "${hashEn}".`,
    ).toBeDefined()
  })

  test('unchanged', () => {
    expect(
      hashEn,
      `English consent terms changed. Raise CONSENT_VERSION in src/config.ts and add a new entry to both ` +
        `consent-terms.json and consent-terms.en.json; never edit an existing one. Current hash: ${hashEn}`,
    ).toBe(registryEn[String(CONSENT_VERSION)])
  })

  test('included keys change the hash', () => {
    const copy = structuredClone(TEXTS.en) as Json
    copy.consent.decline += ' x'
    expect(termsHashEn(copy, SERVICES)).not.toBe(hashEn)
    const svc = structuredClone(SERVICES) as Record<string, Json>
    svc['google-calendar']!.name_en += ' x'
    expect(termsHashEn(TEXTS.en, svc)).not.toBe(hashEn)
  })

  test('excluded keys do not change the hash', () => {
    const copy = structuredClone(TEXTS.en) as Json
    copy.notice.body = 'changed'
    copy.embed.show = 'changed'
    expect(termsHashEn(copy, SERVICES)).toBe(hashEn)
  })
})
