// Node-free: components import this. Never import src/config.ts here.
import type { Lang } from './text/lang'
import type { ConsentConfig } from './types'

/** The privacy policy URL for a banner language: the Swedish one is `policy_url`, English prefers
 *  `policy_urls.en` and falls back to `policy_url` (a Swedish policy beats no link). */
export function policyUrlFor(config: Pick<ConsentConfig, 'policyUrl' | 'policyUrls'>, lang: Lang): string | null {
  return lang === 'sv' ? config.policyUrl : (config.policyUrls[lang] ?? config.policyUrl)
}
