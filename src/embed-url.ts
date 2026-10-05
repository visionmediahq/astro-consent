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

/**
 * "Share → Embed a map" URL (/maps/embed?pb=…). Google ignores pb= outside an iframe, so the link is
 * rebuilt from the place name (`!1m2!1s<id>!2s<name>`) or, without one, the coordinates
 * (`!2d<lng>!3d<lat>`). The name block is matched with its `!1m2` prefix so the language/region
 * block (`!3m2!1ssv!2sse`) is never read as a name.
 */
function fromPb(pb: string): string {
  const name = pb.match(/!1m2!1s[^!]*!2s([^!]+)/)?.[1]
  if (name) return mapsLink('/search/', { api: '1', query: name })
  const lng = pb.match(/!2d(-?[\d.]+)/)?.[1]
  const lat = pb.match(/!3d(-?[\d.]+)/)?.[1]
  if (lat && lng) return mapsLink('/search/', { api: '1', query: `${lat},${lng}` })
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
  const pb = url.searchParams.get('pb')
  if (/^\/maps\/embed\/?$/.test(url.pathname) && pb) return fromPb(pb)

  url.pathname = url.pathname.replace('/maps/embed', '/maps')
  if (url.searchParams.get('output') === 'embed') url.searchParams.delete('output')
  return url.toString()
}
