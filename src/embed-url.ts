import type { ServiceSlug } from './services'

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

/**
 * The open link for an embed URL: a Google Maps embed URL becomes a link a visitor can open in a new
 * tab; other URLs pass through, minus an `output=embed` parameter.
 */
function openLink(src: string): string {
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

const YOUTUBE_PLAYER = 'https://www.youtube-nocookie.com/embed/'
const YOUTUBE_WATCH = 'https://www.youtube.com/watch'
const YOUTUBE_ALLOW = 'autoplay; encrypted-media; picture-in-picture; fullscreen'
const YOUTUBE_AUTOPLAY = 'autoplay=1'
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const PLAYLIST_ID = /^[A-Za-z0-9_-]+$/

const isHost = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

/** Seconds from `t=90`, `t=90s`, `t=1m30s`, `t=1h2m3s` or `start=90`; null for 0 or anything else. */
function seconds(value: string | null): number | null {
  if (!value) return null
  const units = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/)
  const total = /^\d+$/.test(value)
    ? Number(value)
    : units
      ? Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0)
      : 0
  return total > 0 && Number.isSafeInteger(total) ? total : null
}

/**
 * A YouTube URL in any form an editor pastes (`watch?v=`, `youtu.be/`, `/shorts/`, `/live/`,
 * `/embed/` on youtube.com or youtube-nocookie.com). The player always loads from youtube-nocookie.com; the
 * video id and playlist id are checked against their alphabets, so nothing else reaches either URL.
 * Null for another host or a URL with no video id (a channel or a bare playlist).
 */
function youtube(src: string): Embed | null {
  let url: URL
  try {
    const trimmed = src.trim()
    url = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const [first, second] = url.pathname.split('/').filter(Boolean)
  let id: string | null | undefined
  let shorts = false
  const onYoutube = isHost(host, 'youtube.com')
  if (host === 'youtu.be') id = first
  else if ((onYoutube || isHost(host, 'youtube-nocookie.com')) && first === 'embed') id = second
  else if (onYoutube && first === 'watch' && second === undefined) id = url.searchParams.get('v')
  else if (onYoutube && first === 'shorts') [id, shorts] = [second, true]
  // A stream or its recording, as YouTube's share button gives it; a channel's /@name/live is not.
  else if (onYoutube && first === 'live') id = second
  // /embed/videoseries?list= is a bare playlist, and its name happens to be 11 id characters long.
  if (!id || id === 'videoseries' || !VIDEO_ID.test(id)) return null

  const hash = new URLSearchParams(url.hash.slice(1))
  const start = seconds(url.searchParams.get('t')) ?? seconds(url.searchParams.get('start')) ?? seconds(hash.get('t'))
  const list = url.searchParams.get('list')
  const player = new URL(YOUTUBE_PLAYER + id)
  const watch = new URL(YOUTUBE_WATCH)
  watch.searchParams.set('v', id)
  if (start !== null) {
    player.searchParams.set('start', String(start))
    watch.searchParams.set('t', String(start))
  }
  if (list && PLAYLIST_ID.test(list)) {
    player.searchParams.set('list', list)
    watch.searchParams.set('list', list)
  }
  return {
    src: player.toString(),
    href: watch.toString(),
    allow: YOUTUBE_ALLOW,
    autoplay: YOUTUBE_AUTOPLAY,
    ...(shorts ? { aspect: '9 / 16' } : {}),
  }
}

/** What `ConsentEmbed` renders for one service's embed URL. */
export interface Embed {
  /** The iframe `src`. */
  src: string
  /** The "open" link, to the content at the provider. */
  href: string
  /** The iframe's `allow` attribute, when the service needs one. */
  allow?: string
  /**
   * Query parameters that start playback (`name=value`, `&`-separated). The component puts them on
   * the root as `data-autoplay`; the runtime adds them to the iframe URL only for the embed whose
   * "Visa" the visitor clicked.
   */
  autoplay?: string
  /** The default CSS aspect-ratio of the box, when the service has its own. */
  aspect?: string
}

/**
 * Per-service embed behaviour, so `ConsentEmbed` and the browser runtime need no service-specific
 * code. Null when `src` gives the service nothing to embed (a YouTube URL with no video id). The
 * returned `src` must still belong to `service` (`srcMatchesService`): the component checks it and
 * renders the "unavailable" message otherwise, as it does for null. Node-free: the components import it.
 */
export function embedFor(service: ServiceSlug, src: string): Embed | null {
  switch (service) {
    case 'youtube':
      return youtube(src)
    case 'google-maps':
    case 'google-calendar':
    default:
      // The URL is embedded as given, and the open link de-embeds it.
      return { src, href: openLink(src) }
  }
}

/**
 * `src` with an embed's autoplay parameters (`Embed.autoplay`) added, for the embed whose "Visa" the
 * visitor clicked. `src` is resolved against `base` (the page), so a protocol-relative or relative
 * src works too. A key already in the query is replaced, not repeated; every other part of the query
 * and the fragment keep their exact encoding. Null when `src` is no URL, so the caller inserts the
 * payload unchanged rather than failing the click.
 */
export function withAutoplay(src: string, params: string, base: string): string | null {
  let url: URL
  try {
    url = new URL(src, base)
  } catch {
    return null
  }
  const added = new URLSearchParams(params)
  const nameOf = (segment: string) => [...new URLSearchParams(segment).keys()][0] ?? ''
  const kept = url.search
    .slice(1)
    .split('&')
    .filter((segment) => segment !== '' && !added.has(nameOf(segment)))
  url.search = [...kept, params].join('&')
  return url.toString()
}
