const MAPS = 'https://www.google.com/maps'

/** Builds a Google Maps URL from the given parameters, in the given order. */
function mapsLink(path: string, params: Record<string, string>): string {
  const url = new URL(MAPS + path)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

/**
 * Maps Embed API (/maps/embed/v1/<mode>?key=…). The embed URL only works in an iframe and carries
 * the site's API key, so the link is rebuilt from the parameters and the key is never copied.
 */
function fromEmbedApi(mode: string, params: URLSearchParams): string {
  const q = params.get('q')
  if ((mode === 'place' || mode === 'search') && q) {
    return q.startsWith('place_id:') ? mapsLink('/place/', { q }) : mapsLink('/search/', { api: '1', query: q })
  }
  const center = params.get('center')
  if (mode === 'view' && center) {
    const zoom = params.get('zoom')
    return mapsLink('/@', { api: '1', map_action: 'map', center, ...(zoom ? { zoom } : {}) })
  }
  const origin = params.get('origin')
  const destination = params.get('destination')
  if (mode === 'directions' && origin && destination) {
    return mapsLink('/dir/', { api: '1', origin, destination })
  }
  return MAPS
}

/** Turns a Google Maps embed URL into a link a visitor can open in a new tab. Other URLs pass through. */
export function deEmbed(src: string): string {
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return src
  }
  const embedApi = url.pathname.match(/^\/maps\/embed\/v1\/([a-z]+)\/?$/)
  if (embedApi) return fromEmbedApi(embedApi[1]!, url.searchParams)

  url.pathname = url.pathname.replace('/maps/embed', '/maps')
  if (url.searchParams.get('output') === 'embed') url.searchParams.delete('output')
  return url.toString()
}
