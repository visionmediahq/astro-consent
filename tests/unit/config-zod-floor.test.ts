// #17: package.json asks for zod `^4.3.6`, the floor Astro 6 itself depends on, so installing the
// package reuses the zod a site already has. This runs the privacy.json schema against exactly that
// floor (`zod-floor`, a devDependency alias for zod@4.3.6): if src/config.ts starts using something
// newer, this fails and the floor in package.json must move up with it.
import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'

vi.mock('zod', async () => ({ ...(await import('zod-floor')), FLOOR: true }))

const { ConfigError, parsePrivacyConfig } = await import('../../src/config')

const json = (path: string): Record<string, any> => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))

test('the floor copy is the version package.json names, and config.ts gets it', async () => {
  const floor = String(json('../../package.json').dependencies.zod).replace(/^\^/, '')
  expect(json('../../node_modules/zod-floor/package.json').version).toBe(floor)
  expect((await import('zod')) as unknown as { FLOOR?: boolean }).toHaveProperty('FLOOR', true)
})

test('the schema accepts a full config and rejects bad values on the floor zod', () => {
  const raw = { services: ['google-maps'], policy_url: 'https://kund.se/integritet', log_endpoint: 'https://log.kund.se/consent' }
  expect(parsePrivacyConfig(raw)).toEqual(raw)
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
})
