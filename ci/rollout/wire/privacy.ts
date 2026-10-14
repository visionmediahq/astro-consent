// Wires src/data/privacy.json: every service the site embeds (`report.services`: iframes, widgets;
// none for a notice site), and `policy_url` as an absolute URL on the site's primary domain
// (Ruling 3: report.domains[0]) when detect found a policy page. An existing file is left alone,
// unless it lacks one of the services: the build would fail on it then (fails closed, but late),
// so it is a refusal here.
import type { Report } from '../types'
import type { Planner } from './engine'

export const PRIVACY_JSON = 'src/data/privacy.json'

/** The services an existing privacy.json lists, or null when it is not JSON. */
function listed(text: string): string[] | null {
  try {
    const json: unknown = JSON.parse(text)
    const services = (json as { services?: unknown } | null)?.services
    return Array.isArray(services) ? services.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return null
  }
}

export function wirePrivacy(planner: Planner, report: Report): void {
  if (planner.files.exists(PRIVACY_JSON)) {
    const have = listed(planner.files.read(PRIVACY_JSON))
    if (have === null) {
      planner.refuse(PRIVACY_JSON, 'privacy.json', 'privacy.json exists and is not valid JSON')
      return
    }
    const missing = report.services.filter((s) => !have.includes(s))
    for (const slug of missing) planner.refuse(PRIVACY_JSON, 'privacy.json', `privacy.json exists without ${slug}`)
    if (missing.length > 0) return
  }
  const json: { services: string[]; policy_url?: string } = { services: [...report.services] }
  if (report.policyPage !== null) {
    const domain = report.domains[0]
    if (!domain) {
      planner.refuse(PRIVACY_JSON, 'privacy.json', `no domain for policy_url (policy page ${report.policyPage})`)
      return
    }
    json.policy_url = `https://${domain}${report.policyPage}`
  }
  planner.newFile('privacy.json', PRIVACY_JSON, `${JSON.stringify(json, null, 2)}\n`)
}
