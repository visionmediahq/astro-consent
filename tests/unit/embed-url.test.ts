import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { embedFor } from '../../src/embed-url'
import { srcMatchesService } from '../../src/services'

const mapsHref = (src: string) => embedFor('google-maps', src).href

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
  expect(embedFor('google-calendar', url).href).toBe(url)
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
    const embed = embedFor(service, src)
    expect(embed.src).toBe(src)
    expect(srcMatchesService(embed.src, service)).toBe(true)
    expect(embed.allow).toBeUndefined()
    expect(embed.autoplay).toBeUndefined()
    expect(embed.aspect).toBeUndefined()
  }
})

test('a Calendar URL with output=embed keeps today\'s open link', () => {
  const url = 'https://calendar.google.com/calendar/embed?src=abc&output=embed'
  expect(embedFor('google-calendar', url).href).toBe('https://calendar.google.com/calendar/embed?src=abc')
})

test('the embed-URL module is browser-safe: it imports nothing but the node-free types', () => {
  const source = readFileSync(new URL('../../src/embed-url.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import\b[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
  expect(imports.every((from) => from === './services' || from === './types')).toBe(true)
  expect(source).not.toMatch(/node:|from '\.\/config'|zod/)
})
