export const CATEGORIES = ['necessary', 'external', 'statistics', 'marketing'] as const

export type Category = (typeof CATEGORIES)[number]
export type ServiceSlug = 'google-maps' | 'google-calendar' | 'google-analytics' | 'google-ads' | 'meta-pixel' | 'elfsight'
export type Target = Category | ServiceSlug

export interface Service {
  name: string
  vendor: string
  category: Exclude<Category, 'necessary'>
  /** Lower-case substrings of a request URL (host, or host + path) that identify the service. */
  match: string[]
  description_sv: string
}

export const SERVICES: Record<ServiceSlug, Service> = {
  'google-maps': {
    name: 'Google Maps',
    vendor: 'Google Ireland Ltd',
    category: 'external',
    match: ['google.com/maps', 'maps.google.', 'maps.googleapis.com', 'maps.gstatic.com', 'places.googleapis.com'],
    description_sv: 'Kartor från Google.',
  },
  'google-calendar': {
    // Registry name is Swedish (shown in the banner and placeholder); the slug stays English.
    name: 'Google Kalender',
    vendor: 'Google Ireland Ltd',
    category: 'external',
    match: ['calendar.google.com'],
    description_sv: 'Kalendrar från Google.',
  },
  'google-analytics': {
    name: 'Google Analytics',
    vendor: 'Google Ireland Ltd',
    category: 'statistics',
    match: ['googletagmanager.com', 'google-analytics.com', 'analytics.google.com'],
    description_sv: 'Besöksstatistik från Google.',
  },
  'google-ads': {
    name: 'Google Ads',
    vendor: 'Google Ireland Ltd',
    category: 'marketing',
    match: ['googleadservices.com', 'doubleclick.net', 'googlesyndication.com'],
    description_sv: 'Annonsmätning från Google.',
  },
  'meta-pixel': {
    name: 'Meta-pixel',
    vendor: 'Meta Platforms Ireland Ltd',
    category: 'marketing',
    match: ['connect.facebook.net', 'facebook.com/tr'],
    description_sv: 'Annonsmätning från Meta (Facebook, Instagram).',
  },
  elfsight: {
    name: 'Elfsight',
    vendor: 'Elfsight, SL',
    category: 'external',
    match: ['elfsightcdn.com', 'elfsight.com'],
    description_sv: 'Flöden från sociala medier, till exempel Instagram, via Elfsight.',
  },
}

export const SERVICE_SLUGS = Object.keys(SERVICES) as ServiceSlug[]

export function isCategory(target: string): target is Category {
  return (CATEGORIES as readonly string[]).includes(target)
}

export function matchesRegistry(url: string): ServiceSlug | null {
  const lower = url.toLowerCase()
  for (const slug of SERVICE_SLUGS) {
    if (SERVICES[slug].match.some((pattern) => lower.includes(pattern))) return slug
  }
  return null
}

/**
 * Whether an embed URL belongs to `slug` (#107), judged by its host. Each `match` pattern is a host
 * (`calendar.google.com`), a host and a path prefix (`google.com/maps`), or a host ending in a dot
 * (`maps.google.`: that name under a country or `.com` top-level domain). The URL's hostname must be
 * the pattern's host or a subdomain of it, and its path must start with the pattern's path. Nothing
 * in the path or the query counts, nor does a URL without an http(s) host.
 */
export function srcMatchesService(src: string, slug: ServiceSlug): boolean {
  let url: URL
  try {
    url = new URL(src.trim().startsWith('//') ? `https:${src.trim()}` : src.trim())
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const path = url.pathname.toLowerCase()
  return SERVICES[slug].match.some((pattern) => {
    const slash = pattern.indexOf('/')
    const patternHost = slash < 0 ? pattern : pattern.slice(0, slash)
    const patternPath = slash < 0 ? '' : pattern.slice(slash)
    const hostOk = patternHost.endsWith('.')
      ? new RegExp(`^${patternHost.replace(/\./g, '\\.')}(?:com|[a-z]{2}|co\\.[a-z]{2}|com\\.[a-z]{2})$`).test(host)
      : host === patternHost || host.endsWith(`.${patternHost}`)
    return hostOk && path.startsWith(patternPath)
  })
}

export interface ServicesJson {
  generated_from: 'src/services.ts'
  categories: Category[]
  services: Record<ServiceSlug, Service>
}

export function generateServicesJson(): ServicesJson {
  return { generated_from: 'src/services.ts', categories: [...CATEGORIES], services: SERVICES }
}
