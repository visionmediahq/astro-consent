// Shared config types. Kept free of Node imports: the browser runtime, and any site that imports
// the script API, type-checks this file.
import type { Category, ServiceSlug } from './services'

/** The shape of a site's src/data/privacy.json. */
export interface PrivacyConfig {
  services: ServiceSlug[]
  policy_url?: string
  /** Per-language privacy policy pages; English falls back to `policy_url`. */
  policy_urls?: { en?: string }
  log_endpoint?: string
}

/** What the virtual module `virtual:astro-consent/config` exports. */
export interface ConsentConfig {
  services: ServiceSlug[]
  categories: Category[]
  consentVersion: string
  policyUrl: string | null
  policyUrls: { en?: string }
  logEndpoint: string | null
  /** Hostname of the Astro `site`, e.g. "kund.se". */
  site: string | null
}
