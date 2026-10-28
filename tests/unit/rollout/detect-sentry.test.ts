// detect: how a site loads Sentry's browser bundle for GlitchTip (#93). The shapes are the ones the
// client clones have: a `<script src>` from jsDelivr (`@sentry/browser@8/build/bundle.min.js`, a
// 404) or from browser.sentry-cdn.com, with or without integrity, crossorigin, defer, async, an id
// or an onload; an inline script that builds the element itself; and two sites that self-host.
import { describe, expect, test } from 'vitest'
import { detectSentry } from '../../../ci/rollout/detect/sentry'
import { globToRegExp, type SiteFiles } from '../../../ci/rollout/lib/site-files'
import { SENTRY_SRI } from '../../../ci/rollout/lib/sentry'

function memSite(files: Record<string, string>): SiteFiles {
  return {
    root: '/mem',
    list: (glob) => Object.keys(files).filter((p) => globToRegExp(glob).test(p)).sort(),
    read: (path) => {
      const text = files[path]
      if (text === undefined) throw new Error(`no such file: ${path}`)
      return text
    },
    exists: (path) => path in files,
  }
}

const JSDELIVR = 'https://cdn.jsdelivr.net/npm/@sentry/browser@8/build/bundle.min.js'
const CDN = 'https://browser.sentry-cdn.com/8.55.0/bundle.min.js'
const FM = '---\nconst glitchtipDsn = import.meta.env.PUBLIC_GLITCHTIP_DSN\n---\n'
const INIT = `<script is:inline define:vars={{ glitchtipDsn }}>
          if (typeof Sentry !== 'undefined') {
            Sentry.init({ dsn: glitchtipDsn, tracesSampleRate: 0.1 })
          }
        </script>`
/** The starter's layout with `block` where the GlitchTip block goes. */
const layout = (block: string, fm = FM) => `${fm}<html lang="sv">
  <head>
    <!-- GlitchTip error tracking — active when PUBLIC_GLITCHTIP_DSN is set -->
    {glitchtipDsn && (
      <>
        ${block}
        ${INIT}
      </>
    )}
  </head>
  <body><slot /></body>
</html>
`
const STARTER = `<script
          is:inline
          src="${JSDELIVR}"
          crossorigin="anonymous"
        ></script>`
const site = (block: string, extra: Record<string, string> = {}) => memSite({ 'src/layouts/Base.astro': layout(block), ...extra })
const cut = (text: string, c: { start: number; end: number }) => text.slice(c.start, c.end)

