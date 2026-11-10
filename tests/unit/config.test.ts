import { describe, expect, test } from 'vitest'
import { ConfigError, consentVersion, parsePrivacyConfig, toConsentConfig, toPolicyConfig } from '../../src/config'

function fieldOf(raw: unknown): string {
  try {
    parsePrivacyConfig(raw)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as ConfigError).field
  }
  throw new Error('expected parsePrivacyConfig to throw')
}

describe('parsePrivacyConfig', () => {
  test('parsePrivacyConfig accepts the minimal config', () => {
    expect(parsePrivacyConfig({ services: [] })).toEqual({ services: [] })
  })

  test('parsePrivacyConfig accepts services, policy_url and log_endpoint', () => {
    const raw = {
      services: ['google-maps', 'google-analytics'],
      policy_url: 'https://kund.se/integritet',
      log_endpoint: 'https://log.kund.se/consent',
    }
    expect(parsePrivacyConfig(raw)).toEqual(raw)
  })

  test('parsePrivacyConfig accepts null for optional fields', () => {
    expect(parsePrivacyConfig({ services: [], policy_url: null, log_endpoint: null })).toEqual({ services: [] })
  })

  test('parsePrivacyConfig rejects an unknown service slug', () => {
    expect(fieldOf({ services: ['not-a-service'] })).toBe('services')
  })

  test('parsePrivacyConfig rejects duplicate services', () => {
    expect(fieldOf({ services: ['google-maps', 'google-maps'] })).toBe('services')
  })

  test('parsePrivacyConfig rejects a non-URL policy_url', () => {
    expect(fieldOf({ services: [], policy_url: 'integritet' })).toBe('policy_url')
  })

  // Review of #144: zod 4.3.6's z.url accepts these where 4.6.5 rejects them; config.ts says it itself.
  test('parsePrivacyConfig rejects a policy_url or log_endpoint without // after the scheme', () => {
    for (const url of ['https:/kund.se/integritet', 'https:kund.se', 'http:/kund.se']) expect(fieldOf({ services: [], policy_url: url }), url).toBe('policy_url')
    for (const url of ['https:/log.kund.se', 'https:log.kund.se']) expect(fieldOf({ services: [], log_endpoint: url }), url).toBe('log_endpoint')
  })

  // #89: who is responsible (GDPR art. 13.1 a), for ConsentPolicy.
  test('parsePrivacyConfig accepts a controller with name and email, org_number optional', () => {
    const controller = { name: 'Kund AB', email: 'info@kund.se', org_number: '556677-8899' }
    expect(parsePrivacyConfig({ services: [], controller })).toEqual({ services: [], controller })
    expect(parsePrivacyConfig({ services: [], controller: { name: 'Kund AB', email: 'info@kund.se' } }).controller).toEqual({ name: 'Kund AB', email: 'info@kund.se' })
  })

  test('parsePrivacyConfig accepts a controller address, and null for controller and processor', () => {
    const controller = { name: 'Kund AB', email: 'info@kund.se', address: 'Storgatan 1, 652 24 Karlstad' }
    expect(parsePrivacyConfig({ services: [], controller }).controller).toEqual(controller)
    expect(parsePrivacyConfig({ services: [], controller: null, processor: null })).toEqual({ services: [] })
  })

  // Review of #145: the field is named down to the key, so the technician knows which one is wrong.
  test('parsePrivacyConfig rejects a controller without a name or a valid email, naming the field', () => {
    expect(fieldOf({ services: [], controller: { email: 'info@kund.se' } })).toBe('controller.name')
    expect(fieldOf({ services: [], controller: { name: '', email: 'info@kund.se' } })).toBe('controller.name')
    expect(fieldOf({ services: [], controller: { name: 'Kund AB' } })).toBe('controller.email')
    expect(fieldOf({ services: [], controller: { name: 'Kund AB', email: 'inte-en-adress' } })).toBe('controller.email')
    expect(fieldOf({ services: [], controller: 'Kund AB' })).toBe('controller')
    // An unknown key inside it is named with its place.
    expect(fieldOf({ services: [], controller: { name: 'Kund AB', email: 'info@kund.se', phone: '1' } })).toBe('controller.phone')
  })

  test('parsePrivacyConfig accepts a Swedish org_number with or without the dash, and rejects other shapes', () => {
    for (const org_number of ['556677-8899', '5566778899'])
      expect(parsePrivacyConfig({ services: [], controller: { name: 'Kund AB', email: 'info@kund.se', org_number } }).controller?.org_number).toBe(org_number)
    for (const org_number of ['55667788-99', '556677-889', 'SE556677889901'])
      expect(fieldOf({ services: [], controller: { name: 'Kund AB', email: 'info@kund.se', org_number } }), org_number).toBe('controller.org_number')
  })

  // GDPR art. 13.1 e: the processor that runs hosting and statistics for the controller.
  test('parsePrivacyConfig accepts a processor name and rejects an empty one', () => {
    expect(parsePrivacyConfig({ services: [], processor: 'Vision Media' })).toEqual({ services: [], processor: 'Vision Media' })
    expect(fieldOf({ services: [], processor: ' ' })).toBe('processor')
  })

  test('parsePrivacyConfig rejects a javascript: policy_url', () => {
    expect(fieldOf({ services: [], policy_url: 'javascript:alert(1)' })).toBe('policy_url')
  })

  test('parsePrivacyConfig rejects a non-https log_endpoint', () => {
    expect(fieldOf({ services: [], log_endpoint: 'http://log.example' })).toBe('log_endpoint')
  })

  test('parsePrivacyConfig rejects unknown keys and names the key', () => {
    expect(fieldOf({ services: [], has_banner: true })).toBe('has_banner')
  })

  test('parsePrivacyConfig rejects a non-object', () => {
    expect(fieldOf([])).toBe('privacy.json')
  })
})

