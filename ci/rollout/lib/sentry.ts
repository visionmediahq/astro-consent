// Sentry's browser bundle, which the client sites load for GlitchTip error reporting (#93): the
// pinned copy the rollout self-hosts, and the two CDNs it replaces. No node built-ins, so detect,
// wire and the browser checks share it.

/**
 * The newest 8.x release (8.55.2, 2026-04-28; npm view @sentry/browser versions). The sites load
 * major 8: 8.55.0 or 8.55.2 from Sentry's CDN, or jsDelivr's `@8`, which would have resolved to the
 * newest 8.x had it served a bundle at all. A patch release of the same API, so `Sentry.init({ dsn,
 * tracesSampleRate })` in the layouts works unchanged.
 */
export const SENTRY_VERSION = '8.55.2'

/**
 * The SRI hash Sentry publishes for this file: getsentry/sentry-release-registry,
 * packages/npm/@sentry/browser/8.55.2.json, files["bundle.min.js"].checksums["sha384-base64"]
 * (the integrity attribute Sentry's own install docs give, and three client sites already carry).
 * wire refuses a download that does not hash to it.
 */
export const SENTRY_SRI = 'sha384-lNMClDekFF9oPvouGJqnUSKioEadbe8byR7uGUA0sPP+g9r2x3eiErEJmm/Em+wB'

/** Where wire fetches it, once, at wire time. */
export const SENTRY_CDN_FILE = `https://browser.sentry-cdn.com/${SENTRY_VERSION}/bundle.min.js`

/** Where the site keeps it, and the src its layout loads it by. */
export const SENTRY_FILE = `public/js/sentry-${SENTRY_VERSION}.min.js`
export const SENTRY_SRC = `/js/sentry-${SENTRY_VERSION}.min.js`

export type SentryCdn = 'jsdelivr' | 'sentry-cdn'

/**
 * Which CDN `url` loads Sentry from: any `*.sentry-cdn.com` (the bundle host, and the Loader
 * script's js.sentry-cdn.com), or jsDelivr's `/npm/@sentry/…`. null for anything else, a URL
 * without a scheme or `//` included.
 */
export function sentryCdnOf(url: string): SentryCdn | null {
  let parsed: URL
  try {
    parsed = new URL(url.startsWith('//') ? `https:${url}` : url)
  } catch {
    return null
  }
  if (!/^https?:$/.test(parsed.protocol)) return null
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '')
  if (host === 'sentry-cdn.com' || host.endsWith('.sentry-cdn.com')) return 'sentry-cdn'
  if (host === 'cdn.jsdelivr.net' && parsed.pathname.toLowerCase().startsWith('/npm/@sentry/')) return 'jsdelivr'
  return null
}

/**
 * A mention of either CDN with a path after the host, in any text: a load or a URL that may become
 * one. A bare origin (`https://browser.sentry-cdn.com` in a CSP) is not one.
 */
export const SENTRY_CDN_MENTION = /(?:[\w-]+\.)*sentry-cdn\.com\/[\w.$@{-]|cdn\.jsdelivr\.net\/npm\/@sentry\//gi

/** The first line of Sentry's own bundles (`/*! @sentry/browser 8.55.0 (…) | https://github.com/…`). */
export const SENTRY_BUNDLE_HEADER = /^\/\*!\s*@sentry\//

/** The two bundle URLs wire replaces; group 1 the major, group 2 the rest of the version. */
const BUNDLES: { cdn: SentryCdn; re: RegExp }[] = [
  { cdn: 'sentry-cdn', re: /^https:\/\/browser\.sentry-cdn\.com\/(\d+)((?:\.\d+){2})\/bundle\.min\.js$/ },
  { cdn: 'jsdelivr', re: /^https:\/\/cdn\.jsdelivr\.net\/npm\/@sentry\/browser@(\d+)((?:\.\d+){0,2})\/build\/bundle\.min\.js$/ },
]
const MAJOR = SENTRY_VERSION.split('.')[0]!

/** Whether `url` is a bundle wire replaces (the plain major-8 `bundle.min.js` of either CDN); otherwise why not. */
export function judgeBundleUrl(url: string): { ok: true; cdn: SentryCdn; version: string } | { ok: false; why: string } {
  for (const b of BUNDLES) {
    const m = b.re.exec(url)
    if (!m) continue
    if (m[1] !== MAJOR) return { ok: false, why: `loads Sentry major ${m[1]} (${url}): the tool self-hosts ${SENTRY_VERSION} only` }
    return { ok: true, cdn: b.cdn, version: `${m[1]}${m[2]}` }
  }
  return { ok: false, why: `loads ${url}: not the plain major-${MAJOR} bundle.min.js the tool self-hosts` }
}

/**
 * Whether `url` is a bundle wire self-hosts. detectScripts leaves it to detectSentry (a load in an
 * .astro file is a loader, anywhere else a reason); every other Sentry CDN URL is a script host.
 */
export const isSelfHostableBundle = (url: string): boolean => judgeBundleUrl(url.trim()).ok
