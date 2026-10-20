// Detects what a site loads or gates by script: trackers (registry services loaded by script or
// import), embeds a script builds (an embed URL in a `<script>` or an element attribute, #57),
// existing consent banners, reCAPTCHA, and astro-consent wiring that is already there.
//
// Misreading goes one way only. A false hit sends a site to a human; a miss could wire a site that
// loads a tracker before consent. So the text sweeps read whole files, comments included, and only
// leave out what is clearly not a load: JSON-LD data and links to a Facebook page.
import { type ServiceSlug, SERVICE_SLUGS, SERVICES, matchesRegistry } from '../../../src/services'
import type { Report } from '../types'
import { type AstroNode, attr, elements, parseAstro } from '../lib/astro-ast'
import { importsOf, parseModule } from '../lib/ts-ast'
import type { SiteFiles } from '../lib/site-files'
import { resolveRelative } from '../lib/site-imports'

/**
 * An iframe embed URL (a map, a calendar) outside an `<iframe>`: a click-to-load the site built
 * itself, which ignores the banner's consent and which wire cannot convert. `where` is the attribute
 * that holds it (`data-map-src`) or `script`.
 */
export interface ScriptBuiltEmbed {
  service: ServiceSlug
  file: string
  where: string
}

/** A `<script src>` or remote `import` from a host the registry does not know (#36). */
export interface ScriptHost {
  host: string
  file: string
}

export type DetectedScripts = Pick<Report, 'trackers' | 'banners' | 'recaptcha' | 'alreadyWired'> & {
  scriptBuilt: ScriptBuiltEmbed[]
  scriptHosts: ScriptHost[]
  /** `.astro` files under src/ that did not parse; their text is still swept. */
  parseErrors: { file: string; message: string }[]
}

const PACKAGE = '@visionmediahq/astro-consent'

export const BINARY = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|svg|woff2?|ttf|otf|eot|pdf|mp[34]|webm|ogg|wav|mov|zip|gz)$/i

/**
 * Maps patterns that ordinary links match too: a "Hitta hit" link, JSON-LD `hasMap`, an embed
 * iframe. They are left out of the text sweep; map iframes are detectIframes' job.
 */
const LINK_LIKE = new Set(['google.com/maps', 'maps.google.'])

/** Google Calendar only ever loads as an iframe and has no tracker script: detectIframes is its only reporter. */
const IFRAME_ONLY = new Set<ServiceSlug>(['google-calendar'])

/** Elfsight loads through its platform script: detectWidgets is its only reporter (a widget, or a reason). */
const WIDGET_ONLY = new Set<ServiceSlug>(['elfsight'])

/**
 * Registry patterns that are a bare host (no path): safe to find anywhere in text. Path patterns
 * (`facebook.com/tr`) are only matched on parsed URLs, where a page link such as
 * `facebook.com/traforadling` can be told apart. The Maps API hosts (`maps.googleapis.com`,
 * `maps.gstatic.com`, `places.googleapis.com`) are kept: outside an iframe they are loads the batch
 * does not wire (a Static Maps image, the JavaScript API, its fonts and tiles).
 */
const HOST_PATTERNS: [string, ServiceSlug][] = SERVICE_SLUGS.filter((slug) => !IFRAME_ONLY.has(slug) && !WIDGET_ONLY.has(slug)).flatMap((slug) =>
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
    if (slug !== null && slug !== 'google-maps' && !IFRAME_ONLY.has(slug) && !WIDGET_ONLY.has(slug)) out.push(slug)
  }
  return out
}

/**
 * The service whose iframe embed `url` is: a Google Maps embed (`/maps/embed…`, `output=embed`) or
 * a Google Calendar embed (`/calendar/embed`). Links, the Maps JavaScript API and the rest are not.
 */
function embedServiceOfUrl(written: string): ServiceSlug | null {
  // An attribute value is kept as written, so `&amp;` is still encoded.
  const url = written.replace(/&amp;/gi, '&')
  const slug = serviceOfUrl(url)
  if (slug !== 'google-maps' && slug !== 'google-calendar') return null
  const parsed = new URL(url.startsWith('//') ? `https:${url}` : url)
  if (slug === 'google-calendar') return CALENDAR_EMBED_PATH.test(parsed.pathname) ? slug : null
  return MAPS_EMBED_PATH.test(parsed.pathname) || parsed.searchParams.get('output') === 'embed' ? slug : null
}

