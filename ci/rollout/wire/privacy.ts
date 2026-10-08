// Wires src/data/privacy.json: the registry services the site's embeds use (none for a notice
// site), and `policy_url` as an absolute URL on the site's primary domain (Ruling 3:
// report.domains[0]) when detect found a policy page. An existing file is left alone.
import type { Report } from '../types'
import type { Planner } from './engine'

export const PRIVACY_JSON = 'src/data/privacy.json'

export function wirePrivacy(planner: Planner, report: Report): void {
  const services = [
    ...new Set(report.iframes.flatMap((i) => (i.srcKind !== 'unresolved' && i.service !== null ? [i.service] : []))),
  ].sort()
  const json: { services: string[]; policy_url?: string } = { services }
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
