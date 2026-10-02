export const CATEGORIES = ['necessary', 'external', 'statistics', 'marketing'] as const

export type Category = (typeof CATEGORIES)[number]
export type ServiceSlug = 'google-maps' | 'google-analytics' | 'google-ads' | 'meta-pixel'
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

export interface ServicesJson {
  generated_from: 'src/services.ts'
  categories: Category[]
  services: Record<ServiceSlug, Service>
}

export function generateServicesJson(): ServicesJson {
  return { generated_from: 'src/services.ts', categories: [...CATEGORIES], services: SERVICES }
}