/** `/calendar/embed`, `/calendar/u/0/embed`. */
const CALENDAR_EMBED_PATH = /^\/calendar\/(?:u\/\d+\/)?embed(?:\/|$)/
/** `/maps/embed…` and My Maps' `/maps/d/embed`, `/maps/d/u/0/embed`. */
const MAPS_EMBED_PATH = /^\/maps\/(?:d\/(?:u\/\d+\/)?)?embed(?:\/|$)/

/** `document.createElement('iframe')` in a script. */
const CREATE_IFRAME = /\bcreateElement\s*\(\s*(['"`])iframe\1\s*\)/i

/**
 * Embed services whose pieces appear somewhere in `text`, not necessarily as one URL: a registry
 * host and an embed marker (gron-kontor writes `'https://maps.google.com/maps?q=' + … +
 * '&t=&z=15&ie=UTF8&iwloc=&output=embed'`). Literal `<iframe>` tags are left out: detectIframes
 * reports those.
 */
function embedServicesInText(text: string): ServiceSlug[] {
  const t = text.toLowerCase().replace(IFRAME_TAG, '').replace(/&amp;/g, '&')
  const out: ServiceSlug[] = []
  const mapsHost = SERVICES['google-maps'].match.some((p) => t.includes(p))
  if (mapsHost && /output=embed|\/maps\/(?:d\/(?:u\/\d+\/)?)?embed\b/.test(t)) out.push('google-maps')
  if (SERVICES['google-calendar'].match.some((p) => t.includes(p)) && /\/calendar\/(?:u\/\d+\/)?embed\b/.test(t)) out.push('google-calendar')
  return out
}

/** Relative specifiers a `<script>` body imports. */
const SCRIPT_IMPORT = /\b(?:from|import)\s*(['"])(\.\.?\/[^'"]+)\1/g

/**
 * A `<script>` that creates an iframe whose URL comes through a variable (`data-src={mapSrc}`,
 * tranemoglas; an imported `mapsEmbedUrl`, gron-kontor): the services whose embed pieces appear in
 * the file itself or in a relative non-`.astro` module it imports. An `.astro` import is left out:
 * a component's own iframe is detectIframes' to report.
 */
function iframeBuiltFromVariable(files: SiteFiles, file: string, text: string, scripts: AstroNode[], frontmatter: string): ServiceSlug[] {
  const bodies = scripts.map((s) => text.slice(s.start, s.end))
  if (!bodies.some((b) => CREATE_IFRAME.test(b))) return []
  const specifiers = [
    ...(frontmatter ? importsOf(parseModule(frontmatter)).map((i) => i.from) : []),
    ...bodies.flatMap((b) => [...b.matchAll(SCRIPT_IMPORT)].map((m) => m[2]!)),
  ]
  const modules = [...new Set(specifiers.flatMap((s) => resolveRelative(files, file, s) ?? []))].filter((m) => !m.endsWith('.astro'))
  return [...new Set([text, ...modules.map((m) => files.read(m))].flatMap(embedServicesInText))]
}

/** Registry services a `<script>` element loads by its `src` or its inline body, and the embeds it builds. JSON data is skipped. */
function servicesInScript(node: AstroNode, text: string): { trackers: ServiceSlug[]; embeds: ServiceSlug[] } {
  const type = attr(node, 'type')
  if (type?.kind === 'quoted' && /json/i.test(type.value)) return { trackers: [], embeds: [] }
  const src = attr(node, 'src')
  const urls = [...(src && src.kind !== 'empty' ? [src.value, ...urlsIn(src.value)] : []), ...urlsIn(text.slice(node.start, node.end))]
  const trackers: ServiceSlug[] = []
  const embeds: ServiceSlug[] = []
  for (const u of urls) {
    const embed = embedServiceOfUrl(u)
    if (embed !== null) embeds.push(embed)
    else {
      const slug = serviceOfUrl(u)
      if (slug !== null && !WIDGET_ONLY.has(slug)) trackers.push(slug)
    }
  }
  return { trackers, embeds }
}

/**
 * Script hosts that need no consent, agreed one by one; each with its reason. A path prefix narrows
 * a shared CDN to the one package. Everything else outside the registry goes to a human.
 */
const AGREED_SCRIPT_HOSTS: { host: string; path?: string; reason: string }[] = [
  // Error reporting (GlitchTip) through Sentry's browser bundle: whether it counts as a service is
  // parked (memory glitchtip-consent-paused), so the 80-odd sites that carry it are not held up.
  { host: 'browser.sentry-cdn.com', reason: 'error reporting bundle, consent decision parked' },
  { host: 'cdn.jsdelivr.net', path: '/npm/@sentry/', reason: 'error reporting bundle, consent decision parked' },
]

/** CMS admin shells load their editor from a CDN and are never part of what a visitor sees. */
const ADMIN_SHELL = /^(?:public|src\/pages)\/admin(?:\/|\.)/

/**
 * Remote modules a script body imports, one statement start per line: `import 'https://…'`,
 * `import a from "//…"`, `} from '…'` closing a multi-line list, `export * from '…'`,
 * `await import('https://…')`. Block comments are cut first; a line comment or a string that only
 * mentions an import does not start a statement.
 */
const REMOTE_IMPORTS = [
  /^[ \t]*(?:(?:(?:const|let|var)\s+)?[\w$.]+\s*=\s*)?(?:await\s+)?import\s*\(?\s*(['"])((?:https?:)?\/\/[^'"]+)\1/,
  /^[ \t]*(?:(?:import|export)\b[^'"\n]*|\}[^'"\n]*)\bfrom\s*(['"])((?:https?:)?\/\/[^'"]+)\1/,
]

/**
 * Longest line or tag read. These regexes backtrack, and a minified or broken file is one huge
 * line: past this it is skipped, so a 1 MB file costs linear time, not minutes. A real import on a
 * line this long (minified source) is missed; src/ is not minified, and a miss is the safe direction.
 */
const MAX_SPAN = 4000

/** `text` without the stretches from `open` to `close`; an unterminated one runs to the end, as a browser reads it. Linear. */
function withoutSpans(text: string, open: string, close: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const start = text.indexOf(open, i)
    if (start === -1) return out + text.slice(i)
    out += text.slice(i, start)
    const end = text.indexOf(close, start + open.length)
    if (end === -1) return out
    i = end + close.length
  }
}

const remoteImports = (body: string): string[] =>
  withoutSpans(body, '/*', '*/')
    .split('\n')
    .flatMap((line) => (line.length > MAX_SPAN ? [] : REMOTE_IMPORTS.flatMap((re) => re.exec(line)?.[2] ?? [])))

/** `src` of the `<script>` tags in a plain HTML file, HTML comments cut and JSON data scripts left out. */
function htmlScriptSrcs(html: string): string[] {
  const text = withoutSpans(html, '<!--', '-->')
  const lower = text.toLowerCase()
  const out: string[] = []
  let i = 0
  for (;;) {
    const start = lower.indexOf('<script', i)
    if (start === -1) return out
    const end = lower.indexOf('>', start)
    if (end === -1) return out
    i = end
    const attrs = text.slice(start + '<script'.length, end)
    if (attrs.length > MAX_SPAN || /^[\w-]/.test(attrs)) continue
    if (/(?:^|\s)type\s*=\s*["']?[^"'\s>]*json/i.test(attrs)) continue
    const src = /(?:^|\s)src\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/i.exec(attrs)
    if (src) out.push(src[1]!)
  }
}

/** The hosts, outside the registry and the agreed list, that these absolute URLs load scripts from. */
function unregisteredHosts(urls: string[]): string[] {
  const out: string[] = []
  for (const u of urls) {
    // reCAPTCHA has its own report (`recaptcha`) and wire replaces it with spam-guard.
    if (serviceOfUrl(u) !== null || RECAPTCHA.test(u)) continue
    let parsed: URL
    try {
      parsed = new URL(u.startsWith('//') ? `https:${u}` : u)
    } catch {
      continue
    }
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, '')
    if (AGREED_SCRIPT_HOSTS.some((a) => a.host === host && (a.path === undefined || parsed.pathname.startsWith(a.path)))) continue
    if (!out.includes(host)) out.push(host)
  }
  return out
}

/** Absolute URLs a `<script>` element loads by `src` or imports in its body; JSON data is skipped. */
function scriptLoadUrls(node: AstroNode, text: string): string[] {
  const type = attr(node, 'type')
  if (type?.kind === 'quoted' && /json/i.test(type.value)) return []
  const src = attr(node, 'src')
  const fromSrc = src && src.kind !== 'empty' ? urlsIn(src.value) : []
  const source = text.slice(node.start, node.end)
  // The opening tag is cut, or a one-line body would not start its line with `import`.
  const fromBody = remoteImports(source.slice(source.indexOf('>') + 1))
  return [...fromSrc, ...fromBody]
}

/** Attributes whose URL a visitor follows rather than the page loads. */
const LINK_ATTRS = new Set(['href'])

/**
 * Embed URLs in the attributes of HTML elements other than `<iframe>` (detectIframes' job, lazy
 * `data-src` included) and `<script>` (servicesInScript), template literals in expressions
 * included: `data-map-src={`https://maps.google.com/maps?q=${q}&output=embed`}`. Component props
 * are left out: `<Map src=…>` is followed to its iframe by detectIframes.
 */
function embedsInAttributes(root: AstroNode): { service: ServiceSlug; where: string }[] {
  const out: { service: ServiceSlug; where: string }[] = []
  const visit = (n: AstroNode): void => {
    if (n.type === 'element' && n.name !== 'iframe' && n.name !== 'script') {
      for (const a of n.attributes) {
        if (a.kind === 'empty' || a.kind === 'spread' || LINK_ATTRS.has(a.name.toLowerCase())) continue
        for (const u of [a.value, ...urlsIn(a.value)]) {
          const service = embedServiceOfUrl(u)
          if (service !== null) out.push({ service, where: a.name })
        }
      }
    }
    n.children.forEach(visit)
  }
  visit(root)
  return out
}

function importedTrackers(specifiers: string[]): ServiceSlug[] {
  return specifiers.flatMap((from) => [
    ...IMPORTS.flatMap(([re, slug]) => (re.test(from) ? [slug] : [])),
    ...(!from.startsWith('.') && !from.startsWith('/') && MAPS_PACKAGE.test(from) ? (['google-maps'] as const) : []),
  ])
}

export function packageDeps(files: SiteFiles): string[] {
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
  const scriptBuilt: ScriptBuiltEmbed[] = []
  const scriptHosts: ScriptHost[] = []
  const addHosts = (file: string, urls: string[]): void => {
    if (ADMIN_SHELL.test(file)) return
    for (const host of unregisteredHosts(urls)) if (!scriptHosts.some((h) => h.host === host && h.file === file)) scriptHosts.push({ host, file })
  }
  const addBuilt = (e: ScriptBuiltEmbed): void => {
    if (!scriptBuilt.some((x) => x.service === e.service && x.file === e.file && x.where === e.where)) scriptBuilt.push(e)
  }
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

    if (file.endsWith('.html')) addHosts(file, htmlScriptSrcs(text))
    if (!file.endsWith('.astro')) continue
    let tree
    try {
      tree = parseAstro(text)
    } catch (e) {
      parseErrors.push({ file, message: e instanceof Error ? e.message : String(e) })
      continue
    }
    const scripts = elements(tree.root, 'script')
    for (const script of scripts) {
      const found = servicesInScript(script, text)
      for (const slug of found.trackers) trackers.add(slug)
      for (const service of found.embeds) addBuilt({ service, file, where: 'script' })
      addHosts(file, scriptLoadUrls(script, text))
    }
    for (const e of embedsInAttributes(tree.root)) addBuilt({ ...e, file })
    // Only when the URL itself was not found above: one reason per map is enough.
    for (const service of iframeBuiltFromVariable(files, file, text, scripts, tree.frontmatter?.text ?? '')) {
      if (!scriptBuilt.some((x) => x.file === file && x.service === service)) addBuilt({ service, file, where: 'createElement' })
    }
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

  return { trackers: [...trackers].sort(), scriptBuilt, scriptHosts, banners, recaptcha, alreadyWired, parseErrors }
}
