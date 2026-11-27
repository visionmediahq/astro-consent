import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { embedFor, withAutoplay } from '../../src/embed-url'
import { srcMatchesService } from '../../src/services'

const mapsHref = (src: string) => embedFor('google-maps', src)!.href

// "Share → Embed a map" URLs (/maps/embed?pb=…). Google ignores pb= outside an iframe, so /maps?pb=
// opens the visitor's own location. The link is rebuilt from the place name or the coordinates.
const PB_PLACE =
  'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2196.5!2d14.6357!3d63.1792!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1' +
  '!3m3!1m2!1s0x0000000000000000%3A0x0000000000000000!2sStorgatan+1%2C+831+30+%C3%96stersund!5e0!3m2!1ssv!2sse!4v1700000000000!5m2!1ssv!2sse'

test('turns a pb= embed with a place name into a Maps search for that name', () => {
  expect(mapsHref(PB_PLACE)).toBe('https://www.google.com/maps/search/?api=1&query=Storgatan+1%2C+831+30+%C3%96stersund')
})

test('never reads the language/region block of a pb= embed as the place name', () => {
  const noPlace =
    'https://www.google.com/maps/embed?pb=!1m14!1m12!1m3!1d2196.5!2d14.6357!3d63.1792!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1' +
    '!5e0!3m2!1ssv!2sse!4v1700000000000'
  expect(mapsHref(noPlace)).not.toContain('query=se')
})

test('falls back to the coordinates of a pb= embed without a place name', () => {
  const coordsOnly =
    'https://www.google.com/maps/embed?pb=!1m14!1m12!1m3!1d2196.5!2d14.6357!3d63.1792!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1' +
    '!5e0!3m2!1ssv!2sse!4v1700000000000'
  expect(mapsHref(coordsOnly)).toBe('https://www.google.com/maps/search/?api=1&query=63.1792%2C14.6357')
})

test('falls back to plain Google Maps for a pb= embed with neither a name nor coordinates', () => {
  expect(mapsHref('https://www.google.com/maps/embed?pb=!1m18!1m12')).toBe('https://www.google.com/maps')
})

test('drops output=embed and keeps other parameters', () => {
  expect(mapsHref('https://maps.google.com/maps?q=demo&output=embed')).toBe('https://maps.google.com/maps?q=demo')
})

test('drops the query entirely when output=embed was the only parameter', () => {
  expect(mapsHref('https://maps.google.com/maps?output=embed')).toBe('https://maps.google.com/maps')
})

test('leaves a non-embed URL unchanged', () => {
  const url = 'https://www.google.com/maps/search/?api=1&query=demo'
  expect(mapsHref(url)).toBe(url)
  expect(mapsHref('https://example.com/video?output=json')).toBe('https://example.com/video?output=json')
})

test('returns the input when it is not a URL', () => {
  expect(mapsHref('not a url')).toBe('not a url')
})

// Maps Embed API (https://www.google.com/maps/embed/v1/<mode>?key=…): the link must work in a
// normal browser tab and must never carry the site's API key.
test('turns an Embed API place URL into a Maps search link without the API key', () => {
  const link = mapsHref('https://www.google.com/maps/embed/v1/place?key=AIzaSECRET&q=Storgatan+1,+Östersund')
  expect(link).toBe('https://www.google.com/maps/search/?api=1&query=Storgatan+1%2C+%C3%96stersund')
  expect(link).not.toContain('AIzaSECRET')
})

test('turns an Embed API search URL into a Maps search link', () => {
  expect(mapsHref('https://www.google.com/maps/embed/v1/search?key=k&q=pizza+near+Östersund&zoom=12')).toBe(
    'https://www.google.com/maps/search/?api=1&query=pizza+near+%C3%96stersund',
  )
})

test('turns an Embed API place_id URL into a place link', () => {
  expect(mapsHref('https://www.google.com/maps/embed/v1/place?key=k&q=place_id:ChIJN1t_tDeuEmsRUsoyG83frY4')).toBe(
    'https://www.google.com/maps/place/?q=place_id%3AChIJN1t_tDeuEmsRUsoyG83frY4',
  )
})

