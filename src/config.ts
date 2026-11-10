// Node only: uses node:crypto and zod. Browser code may import from this file with `import type` only.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CATEGORIES, SERVICES, SERVICE_SLUGS, type ServiceSlug } from './services'
import type { ConsentConfig, PolicyConfig, PrivacyConfig } from './types'

export type { ConsentConfig, PolicyConfig, PrivacyConfig } from './types'

/** Raise when the banner or category wording changes, or a service's category, vendor or purpose changes:
 *  every visitor is asked again. tests/unit/consent-terms.test.ts enforces it. */
export const CONSENT_VERSION = 2

export class ConfigError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message)
    this.name = 'ConfigError'
  }
}

const schema = z.strictObject({
  services: z
    .array(z.enum(SERVICE_SLUGS as [ServiceSlug, ...ServiceSlug[]]))
    .refine((list) => new Set(list).size === list.length, 'duplicate service'),
  // `//` after the scheme is checked here, not left to z.url: zod 4.3.6 (the floor, #17) accepts
  // `https:/kund.se` and `https:kund.se`, which 4.6 rejects.
  policy_url: z
    .url({ protocol: /^https?$/ })
    .refine((url) => /^https?:\/\/[^/]/i.test(url), 'must start with http:// or https://')
    .nullable()
    .optional(),
  log_endpoint: z
    .url({ protocol: /^https$/ })
    .refine((url) => /^https:\/\/[^/]/i.test(url), 'must start with https://')
    .nullable()
    .optional(),
  // #89: who is responsible and how to reach them, for ConsentPolicy (GDPR art. 13.1 a).
  controller: z
    .strictObject({
      name: z.string().trim().min(1),
      email: z.email(),
      // A Swedish organisationsnummer (or a sole trader's personnummer form): 10 digits, dash optional.
      org_number: z.string().trim().regex(/^\d{6}-?\d{4}$/, 'must be 10 digits, like 556677-8899').optional(),
      address: z.string().trim().min(1).optional(),
    })
    .nullable()
    .optional(),
  // The processor that runs hosting and statistics for the controller (GDPR art. 13.1 e: a recipient).
  processor: z.string().trim().min(1).nullable().optional(),
})

export function parsePrivacyConfig(raw: unknown): PrivacyConfig {
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]!
    // Every key on the path, so a technician sees `controller.email`, not `controller` (array
    // indexes are left out: a bad slug is reported as `services`). zod 4 reports an unknown key in
    // `keys`, with the path of the object holding it.
    const path = (issue.code === 'unrecognized_keys' ? [...issue.path, issue.keys[0]!] : issue.path).filter((key) => typeof key === 'string')
    const field = path.length > 0 ? path.join('.') : 'privacy.json'
    throw new ConfigError(field, issue.message)
  }
  const config: PrivacyConfig = { services: result.data.services }
  if (result.data.policy_url) config.policy_url = result.data.policy_url
  if (result.data.log_endpoint) config.log_endpoint = result.data.log_endpoint
  if (result.data.controller) config.controller = result.data.controller
  if (result.data.processor) config.processor = result.data.processor
  return config
}

export function consentVersion(services: ServiceSlug[], version: number = CONSENT_VERSION): string {
  const hash = createHash('sha256')
    .update([...services].sort().join(','))
    .digest('hex')
  return `${version}:${hash.slice(0, 6)}`
}

export function toConsentConfig(privacy: PrivacyConfig, site: string | undefined): ConsentConfig {
  const used = CATEGORIES.filter(
    (category) => category !== 'necessary' && privacy.services.some((slug) => SERVICES[slug].category === category),
  )
  return {
    services: privacy.services,
    categories: ['necessary', ...used],
    consentVersion: consentVersion(privacy.services),
    policyUrl: privacy.policy_url ?? null,
    logEndpoint: privacy.log_endpoint ?? null,
    site: site ? new URL(site).hostname : null,
  }
}

/** What ConsentPolicy needs beyond ConsentConfig, served by its own virtual module so it stays out
 *  of the JavaScript every page loads (review of #145). */
export function toPolicyConfig(privacy: PrivacyConfig): PolicyConfig {
  return { controller: privacy.controller ?? null, processor: privacy.processor ?? null }
}