describe('consentVersion', () => {
  test('consentVersion is stable for the same services in any order', () => {
    expect(consentVersion(['google-maps', 'google-analytics'])).toBe(consentVersion(['google-analytics', 'google-maps']))
  })

  test('consentVersion has the form <int>:<6 hex>', () => {
    expect(consentVersion(['google-maps'])).toMatch(/^\d+:[0-9a-f]{6}$/)
  })

  test('consentVersion changes with the services list and with the version number', () => {
    expect(consentVersion([])).not.toBe(consentVersion(['google-maps']))
    expect(consentVersion([], 1)).not.toBe(consentVersion([], 2))
  })
})

describe('toConsentConfig', () => {
  test('toConsentConfig derives categories in fixed order and always includes necessary', () => {
    const config = toConsentConfig({ services: ['meta-pixel', 'google-maps'] }, 'https://kund.se')
    expect(config.categories).toEqual(['necessary', 'external', 'marketing'])
    expect(toConsentConfig({ services: [] }, undefined).categories).toEqual(['necessary'])
  })

  test('toConsentConfig maps optional fields to null', () => {
    const config = toConsentConfig({ services: [] }, 'https://kund.se')
    expect(config.policyUrl).toBeNull()
    expect(config.logEndpoint).toBeNull()
  })

  // Review of #145: the controller is for the policy page; the browser runtime has no use for it.
  test('toConsentConfig leaves controller and processor out; toPolicyConfig carries them, null when unset', () => {
    const privacy = { services: [], controller: { name: 'Kund AB', email: 'info@kund.se' }, processor: 'Vision Media' }
    expect(JSON.stringify(toConsentConfig(privacy, 'https://kund.se'))).not.toMatch(/Kund AB|info@kund|Vision Media/)
    expect(toPolicyConfig(privacy)).toEqual({ controller: privacy.controller, processor: 'Vision Media' })
    expect(toPolicyConfig({ services: [] })).toEqual({ controller: null, processor: null })
  })

  test('toConsentConfig reduces site to its hostname', () => {
    expect(toConsentConfig({ services: [] }, 'https://www.kund.se/').site).toBe('www.kund.se')
    expect(toConsentConfig({ services: [] }, undefined).site).toBeNull()
  })
})