describe('detectSentry: the CDN loads wire can self-host', () => {
  test("the starter's jsDelivr element: src and crossorigin, multi-line", () => {
    const text = layout(STARTER)
    const info = detectSentry(memSite({ 'src/layouts/Base.astro': text }))
    expect(info.status).toBe('wire')
    expect(info.reasons).toEqual([])
    expect(info.loaders).toHaveLength(1)
    const l = info.loaders[0]!
    expect(l).toMatchObject({ file: 'src/layouts/Base.astro', cdn: 'jsdelivr', version: '8', url: JSDELIVR, kind: 'element' })
    expect(text.split('\n')[l.line - 1]).toContain(JSDELIVR)
    expect(cut(text, l.src)).toBe(JSDELIVR)
    expect(l.cuts.map((c) => cut(text, c))).toEqual(['\n          crossorigin="anonymous"'])
    expect(l.cuts.map((c) => c.what)).toEqual(['crossorigin'])
  })

  test('Sentry CDN on one line with defer, integrity and crossorigin: both attributes are cut, defer stays', () => {
    const tag = `<script is:inline defer src="${CDN}" integrity="${SENTRY_SRI}" crossorigin="anonymous"></script>`
    const text = layout(tag)
    const info = detectSentry(memSite({ 'src/layouts/Base.astro': text }))
    expect(info.status).toBe('wire')
    const l = info.loaders[0]!
    expect(l).toMatchObject({ cdn: 'sentry-cdn', version: '8.55.0', kind: 'element' })
    expect(l.cuts.map((c) => cut(text, c))).toEqual([` integrity="${SENTRY_SRI}"`, ' crossorigin="anonymous"'])
  })

  test('async, an id, data-dsn and an onload stay as they are; a self-closing tag is read too', () => {
    const tag = `<script is:inline async id="glitchtip-sdk" src="${CDN}" crossorigin="anonymous" data-dsn={glitchtipDsn} onload="window.Sentry && Sentry.init({ dsn: this.dataset.dsn })" />`
    const text = layout(tag)
    const info = detectSentry(memSite({ 'src/layouts/Base.astro': text }))
    expect(info.status).toBe('wire')
    expect(info.loaders[0]!.cuts.map((c) => c.what)).toEqual(['crossorigin'])
  })

  test('jsDelivr pinned to 8.55.2 with an integrity', () => {
    const url = 'https://cdn.jsdelivr.net/npm/@sentry/browser@8.55.2/build/bundle.min.js'
    const info = detectSentry(site(`<script is:inline src="${url}" integrity="sha384-x" crossorigin="anonymous"></script>`))
    expect(info.status).toBe('wire')
    expect(info.loaders[0]).toMatchObject({ cdn: 'jsdelivr', version: '8.55.2' })
  })

  test('an inline script that builds the element: the src literal, and the integrity and crossOrigin lines', () => {
    const block = `<script is:inline define:vars={{ glitchtipDsn }}>
          addEventListener('load', () => {
            const script = document.createElement('script')
            script.src = '${CDN}'
            script.integrity =
              '${SENTRY_SRI}'
            script.crossOrigin = 'anonymous'
            script.onload = () => Sentry.init({ dsn: glitchtipDsn })
            document.head.appendChild(script)
          })
        </script>`
    const text = memSite({ 'src/layouts/Base.astro': `${FM}<html><head>{glitchtipDsn && (\n  ${block}\n)}</head><body /></html>\n` })
    const info = detectSentry(text)
    expect(info.status).toBe('wire')
    const l = info.loaders[0]!
    const source = text.read('src/layouts/Base.astro')
    expect(l.kind).toBe('script')
    expect(cut(source, l.src)).toBe(CDN)
    expect(l.cuts.map((c) => cut(source, c))).toEqual([
      `            script.integrity =\n              '${SENTRY_SRI}'\n`,
      "            script.crossOrigin = 'anonymous'\n",
    ])
  })

  test('mentions in an HTML comment or a JS comment are not loads', () => {
    const block = `<!-- was ${JSDELIVR}, a 404 -->
        {/*
          The template pointed at cdn.jsdelivr.net/npm/@sentry/browser@8/build/
          bundle.min.js, which 404s.
        */}
        <script is:inline src="${CDN}"></script>`
    const fm = `---\n// the starter had ${JSDELIVR}\nconst glitchtipDsn = import.meta.env.PUBLIC_GLITCHTIP_DSN\n---\n`
    const info = detectSentry(memSite({ 'src/layouts/Base.astro': layout(block, fm) }))
    expect(info.status).toBe('wire')
    expect(info.loaders).toHaveLength(1)
  })

  test('a bare origin in a CSP is not a load', () => {
    const info = detectSentry(
      site(STARTER, { 'public/_headers': "/*\n  Content-Security-Policy: script-src 'self' https://browser.sentry-cdn.com https://cdn.jsdelivr.net\n" }),
    )
    expect(info.status).toBe('wire')
  })

  test('two layouts each with the starter element: both are loaders', () => {
    const info = detectSentry(memSite({ 'src/layouts/Base.astro': layout(STARTER), 'src/layouts/Landing.astro': layout(STARTER) }))
    expect(info.status).toBe('wire')
    expect(info.loaders.map((l) => l.file)).toEqual(['src/layouts/Base.astro', 'src/layouts/Landing.astro'])
  })
})

describe('detectSentry: none and self-hosted', () => {
  test('no Sentry at all', () => {
    expect(detectSentry(memSite({ 'src/layouts/Base.astro': '<html><head></head><body /></html>\n' }))).toEqual({ status: 'none', loaders: [], selfHosted: [], reasons: [], hints: [] })
  })

  test('a local copy (site 1292225111): self-hosted, and the bundle itself is not a mention', () => {
    const info = detectSentry(
      site('<script is:inline defer src="/js/sentry-8.55.0.min.js"></script>', {
        'public/js/sentry-8.55.0.min.js': '/*! @sentry/browser 8.55.0 (abc) | https://github.com/getsentry/sentry-javascript */\nvar a="https://browser.sentry-cdn.com/8.55.0/x.js"',
      }),
    )
    expect(info).toEqual({ status: 'self-hosted', loaders: [], selfHosted: ['/js/sentry-8.55.0.min.js'], reasons: [], hints: [] })
  })

  test('the npm package bundled by Vite is not a CDN load', () => {
    expect(detectSentry(site("<script>import('@sentry/browser').then((S) => S.init({}))</script>")).status).toBe('none')
  })
})

