import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { CONSENT_VERSION } from '../../src/config'
import { SERVICES } from '../../src/services'
import { TEXTS } from '../../src/text'

type Json = Record<string, any>

/** One registry entry: the hash of the banner/category wording, and one hash per service. An entry
 *  may gain a slug (a service added to the registry), but nothing in it may change. */
interface TermsEntry {
  texts: string
  services: Record<string, string>
}
type TermsRegistry = Record<string, TermsEntry>

const sv: Json = JSON.parse(readFileSync(new URL('../../src/text/sv.json', import.meta.url), 'utf8'))
const registry: TermsRegistry = JSON.parse(readFileSync(new URL('./consent-terms.json', import.meta.url), 'utf8'))
const registryEn: TermsRegistry = JSON.parse(
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

const sha256 = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')

function textsHash(texts: Json): string {
  return sha256({
    consent: texts.consent,
    categories: texts.categories,
    embed: { remember: texts.embed.remember, info: texts.embed.info },
  })
}

type Projection = (service: Json) => Json

const svService: Projection = (s) => ({ category: s.category, vendor: s.vendor, description_sv: s.description_sv })
const enService: Projection = (s) => ({
  category: s.category,
  vendor: s.vendor,
  description_en: s.description_en,
  name_en: s.name_en ?? null,
})

function terms(texts: Json, services: Record<string, Json>, project: Projection): TermsEntry {
  return {
    texts: textsHash(texts),
    services: Object.fromEntries(Object.entries(services).map(([slug, s]) => [slug, sha256(project(s))])),
  }
}

const termsSv = (texts: Json, services: Record<string, Json>) => terms(texts, services, svService)
const termsEn = (texts: Json, services: Record<string, Json>) => terms(texts, services, enService)

const BUMP_ADVICE =
  'Raise CONSENT_VERSION in src/config.ts and add a new entry to both consent-terms.json and ' +
  'consent-terms.en.json; never edit an existing one.'

/** What is wrong with `entry` (the registry entry for the current CONSENT_VERSION) given the terms as
 *  they are now. A slug that is not in the entry is a new service: it is added to the entry, no bump.
 *  A slug in the entry that is gone from the registry is a removed service: nobody needs asking again. */
function termsProblems(file: string, version: string, entry: TermsEntry, current: TermsEntry): string[] {
  const problems: string[] = []
  if (entry.texts !== current.texts) {
    problems.push(`${file}: the banner or category wording changed. ${BUMP_ADVICE} Current texts hash: ${current.texts}`)
  }
  for (const [slug, hash] of Object.entries(current.services)) {
    const registered = entry.services[slug]
    if (registered === undefined) {
      problems.push(
        `${file}: service "${slug}" is not in entry "${version}". A new service needs no bump: ` +
          `add "${slug}": "${hash}" to the services of entry "${version}".`,
      )
    } else if (registered !== hash) {
      problems.push(
        `${file}: service "${slug}" changed (category, vendor or purpose). ${BUMP_ADVICE} Current hash: ${hash}`,
      )
    }
  }
  return problems
}

const version = String(CONSENT_VERSION)
const currentSv = termsSv(sv, SERVICES)
const currentEn = termsEn(TEXTS.en, SERVICES)

const cases = [
  { file: 'consent-terms.json', registry, terms: currentSv },
  { file: 'consent-terms.en.json', registry: registryEn, terms: currentEn },
]

describe.each(cases)('$file is tied to CONSENT_VERSION', ({ file, registry, terms }) => {
  test('every entry has the { texts, services } shape', () => {
    for (const [v, entry] of Object.entries(registry)) {
      expect(typeof entry.texts, `${file} entry "${v}"`).toBe('string')
      expect(typeof entry.services, `${file} entry "${v}"`).toBe('object')
      for (const hash of Object.values(entry.services)) expect(hash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  test('registered', () => {
    expect(
      registry[version],
      `No ${file} entry for CONSENT_VERSION=${version}. Add "${version}": ${JSON.stringify(terms)}.`,
    ).toBeDefined()
  })

  test('unchanged', () => {
    const entry = registry[version]
    if (!entry) return // 'registered' reports it
    expect(termsProblems(file, version, entry, terms).join('\n')).toBe('')
  })
})

describe('termsProblems', () => {
  const entry = currentSv
  const withNew = (s: Record<string, Json>) => ({
    ...s,
    'new-service': { category: 'external', vendor: 'V', description_sv: 'Ny.', description_en: 'New.' },
  })

  test('a new service added to the current entry passes with no bump', () => {
    const now = termsSv(sv, withNew(SERVICES))
    const added = { texts: entry.texts, services: { ...entry.services, 'new-service': now.services['new-service']! } }
    expect(termsProblems('f', '2', added, now)).toEqual([])
  })

  test('a service missing from the current entry fails and says to add it', () => {
    const now = termsSv(sv, withNew(SERVICES))
    const [problem, ...rest] = termsProblems('f', '2', entry, now)
    expect(rest).toEqual([])
    expect(problem).toContain('"new-service" is not in entry "2"')
    expect(problem).toContain(`add "new-service": "${now.services['new-service']}"`)
    expect(problem).toContain('no bump')
  })

  test("a changed service's hash fails and says to raise CONSENT_VERSION", () => {
    const svc = structuredClone(SERVICES) as Record<string, Json>
    svc['google-maps']!.description_sv += ' x'
    const [problem, ...rest] = termsProblems('f', '2', entry, termsSv(sv, svc))
    expect(rest).toEqual([])
    expect(problem).toContain('"google-maps" changed')
    expect(problem).toContain('Raise CONSENT_VERSION')
  })

  test('changed texts fail and say to raise CONSENT_VERSION', () => {
    const copy = structuredClone(sv)
    copy.consent.decline += ' x'
    const [problem, ...rest] = termsProblems('f', '2', entry, termsSv(copy, SERVICES))
    expect(rest).toEqual([])
    expect(problem).toContain('wording changed')
    expect(problem).toContain('Raise CONSENT_VERSION')
  })

  test('a service removed from the registry needs no bump', () => {
    const { elfsight: _, ...fewer } = SERVICES
    expect(termsProblems('f', '2', entry, termsSv(sv, fewer))).toEqual([])
  })
})

describe('what the Swedish hashes cover', () => {
  test('excluded keys do not change them', () => {
    const copy = structuredClone(sv)
    copy.embed.show = 'changed'
    copy.notice.body = 'changed'
    const svc = structuredClone(SERVICES) as Record<string, Json>
    svc['google-calendar']!.description_en += ' x'
    svc['google-calendar']!.name_en += ' x'
    svc['google-calendar']!.match.push('x')
    expect(termsSv(copy, svc)).toEqual(currentSv)
  })

  test('included keys change them', () => {
    for (const key of ['category', 'vendor', 'description_sv']) {
      const svc = structuredClone(SERVICES) as Record<string, Json>
      svc['google-maps']![key] += ' x'
      expect(termsSv(sv, svc).services['google-maps'], key).not.toBe(currentSv.services['google-maps'])
    }
  })
})

describe('what the English hashes cover', () => {
  test('included keys change them', () => {
    const copy = structuredClone(TEXTS.en) as Json
    copy.consent.decline += ' x'
    expect(termsEn(copy, SERVICES).texts).not.toBe(currentEn.texts)
    for (const key of ['category', 'vendor', 'description_en', 'name_en']) {
      const svc = structuredClone(SERVICES) as Record<string, Json>
      svc['google-calendar']![key] += ' x'
      expect(termsEn(TEXTS.en, svc).services['google-calendar'], key).not.toBe(currentEn.services['google-calendar'])
    }
  })

  test('a base (Swedish) name change does not change them', () => {
    const svc = structuredClone(SERVICES) as Record<string, Json>
    svc['google-calendar']!.name += ' x'
    expect(termsEn(TEXTS.en, svc)).toEqual(currentEn)
  })

  test('excluded keys do not change them', () => {
    const copy = structuredClone(TEXTS.en) as Json
    copy.notice.body = 'changed'
    copy.embed.show = 'changed'
    expect(termsEn(copy, SERVICES)).toEqual(currentEn)
  })
})