test('turns an Embed API view URL into a map link centred on the same point', () => {
  expect(mapsHref('https://www.google.com/maps/embed/v1/view?key=k&center=63.1792,14.6357&zoom=14')).toBe(
    'https://www.google.com/maps/@?api=1&map_action=map&center=63.1792%2C14.6357&zoom=14',
  )
})

test('turns an Embed API directions URL into a directions link', () => {
  expect(mapsHref('https://www.google.com/maps/embed/v1/directions?key=k&origin=Östersund&destination=Åre')).toBe(
    'https://www.google.com/maps/dir/?api=1&origin=%C3%96stersund&destination=%C3%85re',
  )
})

test('falls back to plain Google Maps for an Embed API URL it cannot translate, still without the key', () => {
  expect(mapsHref('https://www.google.com/maps/embed/v1/streetview?key=AIzaSECRET&location=46.4,10.0')).toBe(
    'https://www.google.com/maps',
  )
  expect(mapsHref('https://www.google.com/maps/embed/v1/place?key=AIzaSECRET')).toBe('https://www.google.com/maps')
})

test('leaves a Google Calendar embed URL with src and ctz as it is', () => {
  const url = 'https://calendar.google.com/calendar/embed?src=abc%40group.calendar.google.com&ctz=Europe%2FStockholm'
  expect(embedFor('google-calendar', url)!.href).toBe(url)
})

// embedFor: what ConsentEmbed renders for each service. Maps and Calendar load the URL as given,
// in the component's default box, with no allow list and no autoplay parameter.
test('Maps and Calendar embed the src exactly as given, with no allow list, autoplay or default aspect', () => {
  const cases = [
    ['google-maps', PB_PLACE],
    ['google-maps', 'https://www.google.com/maps/embed/v1/place?key=AIzaSECRET&q=Storgatan+1'],
    ['google-calendar', 'https://calendar.google.com/calendar/embed?src=abc%40group.calendar.google.com&ctz=Europe%2FStockholm'],
  ] as const
  for (const [service, src] of cases) {
    const embed = embedFor(service, src)!
    expect(embed.src).toBe(src)
    expect(srcMatchesService(embed.src, service)).toBe(true)
    expect(embed.allow).toBeUndefined()
    expect(embed.autoplay).toBeUndefined()
    expect(embed.aspect).toBeUndefined()
  }
})

test('a Calendar URL with output=embed keeps today\'s open link', () => {
  const url = 'https://calendar.google.com/calendar/embed?src=abc&output=embed'
  expect(embedFor('google-calendar', url)!.href).toBe('https://calendar.google.com/calendar/embed?src=abc')
})

