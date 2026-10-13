// Render-time checks for <ConsentWidget>. Node-free: imported by the component, which may run in
// any server runtime, so it imports only the registry.
import { SERVICES, SERVICE_SLUGS, type ServiceSlug } from './services'

// Unlike matchesRegistry, a script URL must be on the service's own host: a bare-host pattern
// matches the hostname or a subdomain of it, never a substring of the path or a longer host.
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
 * origin + path, never the query), and the slot must hold no <script>: one there would run before
 * consent.
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
  if (/<script\b/i.test(markup)) {
    return `${where}: no <script> in the slot, it would run before consent. Pass the provider's script URL as the script prop.`
  }
  return null
}
