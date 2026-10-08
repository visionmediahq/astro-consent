// Detects what a site loads or gates by script: trackers (registry services loaded by script or
// import), existing consent banners, reCAPTCHA, and astro-consent wiring that is already there.
//
// Misreading goes one way only. A false hit sends a site to a human; a miss could wire a site that
// loads a tracker before consent. So the text sweeps read whole files, comments included, and only
// leave out what is clearly not a load: JSON-LD data and links to a Facebook page.
import { type ServiceSlug, SERVICE_SLUGS, SERVICES, matchesRegistry } from '../../../src/services'
import type { Report } from '../types'
import { type AstroNode, attr, elements, parseAstro } from '../lib/astro-ast'
import { importsOf, parseModule } from '../lib/ts-ast'
import type { SiteFiles } from '../lib/site-files'

export type DetectedScripts = Pick<Report, 'trackers' | 'banners' | 'recaptcha' | 'alreadyWired'> & {
  /** `.astro` files under src/ that did not parse; their text is still swept. */
  parseErrors: { file: string; message: string }[]
}

const PACKAGE = '@visionmediahq/astro-consent'

const BINARY = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|svg|woff2?|ttf|otf|eot|pdf|mp[34]|webm|ogg|wav|mov|zip|gz)$/i

/**
 * Maps patterns that ordinary links match too: a "Hitta hit" link, JSON-LD `hasMap`, an embed
 * iframe. They are left out of the text sweep; map iframes are detectIframes' job.
 */
const LINK_LIKE = new Set(['google.com/maps', 'maps.google.'])

/**
 * Registry patterns that are a bare host (no path): safe to find anywhere in text. Path patterns
 * (`facebook.com/tr`) are only matched on parsed URLs, where a page link such as
 * `facebook.com/traforadling` can be told apart. The Maps API hosts (`maps.googleapis.com`,
 * `maps.gstatic.com`, `places.googleapis.com`) are kept: outside an iframe they are loads the batch
 * does not wire (a Static Maps image, the JavaScript API, its fonts and tiles).
 */
const HOST_PATTERNS: [string, ServiceSlug][] = SERVICE_SLUGS.flatMap((slug) =>
  SERVICES[slug].match.filter((p) => !p.includes('/') && !LINK_LIKE.has(p)).map((p): [string, ServiceSlug] => [p, slug]),
)

/** Opening <iframe> tags, where a map embed's src lives: not a tracker, detectIframes reports it. */
const IFRAME_TAG = /<iframe\b[^>]*>/gi

