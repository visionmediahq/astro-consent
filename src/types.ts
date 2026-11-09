// Shared config types. Kept free of Node imports: the browser runtime, and any site that imports
// the script API, type-checks this file.
import type { Category, ServiceSlug } from './services'

/** The shape of a site's src/data/privacy.json. */
export interface PrivacyConfig {
  services: ServiceSlug[]
  policy_url?: string
  log_endpoint?: string
  /** Who is responsible for the site's personal data (GDPR art. 13.1 a), shown by ConsentPolicy (#89). */
  controller?: Controller
}

export interface Controller {
  name: string
  email: string
  org_number?: string
}

/** What the virtual module `virtual:astro-consent/config` exports. */
export interface ConsentConfig {
  services: ServiceSlug[]
  categories: Category[]
  consentVersion: string
  policyUrl: string | null
  logEndpoint: string | null
  /** From privacy.json's `controller`; null when the site has none (ConsentPolicy warns, #89). */
  controller: Controller | null
  /** Hostname of the Astro `site`, e.g. "kund.se". */
  site: string | null
}
