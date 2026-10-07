import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { CONSENT_VERSION } from '../../src/config'
import { SERVICES } from '../../src/services'

type Json = Record<string, any>

const sv: Json = JSON.parse(readFileSync(new URL('../../src/text/sv.json', import.meta.url), 'utf8'))
const registry: Record<string, string> = JSON.parse(
  readFileSync(new URL('./consent-terms.json', import.meta.url), 'utf8'),
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

const hash = termsHash(sv, SERVICES)

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
        `Raise CONSENT_VERSION in src/config.ts and add a new entry; never edit an existing one. Current hash: ${hash}`,
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
