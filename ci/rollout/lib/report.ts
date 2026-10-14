// Helpers over the Report shape: which services a site embeds, and loading reports stored by an
// older version of the tool.
import type { ServiceSlug } from '../../../src/services'
import type { Report } from '../types'

/**
 * The services a site embeds, sorted and unique: resolved iframes with a registered service, the
 * widgets' service, and any already wired (read from privacy.json). Unresolved iframes only hint at
 * a service and decide nothing.
 */
export function servicesOf(r: Pick<Report, 'iframes' | 'widgets'>, wired: ServiceSlug[] = []): ServiceSlug[] {
  const found = new Set<ServiceSlug>(wired)
  for (const i of r.iframes) if (i.srcKind !== 'unresolved' && i.service !== null) found.add(i.service)
  for (const w of r.widgets) found.add(w.service)
  return [...found].sort()
}

/** A stored report, current shape: `maps` is now `consent`, `widgets` and `services` may be missing. */
export function normaliseReport(raw: unknown): Report {
  const r = raw as Omit<Report, 'classification' | 'widgets' | 'services'> & {
    classification: Report['classification'] | 'maps'
    widgets?: Report['widgets']
    services?: Report['services']
  }
  const widgets = r.widgets ?? []
  return {
    ...r,
    classification: r.classification === 'maps' ? 'consent' : r.classification,
    widgets,
    services: r.services ?? servicesOf({ iframes: r.iframes, widgets }),
  }
}
