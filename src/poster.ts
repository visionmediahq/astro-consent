// Render-time check for <ConsentEmbed poster>. Node-free: imported by the component, which may run
// in any server runtime, so it imports only the registry.
import { SERVICE_SLUGS, srcMatchesService, type ServiceSlug } from './services'

/**
 * Why a poster must not render, or null. `page` is `Astro.url.pathname`, as in scanError; `poster` is
 * the URL the page will request (an imported image's `src`, or the string the site passed).
 *
 * The poster shows before consent, so a URL on a registry host (a YouTube thumbnail on i.ytimg.com,
 * a Maps static image) would send the visitor's IP there first. Judged by host, with the same rule
 * as an embed's src (#107): a path of the site's own that merely names a host passes. Any other
 * host passes too: a site's own CDN is its business.
 */
export function posterError(page: string, service: ServiceSlug, poster: string): string | null {
  let url: URL
  try {
    // Relative to a host no registry pattern can match, so a path of the site's own resolves to it.
    url = new URL(poster.trim(), 'https://poster.invalid/')
  } catch {
    return null
  }
  const owner = SERVICE_SLUGS.find((slug) => srcMatchesService(url.href, slug))
  if (!owner) return null
  return (
    `[astro-consent] ${page}: <ConsentEmbed service="${service}"> poster "${poster}" is on ${url.host}, ` +
    `which is ${owner}'s: the placeholder would request it before consent. Use an image file of the site's own.`
  )
}
