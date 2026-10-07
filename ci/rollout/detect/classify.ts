// Classifies a site from what detect found: `notice`, `maps` or `needs-human` with one reason per
// line. The wire stage converts only `notice` and `maps`, so every doubt is a reason: an unknown
// counts as a problem, never as "probably fine".
import type { Classification, IframeInfo, Report } from '../types'

/** Everything detect found, plus what classify needs that the report does not keep. */
export type Findings = Omit<Report, 'classification' | 'reasons'> & {
  /** From every detector; the same file may appear more than once. */
  parseErrors: { file: string; message: string }[]
  aliasImports: { file: string; specifier: string }[]
  multiFooterPages: { page: string; footers: number }[]
}

/** The Astro majors the package's peerDependencies accept. */
const ASTRO_MAJORS = [6, 7]

/** A src the browser resolves against the page: no scheme, not protocol-relative. */
const isRelative = (src: string): boolean => {
  const t = src.trim()
  return t !== '' && !t.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(t)
}

function iframeReason(frame: IframeInfo, domains: string[]): string | null {
  // Keyed on srcKind only: for an unresolved src, host and service are hints and decide nothing.
  if (frame.srcKind === 'unresolved') return `unresolved iframe src in ${frame.file}`
  const host = frame.host
  if (host === null) {
    const srcs = frame.src !== null ? [frame.src] : (frame.callSites ?? []).map((c) => c.src)
    const own = srcs.length > 0 && srcs.every((s) => s !== null && isRelative(s))
    return own ? null : `unknown iframe host in ${frame.file}`
  }
  const own = domains.some((d) => host === d.toLowerCase() || host === `www.${d.toLowerCase()}`)
  if (frame.service === null) return own ? null : `unregistered iframe host ${host}`
  if (frame.service === 'google-maps') return null
  return `iframe service ${frame.service} is not wired by this batch`
}

export function classify(f: Findings): { classification: Classification; reasons: string[] } {
  const reasons: string[] = []
  const add = (r: string): void => {
    if (!reasons.includes(r)) reasons.push(r)
  }

  const seenParse = new Set<string>()
  for (const e of f.parseErrors) {
    if (seenParse.has(e.file)) continue
    seenParse.add(e.file)
    add(`parse error in ${e.file}: ${e.message}`)
  }
  for (const a of f.aliasImports) add(`imports through path aliases are not followed: ${a.specifier}`)

  const unknown = [
    ...(f.astro.major === 0 ? ['astro'] : []),
    ...(f.css.tailwindMajor === null ? ['tailwindcss'] : []),
    ...(f.css.daisyuiMajor === null ? ['daisyui'] : []),
  ]
  if (unknown.length > 0) add(`unknown versions: ${unknown.join(', ')}`)
  if (f.astro.major !== 0 && !ASTRO_MAJORS.includes(f.astro.major)) add(`astro ${f.astro.major}: the package supports Astro 6 and 7`)
  if (f.css.tailwindMajor !== null && f.css.tailwindMajor < 4) add(`tailwind ${f.css.tailwindMajor}: @source needs Tailwind 4`)
  if (f.css.daisyuiMajor !== null && f.css.daisyuiMajor < 5) add(`daisyui ${f.css.daisyuiMajor}: the components need daisyUI 5`)

  if (f.config.path === '') add('no astro.config file')
  else if (!f.config.hasIntegrations && !f.config.isDefineConfigObject) {
    add(`config shape: ${f.config.path} has no integrations and is not defineConfig({…})`)
  }
  if (f.css.entry === null) add('no CSS entry with @import "tailwindcss"')

  const used = f.layouts.filter((l) => l.pages.length > 0)
  if (used.length === 0) add('no layout renders <html>/<body> for any page')
  else if (used.length > 1) add(`several layouts and no single shared one: ${used.map((l) => l.file).join(', ')}`)
  for (const m of f.multiFooterPages) add(`footer ambiguous: ${m.page} renders ${m.footers} footers`)

  for (const frame of f.iframes) {
    const r = iframeReason(frame, f.domains)
    if (r !== null) add(r)
  }
  for (const t of f.trackers) add(`tracker ${t}: the batch wires notice and maps only`)
  for (const b of f.banners) add(`existing banner: ${b}`)

  if (reasons.length > 0) return { classification: 'needs-human', reasons }
  const maps = f.iframes.some((i) => i.srcKind !== 'unresolved' && i.service === 'google-maps')
  return { classification: maps ? 'maps' : 'notice', reasons }
}