describe('detectSentry: needs-human', () => {
  test('a src from a frontmatter const', () => {
    const fm = `---\nconst SDK = '${CDN}'\nconst glitchtipDsn = import.meta.env.PUBLIC_GLITCHTIP_DSN\n---\n`
    const info = detectSentry(memSite({ 'src/layouts/Base.astro': layout('<script is:inline src={SDK}></script>', fm) }))
    expect(info.status).toBe('needs-human')
    expect(info.reasons).toEqual([`src/layouts/Base.astro:2 names ${CDN.replace('https://', '')}…, not as a <script src> or x.src = '…' the tool can rewrite`])
  })

  test('another major', () => {
    const info = detectSentry(site('<script is:inline src="https://browser.sentry-cdn.com/7.120.0/bundle.min.js"></script>'))
    expect(info.status).toBe('needs-human')
    expect(info.reasons[0]).toMatch(/major 7/)
  })

  test("another file than the bundle: Sentry's tracing bundle or the Loader script", () => {
    expect(detectSentry(site('<script is:inline src="https://browser.sentry-cdn.com/8.55.0/bundle.tracing.min.js"></script>')).status).toBe('needs-human')
    expect(detectSentry(site('<script is:inline src="https://js.sentry-cdn.com/abc123.min.js"></script>')).status).toBe('needs-human')
  })

  test('an integrity from an expression', () => {
    const info = detectSentry(site(`<script is:inline src="${CDN}" integrity={sri}></script>`))
    expect(info.status).toBe('needs-human')
  })

  test('a loader in a plain HTML file under public/', () => {
    const info = detectSentry(memSite({ 'public/offline.html': `<script src="${CDN}"></script>\n` }))
    expect(info.status).toBe('needs-human')
    expect(info.reasons[0]).toMatch(/^public\/offline\.html:1 /)
  })

  test('a CDN load and a local copy at once', () => {
    const info = detectSentry(site(`<script is:inline src="${CDN}"></script><script is:inline src="/vendor/sentry.min.js"></script>`))
    expect(info.status).toBe('needs-human')
    expect(info.reasons).toEqual(['loads Sentry from a CDN and from /vendor/sentry.min.js'])
  })

  test('the URL somewhere else in an inline script than x.src', () => {
    const info = detectSentry(site(`<script is:inline>fetch('${CDN}')</script>`))
    expect(info.status).toBe('needs-human')
  })

  test('a file that does not parse but names the CDN', () => {
    const info = detectSentry(memSite({ 'src/layouts/Base.astro': `<html><head><script src="${CDN}"></script>{</head></html>\n` }))
    expect(info.status).toBe('needs-human')
  })
})

describe('detectSentry: after wire', () => {
  test('an inline script that adds a local copy is self-hosted too', () => {
    const block = "<script is:inline>const s = document.createElement('script'); s.src = '/js/sentry-8.55.2.min.js'; document.head.appendChild(s)</script>"
    expect(detectSentry(site(block))).toEqual({ status: 'self-hosted', loaders: [], selfHosted: ['/js/sentry-8.55.2.min.js'], reasons: [], hints: [] })
  })
})

