// Verify's static check of Sentry's self-hosted bundle (#93), part of step 2. verify builds without
// PUBLIC_GLITCHTIP_DSN, so the layouts' GlitchTip block does not render and no browser step can see
// where the bundle comes from. This reads the branch's source instead: with the tool's bundle
// committed, it must hash to the recorded SRI and no file may still load either CDN (detect's own
// reading, so every shape it knows and every mention it cannot place counts). Without the bundle,
// a CDN load still there is noted, not failed: `wire --no-sentry` leaves it on purpose.
import { detectSentry } from '../detect/sentry'
import { SENTRY_FILE, SENTRY_SRC, SENTRY_SRI } from '../lib/sentry'
import type { SiteFiles } from '../lib/site-files'
import { sri384 } from '../wire/sentry'

/** `bundle`: the committed SENTRY_FILE's bytes, or null when the branch does not have it; `sri` the hash it must have. */
export function checkSentrySource(files: SiteFiles, bundle: Uint8Array | null, sri: string = SENTRY_SRI): { pass: boolean; lines: string[] } {
  const info = detectSentry(files)
  const loads = info.loaders.map((l) => `  ${l.file}:${l.line} ${l.url}`)
  const unsure = info.reasons.map((r) => `  ${r}`)
  if (bundle === null) {
    if (info.status === 'wire' || info.status === 'needs-human') {
      return { pass: true, lines: [`sentry bundle: not self-hosted on this branch (no ${SENTRY_FILE}), still from a CDN (noted: wire --no-sentry leaves it):`, ...loads, ...unsure] }
    }
    return { pass: true, lines: [`sentry bundle: ${info.status}${info.selfHosted.length ? ` (${info.selfHosted.join(', ')})` : ''}, nothing to check`] }
  }
  const lines: string[] = []
  const hash = sri384(bundle)
  const hashOk = hash === sri
  lines.push(`sentry bundle: ${SENTRY_FILE}, ${bundle.length} bytes, ${hashOk ? `${sri} ok` : `${hash}, NOT the recorded ${sri}`}`)
  const loaded = info.selfHosted.includes(SENTRY_SRC)
  const clean = info.status === 'self-hosted' && loaded
  if (clean) lines.push(`sentry bundle: loaded from ${SENTRY_SRC}, no CDN load left`)
  else {
    if (info.loaders.length || info.reasons.length) lines.push('sentry bundle: a CDN load is still there:', ...loads, ...unsure)
    if (!loaded) lines.push(`sentry bundle: no <script> loads ${SENTRY_SRC}`)
    const other = info.selfHosted.filter((s) => s !== SENTRY_SRC)
    if (other.length) lines.push(`sentry bundle: also loaded from ${other.join(', ')}`)
  }
  return { pass: hashOk && clean && info.selfHosted.length === 1, lines }
}
