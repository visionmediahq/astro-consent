// Node only: uses node:crypto and zod. Browser code may import from this file with `import type` only.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CATEGORIES, SERVICES, SERVICE_SLUGS, type ServiceSlug } from './services'
import type { ConsentConfig, PrivacyConfig } from './types'

export type { ConsentConfig, PrivacyConfig } from './types'

/** Raise when the banner or category wording changes, or a service's category, vendor or purpose changes:
 *  every visitor is asked again. tests/unit/consent-terms.test.ts enforces it. */
export const CONSENT_VERSION = 1

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
  policy_url: z.url({ protocol: /^https?$/ }).nullable().optional(),
  log_endpoint: z.url({ protocol: /^https$/ }).nullable().optional(),
})

export function parsePrivacyConfig(raw: unknown): PrivacyConfig {
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]!
    // zod 4 reports an unknown key in `keys`, with an empty path.
    const field =
      issue.code === 'unrecognized_keys'
        ? issue.keys[0]!
        : issue.path.length > 0
          ? String(issue.path[0])
          : 'privacy.json'
    throw new ConfigError(field, issue.message)
  }
  const config: PrivacyConfig = { services: result.data.services }
  if (result.data.policy_url) config.policy_url = result.data.policy_url
  if (result.data.log_endpoint) config.log_endpoint = result.data.log_endpoint
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