describe('detectSentry: resource hints to the CDNs (review of #126)', () => {
  test('a preconnect to Sentry\'s CDN inside the GlitchTip block (site 1334143636) goes with the loader, as whole lines', () => {
    const block = `<link rel="preconnect" href="https://browser.sentry-cdn.com" crossorigin="anonymous" />
        <script is:inline defer src="${CDN}" crossorigin="anonymous"></script>`
    const text = layout(block)
    const info = detectSentry(memSite({ 'src/layouts/Base.astro': text }))
    expect(info.status).toBe('wire')
    expect(info.hints).toHaveLength(1)
    expect(info.hints[0]).toMatchObject({ file: 'src/layouts/Base.astro', host: 'browser.sentry-cdn.com', rel: 'preconnect' })
    expect(cut(text, info.hints[0]!)).toBe('        <link rel="preconnect" href="https://browser.sentry-cdn.com" crossorigin="anonymous" />\n')
  })

  test('a dns-prefetch to jsDelivr outside the block (a client site) goes too, when nothing else comes from jsDelivr', () => {
    const fm = FM
    const text = `${fm}<html lang="sv">\n  <head>\n    <link rel="dns-prefetch" href="https://cdn.jsdelivr.net" />\n    {glitchtipDsn && (\n      <>\n        ${STARTER}\n      </>\n    )}\n  </head>\n  <body />\n</html>\n`
    const info = detectSentry(memSite({ 'src/layouts/Base.astro': text }))
    expect(info.status).toBe('wire')
    expect(info.hints.map((h) => [h.host, h.rel, cut(text, h)])).toEqual([['cdn.jsdelivr.net', 'dns-prefetch', '    <link rel="dns-prefetch" href="https://cdn.jsdelivr.net" />\n']])
  })

  test('a jsDelivr hint stays when the site loads something else from jsDelivr', () => {
    const text = layout(`<link rel="preconnect" href="https://cdn.jsdelivr.net" /><script is:inline src="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js"></script>\n        ${STARTER}`)
    expect(detectSentry(memSite({ 'src/layouts/Base.astro': text })).hints).toEqual([])
  })

  test('a preload of the bundle, or any other link to Sentry\'s CDN, needs a look', () => {
    expect(detectSentry(site(`<link rel="preload" as="script" href="${CDN}" />${STARTER}`)).status).toBe('needs-human')
    expect(detectSentry(site(`<link rel="stylesheet" href="https://browser.sentry-cdn.com" />${STARTER}`)).status).toBe('needs-human')
  })

  test('a preconnect to Sentry\'s CDN with no CDN load (left over, or alone) needs a look', () => {
    const left = detectSentry(site(`<link rel="preconnect" href="https://browser.sentry-cdn.com" /><script is:inline src="/js/sentry-8.55.2.min.js"></script>`))
    expect(left.status).toBe('needs-human')
    expect(left.reasons[0]).toMatch(/preconnect to browser\.sentry-cdn\.com/)
    expect(detectSentry(memSite({ 'src/layouts/Base.astro': '<html><head><link rel="dns-prefetch" href="//browser.sentry-cdn.com" /></head></html>\n' })).status).toBe('needs-human')
  })

  test('any other element with a Sentry CDN URL as an attribute needs a look; a CSP meta does not', () => {
    expect(detectSentry(site(`<img src="https://browser.sentry-cdn.com" alt="" />${STARTER}`)).status).toBe('needs-human')
    const csp = `<meta http-equiv="Content-Security-Policy" content="script-src 'self' https://browser.sentry-cdn.com" />${STARTER}`
    expect(detectSentry(site(csp)).status).toBe('wire')
  })
})

describe('detectSentry: review of #126', () => {
  test('a CDN <script src> without is:inline needs a look: Astro would bundle the local src', () => {
    const info = detectSentry(site(`<script src="${CDN}"></script>`))
    expect(info.status).toBe('needs-human')
    expect(info.reasons[0]).toMatch(/without is:inline/)
  })

  test('initBeforeBundle: an async or defer bundle with the init in an inline script that runs at once', () => {
    const init = (s: string) => detectSentry(site(s)).loaders[0]!.initBeforeBundle
    // The starter: synchronous bundle, then the init.
    expect(init(STARTER)).toBe(false)
    expect(init(`<script is:inline async src="${CDN}"></script>`)).toBe(true)
    expect(init(`<script is:inline defer src="${CDN}"></script>`)).toBe(true)
    // onload on the bundle, or an init that waits for load (or, for defer, DOMContentLoaded): after the bundle.
    expect(init(`<script is:inline async src="${CDN}" onload="Sentry.init({})"></script>`)).toBe(false)
    const waits = (event: string, attr: string) =>
      detectSentry(memSite({ 'src/layouts/Base.astro': `${FM}<html><head><script is:inline ${attr} src="${CDN}"></script><script is:inline define:vars={{ glitchtipDsn }}>addEventListener('${event}', () => Sentry.init({ dsn: glitchtipDsn }))</script></head></html>\n` })).loaders[0]!.initBeforeBundle
    expect(waits('load', 'async')).toBe(false)
    expect(waits('DOMContentLoaded', 'defer')).toBe(false)
    expect(waits('DOMContentLoaded', 'async')).toBe(true)
  })
})
