import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { posterError } from '../../src/poster'

const PAGE = '/video/'

// #172: a poster is shown before consent, so it must never be a request to a registry host.
test("the site's own image passes, whatever its path or file name says", () => {
  for (const url of [
    '/images/poster.jpg',
    'images/poster.jpg',
    '/_astro/poster.Bx3kQ.webp',
    '/images/youtube.com-thumbnail.jpg',
    '/i.ytimg.com/vi/x/hqdefault.jpg',
    'https://kund.se/images/poster.jpg',
    'https://cdn.example.com/poster.jpg?from=i.ytimg.com',
    'data:image/png;base64,iVBORw0KGgo=',
  ])
    expect(posterError(PAGE, 'youtube', url), url).toBeNull()
})

test('a poster on a registry host fails, naming the page, the poster, the host and its service', () => {
  const message = posterError(PAGE, 'youtube', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
  expect(message).toContain(PAGE)
  expect(message).toContain('<ConsentEmbed service="youtube">')
  expect(message).toContain('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
  expect(message).toContain('i.ytimg.com')
  expect(message).toMatch(/youtube/)
  expect(message).toMatch(/before consent/)
})

test("any service's host fails, under any service, also protocol-relative and in capitals", () => {
  for (const [url, owner] of [
    ['//i.ytimg.com/vi/x/hqdefault.jpg', 'youtube'],
    ['HTTPS://I.YTIMG.COM/vi/x/hqdefault.jpg', 'youtube'],
    ['https://img.youtube.com/vi/x/0.jpg', 'youtube'],
    ['https://maps.googleapis.com/maps/api/staticmap?center=x', 'google-maps'],
    ['https://www.google.com/maps/vt?pb=x', 'google-maps'],
    ['https://scontent.elfsight.com/p.jpg', 'elfsight'],
  ] as const) {
    const message = posterError(PAGE, 'google-maps', url)
    expect(message, url).not.toBeNull()
    expect(message, url).toContain(owner)
  }
})

test('the poster module is browser-safe: it imports nothing but the node-free registry', () => {
  const source = readFileSync(new URL('../../src/poster.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import\b[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
  expect(imports.every((from) => from === './services')).toBe(true)
})