/** Calls that only a tracker snippet makes. */
const CALLS: [RegExp, ServiceSlug][] = [
  [/\bgtag\s*\(/, 'google-analytics'],
  [/\bfbq\s*\(/, 'meta-pixel'],
]

/** Package or component names that load a tracker. */
const IMPORTS: [RegExp, ServiceSlug][] = [
  [/google[-_]?analytics|gtag|(?:^|[^a-z])gtm(?:[^a-z]|$)|tag[-_]?manager/i, 'google-analytics'],
  [/google[-_]?ads|adsense/i, 'google-ads'],
  [/(?:facebook|meta)[-_]?pixel/i, 'meta-pixel'],
]

/** Package names that load Google Maps. Not matched on relative imports: `./GoogleMaps.astro` may hold an iframe. */
const MAPS_PACKAGE = /^@googlemaps\/|google[-_]?maps/i

const BANNERS: [RegExp, string][] = [
  [/cookiebot/i, 'cookiebot'],
  [/elfsight/i, 'elfsight'],
  [/cookieyes/i, 'cookieyes'],
  [/cookieconsent/i, 'cookieconsent'],
  [/onetrust|cookielaw\.org/i, 'onetrust'],
  [/usercentrics/i, 'usercentrics'],
  [/iubenda/i, 'iubenda'],
]

/** `localStorage.getItem('maps-consent')`, `sessionStorage['cookies']`: a gate's storage key. */
const STORAGE_KEY = /\b(localStorage|sessionStorage)\s*(?:\.\s*(?:getItem|setItem|removeItem)\s*\(\s*|\[\s*)(['"`])([^'"`]+)\2/g
const CONSENT_KEY = /consent|cookie|gdpr|samtyck|accept|godk/i
const COOKIE_GATE = /document\.cookie\s*=[^;\n]*(?:consent|samtyck|accept|godk)/i
/** Where a gate keeps its state, for a key held in a variable. */
const STORAGE_USE = /\b(localStorage|sessionStorage|document\.cookie)\b/
/** A quoted literal shaped like a storage key or cookie name. */
const KEY_LITERAL = /(['"`])([\w.:-]{1,64})\1/g

const RECAPTCHA = /recaptcha\/(?:api|enterprise)\.js|RECAPTCHA_SITE_KEY/

const urlsIn = (text: string): string[] => text.match(/(?:https?:)?\/\/[^\s"'<>`\\]+/gi) ?? []

/** The registry service a URL loads, with a Facebook page link (`facebook.com/<page>`) not counted. */
function serviceOfUrl(url: string): ServiceSlug | null {
  let parsed: URL
  try {
    parsed = new URL(url.startsWith('//') ? `https:${url}` : url)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname
  const slug = matchesRegistry(`${host}${path}`)
  if (slug === 'meta-pixel' && /(?:^|\.)facebook\.com$/.test(host) && !/^\/tr(?:\/|$)/.test(path)) return null
  return slug
}

/** Trackers anywhere in a text: bare registry hosts (Maps outside iframe tags), tracker calls, pixel URLs. */
function trackersInText(text: string): ServiceSlug[] {
  const lower = text.toLowerCase()
  const withoutIframes = lower.replace(IFRAME_TAG, '')
  const out: ServiceSlug[] = []
  for (const [pattern, slug] of HOST_PATTERNS) if ((slug === 'google-maps' ? withoutIframes : lower).includes(pattern)) out.push(slug)
  for (const [re, slug] of CALLS) if (re.test(text)) out.push(slug)
  for (const url of urlsIn(text)) {
    const slug = serviceOfUrl(url)
    if (slug !== null && slug !== 'google-maps') out.push(slug)
  }
  return out
}

/** Registry services a `<script>` element loads by its `src` or its inline body. JSON data is skipped. */
function trackersInScript(node: AstroNode, text: string): ServiceSlug[] {
  const type = attr(node, 'type')
  if (type?.kind === 'quoted' && /json/i.test(type.value)) return []
  const src = attr(node, 'src')
  const urls = [...(src && src.kind !== 'empty' ? [src.value, ...urlsIn(src.value)] : []), ...urlsIn(text.slice(node.start, node.end))]
  return urls.flatMap((u) => serviceOfUrl(u) ?? [])
}

function importedTrackers(specifiers: string[]): ServiceSlug[] {
  return specifiers.flatMap((from) => [
    ...IMPORTS.flatMap(([re, slug]) => (re.test(from) ? [slug] : [])),
    ...(!from.startsWith('.') && !from.startsWith('/') && MAPS_PACKAGE.test(from) ? (['google-maps'] as const) : []),
  ])
}

function packageDeps(files: SiteFiles): string[] {
  if (!files.exists('package.json')) return []
  try {
    const pkg = JSON.parse(files.read('package.json')) as Record<string, unknown>
    return ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap((k) => {
      const deps = pkg[k]
      return typeof deps === 'object' && deps !== null ? Object.keys(deps) : []
    })
  } catch {
    return []
  }
}

export function detectScripts(files: SiteFiles): DetectedScripts {
  const parseErrors: DetectedScripts['parseErrors'] = []
  const trackers = new Set<ServiceSlug>()
  const banners: string[] = []
  const addBanner = (b: string): void => {
    if (!banners.includes(b)) banners.push(b)
  }
  let recaptcha = false
  let componentsWired = false

  const deps = packageDeps(files)
  for (const slug of importedTrackers(deps)) trackers.add(slug)
  for (const [re, name] of BANNERS) if (deps.some((d) => re.test(d))) addBanner(name)

  const config = files.list('astro.config.*')[0]
  const configImports = config ? importsOf(parseModule(files.read(config))).map((i) => i.from) : []
  for (const slug of importedTrackers(configImports)) trackers.add(slug)
  if (config) for (const slug of trackersInText(files.read(config))) trackers.add(slug)

  const textFiles = [...new Set([...files.list('src/**'), ...files.list('public/**')])].filter((f) => !BINARY.test(f)).sort()
  for (const file of textFiles) {
    const text = files.read(file)
    if (text.includes('\u0000')) continue

    for (const slug of trackersInText(text)) trackers.add(slug)
    for (const [re, name] of BANNERS) if (re.test(text)) addBanner(name)
    const before = banners.length
    for (const m of text.matchAll(STORAGE_KEY)) {
      if (CONSENT_KEY.test(m[3]!)) addBanner(`home-made gate: ${m[1]} '${m[3]}' in ${file}`)
    }
    if (COOKIE_GATE.test(text)) addBanner(`home-made gate: document.cookie in ${file}`)
    // A key held in a variable (`const KEY = 'cookie-consent'; localStorage.getItem(KEY)`): any
    // consent-like literal in a file that uses storage counts.
    const storage = STORAGE_USE.exec(text)?.[1]
    if (storage && banners.length === before) {
      const literal = [...text.matchAll(KEY_LITERAL)].map((m) => m[2]!).find((k) => CONSENT_KEY.test(k))
      if (literal) addBanner(`home-made gate: ${storage} with '${literal}' in ${file}`)
    }
    if (RECAPTCHA.test(text)) recaptcha = true

    if (!file.endsWith('.astro')) continue
    let tree
    try {
      tree = parseAstro(text)
    } catch (e) {
      parseErrors.push({ file, message: e instanceof Error ? e.message : String(e) })
      continue
    }
    for (const script of elements(tree.root, 'script')) for (const slug of trackersInScript(script, text)) trackers.add(slug)
    const imports = tree.frontmatter ? importsOf(parseModule(tree.frontmatter.text)).map((i) => i.from) : []
    for (const slug of importedTrackers(imports)) trackers.add(slug)
    if (imports.some((from) => from === PACKAGE || from.startsWith(`${PACKAGE}/`))) componentsWired = true
  }

  const alreadyWired: string[] = []
  if (deps.includes(PACKAGE)) alreadyWired.push('dependency')
  if (configImports.includes(PACKAGE)) alreadyWired.push('config')
  if (files.list('**/*.css').some((f) => /@source\s+["'][^"']*@visionmediahq\/astro-consent/.test(files.read(f)))) alreadyWired.push('css')
  if (componentsWired) alreadyWired.push('components')
  if (files.exists('src/data/privacy.json')) alreadyWired.push('privacy.json')

  return { trackers: [...trackers].sort(), banners, recaptcha, alreadyWired, parseErrors }
}
