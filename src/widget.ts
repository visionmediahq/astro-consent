// Render-time checks for <ConsentWidget>. Node-free: imported by the component, which may run in
// any server runtime, so it imports only the registry.
import { SERVICES, SERVICE_SLUGS, type ServiceSlug } from './services'

// Stricter than matchesRegistry for bare-host patterns: one matches the URL's hostname or a
// subdomain of it, never a substring of the path or a longer host (a pattern ending in '.' matches
// a hostname starting with it, or any label starting with it). A path pattern (containing '/') is
// still a substring match on origin + path, as in matchesRegistry; the query is never looked at.
function scriptOwner(url: URL): ServiceSlug | null {
  const host = url.hostname.toLowerCase()
  const full = (url.origin + url.pathname).toLowerCase()
  const onHost = (p: string) =>
    p.endsWith('.') ? host.startsWith(p) || host.includes('.' + p) : host === p || host.endsWith('.' + p)
  return SERVICE_SLUGS.find((slug) => SERVICES[slug].match.some((p) => (p.includes('/') ? full.includes(p) : onHost(p)))) ?? null
}

/**
 * Why a widget must not render, or null. `page` is `Astro.url.pathname`, as in scanError.
 * The script must be an absolute https URL that the registry attributes to `service` (judged on
 * origin + path, never the query), and the slot must hold markup (an empty one would activate into
 * nothing) and no <script>: one there would run before consent.
 */
export function widgetError(page: string, service: ServiceSlug, script: string, markup: string): string | null {
  const where = `[astro-consent] ${page}: <ConsentWidget service="${service}">`
  let url: URL
  try {
    url = new URL(script)
  } catch {
    return `${where}: script "${script}" is not an absolute URL.`
  }
  if (url.protocol !== 'https:') return `${where}: script must use https:, got "${script}".`
  const owner = scriptOwner(url)
  if (owner !== service) {
    return `${where}: script "${script}" does not belong to ${service} (it matches ${owner ?? 'no service'}).`
  }
  if (markup.trim() === '') {
    return `${where}: empty slot. Put the provider's inert markup (the element its script fills) inside the component.`
  }
  if (/<script\b/i.test(markup)) {
    return `${where}: no <script> in the slot, it would run before consent. Pass the provider's script URL as the script prop.`
  }
  return null
}