test('the embed-URL module is browser-safe: it imports nothing but the node-free types', () => {
  const source = readFileSync(new URL('../../src/embed-url.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import\b[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
  expect(imports.every((from) => from === './services' || from === './types')).toBe(true)
  expect(source).not.toMatch(/node:|from '\.\/config'|zod/)
})

// #170: YouTube. Editors paste whichever URL they have; the iframe always loads the video from
// youtube-nocookie.com, and the open link goes to the normal watch page.
describe('embedFor youtube', () => {
  const ID = 'dQw4w9WgXcQ'
  const PLAYER = `https://www.youtube-nocookie.com/embed/${ID}`
  const WATCH = `https://www.youtube.com/watch?v=${ID}`
  const yt = (src: string) => embedFor('youtube', src)

  test('every accepted URL form gives the same nocookie player and watch link', () => {
    for (const src of [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}`,
      `https://m.youtube.com/watch?v=${ID}&feature=share`,
      `https://www.youtube.com/watch?feature=youtu.be&v=${ID}`,
      `https://youtu.be/${ID}`,
      `https://youtu.be/${ID}?si=AbCdEfGh`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube.com/embed/${ID}?rel=0`,
      `https://www.youtube-nocookie.com/embed/${ID}`,
      `//www.youtube.com/embed/${ID}`,
      `  https://www.youtube.com/watch?v=${ID}  `,
    ]) {
      const embed = yt(src)
      expect(embed, src).not.toBeNull()
      expect(embed!.src, src).toBe(PLAYER)
      expect(embed!.href, src).toBe(WATCH)
      expect(embed!.aspect, src).toBeUndefined()
      expect(srcMatchesService(embed!.src, 'youtube')).toBe(true)
    }
  })

  test('a Shorts URL gets the same player and link, in a portrait box', () => {
    for (const src of [`https://www.youtube.com/shorts/${ID}`, `https://youtube.com/shorts/${ID}?feature=share`]) {
      expect(yt(src), src).toEqual({
        src: PLAYER,
        href: WATCH,
        allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
        autoplay: 'autoplay=1',
        aspect: '9 / 16',
      })
    }
  })

  // #180: YouTube's share button gives /live/<id> for a stream or its recording.
  test('a live URL gets the same player, link and box as a watch URL', () => {
    for (const src of [
      `https://www.youtube.com/live/${ID}`,
      `https://youtube.com/live/${ID}`,
      `https://m.youtube.com/live/${ID}`,
      `https://www.youtube.com/live/${ID}?si=AbCdEfGh`,
      `https://www.youtube.com/live/${ID}?feature=share`,
    ]) {
      expect(yt(src), src).toEqual({
        src: PLAYER,
        href: WATCH,
        allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
        autoplay: 'autoplay=1',
      })
    }
  })

  test('the player gets the allow list it needs', () => {
    expect(yt(WATCH)!.allow).toBe('autoplay; encrypted-media; picture-in-picture; fullscreen')
  })

  // #171: the runtime adds it to the player URL only when the visitor clicked "Visa".
  test('the autoplay parameter is autoplay=1, and is not in the src itself', () => {
    expect(yt(WATCH)!.autoplay).toBe('autoplay=1')
    expect(yt(WATCH)!.src).not.toContain('autoplay')
  })

  test('a start time in any form becomes start=<seconds> on the player and t=<seconds> on the link', () => {
    const cases: Array<[string, number]> = [
      [`${WATCH}&t=90`, 90],
      [`${WATCH}&t=90s`, 90],
      [`${WATCH}&t=1m30s`, 90],
      [`${WATCH}&t=1h2m3s`, 3723],
      [`${WATCH}&t=2m`, 120],
      [`https://youtu.be/${ID}?t=45`, 45],
      [`https://www.youtube.com/embed/${ID}?start=90`, 90],
      [`https://www.youtube.com/shorts/${ID}?t=5`, 5],
      [`https://www.youtube.com/live/${ID}?t=90`, 90],
      [`https://www.youtube.com/live/${ID}?si=AbCdEfGh&t=1m30s`, 90],
      [`https://www.youtube.com/watch?v=${ID}#t=90`, 90],
    ]
    for (const [src, seconds] of cases) {
      expect(yt(src)!.src, src).toBe(`${PLAYER}?start=${seconds}`)
      expect(yt(src)!.href, src).toBe(`${WATCH}&t=${seconds}`)
    }
  })

  test('a start time that is zero or not a time is dropped', () => {
    for (const t of ['0', '0s', 'abc', '1x', '-5', '', '1m30', '90.5']) {
      expect(yt(`${WATCH}&t=${t}`)!.src, t).toBe(PLAYER)
      expect(yt(`${WATCH}&t=${t}`)!.href, t).toBe(WATCH)
    }
  })

  test('an invalid t falls back to start, and a start time too large to be one is dropped', () => {
    expect(yt(`https://www.youtube.com/embed/${ID}?t=abc&start=90`)!.src).toBe(`${PLAYER}?start=90`)
    expect(yt(`${WATCH}&t=${'9'.repeat(30)}`)!.src).toBe(PLAYER)
    expect(yt(`${WATCH}&t=${'9'.repeat(30)}h`)!.src).toBe(PLAYER)
  })

  test('a playlist next to a video id is kept on both, after the start time', () => {
    const list = 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'
    expect(yt(`${WATCH}&list=${list}`)).toMatchObject({ src: `${PLAYER}?list=${list}`, href: `${WATCH}&list=${list}` })
    expect(yt(`https://youtu.be/${ID}?list=${list}&t=30`)).toMatchObject({
      src: `${PLAYER}?start=30&list=${list}`,
      href: `${WATCH}&t=30&list=${list}`,
    })
    expect(yt(`https://www.youtube.com/embed/${ID}?list=${list}`)!.src).toBe(`${PLAYER}?list=${list}`)
    expect(yt(`https://www.youtube.com/live/${ID}?list=${list}`)!.src).toBe(`${PLAYER}?list=${list}`)
  })

  test('a playlist id that is not one is dropped', () => {
    expect(yt(`${WATCH}&list=a"b`)!.src).toBe(PLAYER)
    expect(yt(`${WATCH}&list=`)!.src).toBe(PLAYER)
  })

  test('a URL with no video id gives no embed', () => {
    for (const src of [
      'https://www.youtube.com/@visionmedia',
      'https://www.youtube.com/channel/UC1234567890',
      'https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG',
      'https://www.youtube.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG',
      'https://www.youtube.com/watch',
      'https://www.youtube.com/watch?v=',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQx',
      'https://www.youtube.com/watch?v=dQw4w9WgX%22',
      'https://youtu.be/',
      'https://www.youtube.com/shorts/',
      'https://www.youtube.com/live/',
      'https://www.youtube.com/live/short',
      'https://www.youtube.com/@visionmedia/live',
      'https://www.youtube.com/channel/UC1234567890/live',
      'https://www.youtube.com/',
      'not a url',
      '',
    ])
      expect(yt(src), src).toBeNull()
  })

  test('a URL on another host gives no embed, even with a YouTube-shaped path', () => {
    for (const src of [
      `https://example.com/embed/${ID}`,
      `https://example.com/watch?v=${ID}`,
      `https://youtube.com.evil.io/watch?v=${ID}`,
      `https://evil.io/youtu.be/${ID}`,
      `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`,
      `http://www.youtube.com/watch?v=${ID}`.replace('http:', 'javascript:'),
    ])
      expect(yt(src), src).toBeNull()
  })

  test('an http URL is upgraded: the player is always https', () => {
    expect(yt(`http://www.youtube.com/watch?v=${ID}`)!.src).toBe(PLAYER)
  })
})

// #171: the runtime adds an embed's autoplay parameters to the player URL when the visitor clicked
// "Visa". It resolves the src against the page and replaces keys already there, leaving the rest of
// the query exactly as written.
describe('withAutoplay', () => {
  const PAGE = 'https://site.test/video'

  test('appends to an existing query, or starts one', () => {
    expect(withAutoplay('https://www.youtube-nocookie.com/embed/abc?start=90', 'autoplay=1', PAGE)).toBe(
      'https://www.youtube-nocookie.com/embed/abc?start=90&autoplay=1',
    )
    expect(withAutoplay('https://www.youtube-nocookie.com/embed/abc', 'autoplay=1', PAGE)).toBe(
      'https://www.youtube-nocookie.com/embed/abc?autoplay=1',
    )
  })

  test('a protocol-relative or relative src is resolved against the page', () => {
    expect(withAutoplay('//player.test/embed/x', 'autoplay=1', PAGE)).toBe('https://player.test/embed/x?autoplay=1')
    expect(withAutoplay('/embed/x?a=1', 'autoplay=1', PAGE)).toBe('https://site.test/embed/x?a=1&autoplay=1')
  })

  test('a key already in the src is replaced, not repeated', () => {
    expect(withAutoplay('https://player.test/e?autoplay=0&start=5', 'autoplay=1', PAGE)).toBe(
      'https://player.test/e?start=5&autoplay=1',
    )
    expect(withAutoplay('https://player.test/e?autoplay=0&autoplay', 'autoplay=1&mute=1', PAGE)).toBe(
      'https://player.test/e?autoplay=1&mute=1',
    )
  })

  test('the rest of the query and the fragment keep their exact encoding', () => {
    expect(withAutoplay('https://player.test/e?q=a%20b&x=%2F#t=5', 'autoplay=1', PAGE)).toBe(
      'https://player.test/e?q=a%20b&x=%2F&autoplay=1#t=5',
    )
  })

  test('a src that is no URL at all gives null, so the payload goes in unchanged', () => {
    expect(withAutoplay('http://[bad', 'autoplay=1', PAGE)).toBeNull()
  })
})
