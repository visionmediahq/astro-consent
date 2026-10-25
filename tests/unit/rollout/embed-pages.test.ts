import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { embedPagesByFetch, hasConsentEmbed } from '../../../ci/rollout/verify'

const EMBED = '<div class="grid" data-consent-embed="google-maps" data-placeholder><template data-payload><iframe src="https://www.google.com/maps?q=x&output=embed"></iframe></template></div>'
// A site with `build.inlineStylesheets: 'always'` puts the banner's CSS, selectors included, in every page.
const INLINE_CSS = '<style>[data-consent-embed][data-active] [data-placeholder]{display:none}</style>'
const INLINE_SCRIPT = '<script type="module">document.querySelectorAll("[data-consent-embed]")</script>'

describe('hasConsentEmbed', () => {
  test('an element carrying the attribute is an embed', () => {
    expect(hasConsentEmbed(`<html><body>${EMBED}</body></html>`)).toBe(true)
  })

  test('the attribute without a value, and after a newline, still counts', () => {
    expect(hasConsentEmbed('<div\n  data-consent-embed data-script="https://x"></div>')).toBe(true)
  })

  test('selectors in an inlined stylesheet are not an embed', () => {
    expect(hasConsentEmbed(`<html><head>${INLINE_CSS}</head><body><main>Hej</main></body></html>`)).toBe(false)
  })

  test('the name inside an inlined script is not an embed', () => {
    expect(hasConsentEmbed(`<html><body><main>Hej</main>${INLINE_SCRIPT}</body></html>`)).toBe(false)
  })

  test('an embed next to inlined CSS and script is still found', () => {
    expect(hasConsentEmbed(`<html><head>${INLINE_CSS}</head><body>${EMBED}${INLINE_SCRIPT}</body></html>`)).toBe(true)
  })

  test('a commented-out unclosed script before an embed does not hide it', () => {
    expect(hasConsentEmbed(`<!-- <script src="/old.js"> -->${EMBED}<script>window.x = 1</script>`)).toBe(true)
  })

  test('a commented-out embed is not an embed', () => {
    expect(hasConsentEmbed('<!-- <div data-consent-embed="google-maps"></div> --><main>Hej</main>')).toBe(false)
  })

  test('a custom element whose name starts with style does not swallow the page', () => {
    expect(hasConsentEmbed(`<style-box>x</style-box>${EMBED}<style>a{}</style>`)).toBe(true)
  })

  test('a > inside an earlier quoted attribute value does not hide the attribute', () => {
    expect(hasConsentEmbed('<div title="a > b" data-consent-embed="google-maps"></div>')).toBe(true)
  })

  test('a longer attribute name is not the embed attribute', () => {
    expect(hasConsentEmbed('<div data-consent-embedded="x"></div>')).toBe(false)
  })
})

describe('embedPagesByFetch', () => {
  let server: Server
  let base = ''
  const pages: Record<string, string> = {
    '/': `<html><head>${INLINE_CSS}</head><body><main>Hem</main></body></html>`,
    '/kontakt/': `<html><head>${INLINE_CSS}</head><body>${EMBED}</body></html>`,
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = pages[req.url ?? '']
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' })
      res.end(body ?? 'not found')
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => new Promise<void>((done) => server.close(() => done())))

  test('keeps only the pages that render an embed, not every page with inlined banner CSS', async () => {
    expect(await embedPagesByFetch(base, ['/', '/kontakt/'])).toEqual(['/kontakt/'])
  })
})
