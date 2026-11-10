// #17: package.json asks for zod `^4.3.6`, the floor Astro 6 itself depends on, so installing the
// package reuses the zod a site already has. This runs the privacy.json schema against exactly that
// floor (`zod-floor`, a devDependency alias for zod@4.3.6): if src/config.ts starts using something
// newer, this fails and the floor in package.json must move up with it.
import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'

// Every builder config.ts takes from `z` is recorded: proof that its schema is built by the floor copy.
const floor = vi.hoisted(() => ({ used: new Set<string>() }))
vi.mock('zod', async () => {
  const m = await import('zod-floor')
  const z = new Proxy(m.z, { get: (t, k, r) => (floor.used.add(String(k)), Reflect.get(t, k, r)) })
  return { ...m, z, FLOOR: true }
})

const { ConfigError, parsePrivacyConfig } = await import('../../src/config')

const json = (path: string): Record<string, any> => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))

test('the floor copy is the version package.json names, and config.ts gets it', async () => {
  const range = String(json('../../package.json').dependencies.zod).replace(/^\^/, '')
  expect(json('../../node_modules/zod-floor/package.json').version).toBe(range)
  expect((await import('zod')) as unknown as { FLOOR?: boolean }).toHaveProperty('FLOOR', true)
  // config.ts built its schema on import, with the floor copy's builders.
  for (const builder of ['strictObject', 'array', 'enum', 'url']) expect(floor.used, builder).toContain(builder)
})

test('the schema accepts a full config and rejects bad values on the floor zod', () => {
  const raw = { services: ['google-maps'], policy_url: 'https://kund.se/integritet', log_endpoint: 'https://log.kund.se/consent' }
  expect(parsePrivacyConfig(raw)).toEqual(raw)
  // #89 (review of #145): the policy fields parse on the floor too.
  const policy = { services: [], controller: { name: 'Kund AB', email: 'info@kund.se', org_number: '556677-8899', address: 'Storgatan 1' }, processor: 'Vision Media' }
  expect(parsePrivacyConfig(policy)).toEqual(policy)
  expect(parsePrivacyConfig({ services: [], policy_url: null })).toEqual({ services: [] })
  const field = (value: unknown): string => {
    try {
      parsePrivacyConfig(value)
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      return (error as InstanceType<typeof ConfigError>).field
    }
    return '(accepted)'
  }
  expect(field({ services: ['not-a-service'] })).toBe('services')
  expect(field({ services: [], policy_url: 'javascript:alert(1)' })).toBe('policy_url')
  expect(field({ services: [], log_endpoint: 'http://log.example' })).toBe('log_endpoint')
  expect(field({ services: [], has_banner: true })).toBe('has_banner')
  expect(field({ services: [], controller: { name: 'Kund AB', email: 'inte-en-adress' } })).toBe('controller.email')
  expect(field({ services: [], controller: { name: 'Kund AB', email: 'info@kund.se', org_number: '1' } })).toBe('controller.org_number')
  // Review of #144: 4.3.6's z.url alone accepts these; config.ts refuses them on every version.
  expect(field({ services: [], policy_url: 'https:/kund.se/integritet' })).toBe('policy_url')
  expect(field({ services: [], log_endpoint: 'https:log.kund.se' })).toBe('log_endpoint')
})
