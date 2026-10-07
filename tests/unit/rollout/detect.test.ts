import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { classify, type Findings } from '../../../ci/rollout/detect/classify'
import { detect } from '../../../ci/rollout/detect/index'
import { detectScripts } from '../../../ci/rollout/detect/scripts'
import { aliasedAstroImports } from '../../../ci/rollout/lib/site-imports'
import { diskSite, fixtureSite } from '../../../ci/rollout/lib/site-files'
import type { IframeInfo } from '../../../ci/rollout/types'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const pilot = (site: string, side: 'before' | 'merged' = 'before') => fixtureSite(join(FIXTURES, site, side))

const dirs: string[] = []
function inline(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'detect-'))
  dirs.push(dir)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return diskSite(dir)
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const page = (body: string, frontmatter = '') =>
  `${frontmatter ? `---\n${frontmatter}\n---\n` : ''}<html><head>${body}</head><body><main /></body></html>\n`

describe('detectScripts: trackers', () => {
  test('a gtag.js script tag is google-analytics (via matchesRegistry)', () => {
    const r = detectScripts(
      inline({ 'src/layouts/Base.astro': page('<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>') }),
    )
    expect(r.trackers).toEqual(['google-analytics'])
  })

  test('a gtag.js src built in an expression from a frontmatter id is listed', () => {
    const r = detectScripts(
      inline({
        'src/layouts/Base.astro': page(
          '<script is:inline async src={`https://www.googletagmanager.com/gtag/js?id=${id}`}></script>',
          "const id = 'G-ABC123'",
        ),
      }),
    )
    expect(r.trackers).toEqual(['google-analytics'])
  })

  test('an inline GTM snippet is listed', () => {
    const gtm =
      "<script is:inline>(function(w,d,s,l,i){var j=d.createElement(s);j.src='//www.googletagmanager.com/gtm.js?id='+i;})(window,document,'script','dataLayer','GTM-XYZ')</script>"
    expect(detectScripts(inline({ 'src/layouts/Base.astro': page(gtm) })).trackers).toEqual(['google-analytics'])
  })

  test("an inline Meta pixel (fbq('init')) is listed", () => {
    const r = detectScripts(inline({ 'src/layouts/Base.astro': page("<script is:inline>fbq('init', '1234567890'); fbq('track', 'PageView')</script>") }))
    expect(r.trackers).toEqual(['meta-pixel'])
  })

  test('a tracker in a non-.astro file under src/ or public/ is listed', () => {
    const r = detectScripts(
      inline({
        'src/layouts/Base.astro': page('<script src="/analytics.js"></script>'),
        'public/analytics.js': "var s=document.createElement('script');s.src='https://connect.facebook.net/en_US/fbevents.js'\n",
      }),
    )
    expect(r.trackers).toEqual(['meta-pixel'])
  })

  test('a frontmatter import of an analytics package or component is listed', () => {
    const r = detectScripts(
      inline({
        'src/layouts/Base.astro': page('<GoogleAnalytics id="G-ABC123" />', "import { GoogleAnalytics } from 'astro-google-analytics'"),
      }),
    )
    expect(r.trackers).toEqual(['google-analytics'])
  })

  test('an analytics integration in astro.config or a package.json dependency is listed', () => {
    expect(
      detectScripts(
        inline({
          'astro.config.ts': "import { defineConfig } from 'astro/config'\nimport gtm from '@example/astro-gtm'\nexport default defineConfig({ integrations: [gtm()] })\n",
        }),
      ).trackers,
    ).toEqual(['google-analytics'])
    expect(detectScripts(inline({ 'package.json': JSON.stringify({ dependencies: { 'astro-meta-pixel': '^1.0.0' } }) })).trackers).toEqual([
      'meta-pixel',
    ])
  })

  test('a Google Maps JavaScript API script is listed: the batch only converts map iframes', () => {
    const r = detectScripts(inline({ 'src/components/Map.astro': '<div id="map" />\n<script src="https://maps.googleapis.com/maps/api/js?key=abc"></script>\n' }))
    expect(r.trackers).toEqual(['google-maps'])
  })

  test('Facebook page links, JSON-LD sameAs/hasMap and Umami are not trackers', () => {
    const r = detectScripts(
      inline({
        'src/layouts/Base.astro': page(
          `<script type="application/ld+json">{"sameAs":["https://www.facebook.com/traforadling"],"hasMap":"https://maps.google.com/?cid=123"}</script>
<script is:inline async src={umamiScriptUrl} data-website-id={umamiWebsiteId}></script>`,
          'const umamiScriptUrl = import.meta.env.UMAMI_SCRIPT_URL\nconst umamiWebsiteId = import.meta.env.UMAMI_WEBSITE_ID',
        ),
        'src/components/Footer.astro': '<footer><a href="https://www.facebook.com/traforadling" data-umami-event="facebook">Facebook</a></footer>\n',
      }),
    )
    expect(r.trackers).toEqual([])
  })
})

describe('detectScripts: banners, reCAPTCHA, already wired', () => {
  test.each([
    ['Cookiebot', '<script id="Cookiebot" src="https://consent.cookiebot.com/uc.js" data-cbid="x"></script>', 'cookiebot'],
    ['Elfsight', '<script src="https://static.elfsight.com/platform/platform.js" async></script>', 'elfsight'],
    ['CookieYes', '<script src="https://cdn-cookieyes.com/client_data/abc/script.js"></script>', 'cookieyes'],
  ])('%s is an existing banner', (_name, tag, expected) => {
    expect(detectScripts(inline({ 'src/layouts/Base.astro': page(tag) })).banners).toEqual([expected])
  })

  test('a home-made localStorage consent gate is an existing banner', () => {
    const r = detectScripts(
      inline({
        'src/components/KontaktMap.astro':
          "<iframe id=\"m\" title=\"Karta\"></iframe>\n<script>\nif (localStorage.getItem('maps-consent') === '1') load()\n</script>\n",
      }),
    )
    expect(r.banners).toEqual(["home-made gate: localStorage 'maps-consent' in src/components/KontaktMap.astro"])
  })

  test('localStorage that is not about consent is not a banner', () => {
    const r = detectScripts(inline({ 'src/components/Theme.astro': "<script>localStorage.setItem('theme', 'dark')</script>\n" }))
    expect(r.banners).toEqual([])
  })

  test('reCAPTCHA is detected from recaptcha/api.js or PUBLIC_RECAPTCHA_SITE_KEY', () => {
    expect(detectScripts(inline({ 'src/layouts/Base.astro': page('<script src="https://www.google.com/recaptcha/api.js?render=x"></script>') })).recaptcha).toBe(
      true,
    )
    expect(
      detectScripts(inline({ 'src/layouts/Base.astro': page('', 'const key = import.meta.env.PUBLIC_RECAPTCHA_SITE_KEY') })).recaptcha,
    ).toBe(true)
    expect(detectScripts(inline({ 'src/layouts/Base.astro': page('') })).recaptcha).toBe(false)
  })

  test('reCAPTCHA is not a tracker', () => {
    const r = detectScripts(inline({ 'src/layouts/Base.astro': page('<script src="https://www.google.com/recaptcha/api.js?render=x"></script>') }))
    expect(r.trackers).toEqual([])
  })

  test("alreadyWired: the package in package.json's dependencies", () => {
    const r = detectScripts(
      inline({ 'package.json': JSON.stringify({ dependencies: { '@visionmediahq/astro-consent': 'github:visionmediahq/astro-consent#semver:^1.0.0' } }) }),
    )
    expect(r.alreadyWired).toEqual(['dependency'])
  })

  test('alreadyWired: a merged pilot site shows every piece of wiring', () => {
    expect(detectScripts(pilot('a-tak', 'merged')).alreadyWired).toEqual(['dependency', 'config', 'css', 'components', 'privacy.json'])
    expect(detectScripts(pilot('a-tak')).alreadyWired).toEqual([])
  })

  test('a file that does not parse is recorded', () => {
    const r = detectScripts(inline({ 'src/pages/broken.astro': '---\nconst a = 1\n---\n<div>{</div>\n' }))
    expect(r.parseErrors.map((e) => e.file)).toEqual(['src/pages/broken.astro'])
  })
})

describe('aliasedAstroImports', () => {
  test('@/ and ~/ imports of .astro files, and tsconfig paths keys, are listed; relative and package imports are not', () => {
    const r = aliasedAstroImports(
      inline({
        'tsconfig.json': '{\n  // comment\n  "compilerOptions": { "paths": { "@components/*": ["src/components/*"], "$layout": ["src/layouts/Base.astro"] } }\n}\n',
        'src/pages/index.astro': `---
import Base from '$layout'
import Footer from '@/components/Footer.astro'
import Card from '~/components/Card.astro'
import Hero from '@components/Hero.astro'
import Rel from '../components/Rel.astro'
import Icon from '@lucide/astro/icons/x'
import data from '@/data/site.json'
---
<Base />
`,
      }),
    )
    expect(r).toEqual([
      { file: 'src/pages/index.astro', specifier: '$layout' },
      { file: 'src/pages/index.astro', specifier: '@/components/Footer.astro' },
      { file: 'src/pages/index.astro', specifier: '~/components/Card.astro' },
      { file: 'src/pages/index.astro', specifier: '@components/Hero.astro' },
    ])
  })
})

const MAPS_SRC = 'https://www.google.com/maps/embed?pb=!1m18!1m12!4v1712345678901'

function frame(over: Partial<IframeInfo>): IframeInfo {
  return {
    file: 'src/components/Map.astro',
    start: 0,
    end: 10,
    srcKind: 'literal',
    src: MAPS_SRC,
    host: 'www.google.com',
    service: 'google-maps',
    title: 'Karta',
    classes: null,
    height: null,
    style: null,
    ...over,
  }
}

/** A site the batch can wire as notice. */
function clean(over: Partial<Findings> = {}): Findings {
  return {
    site: 'example',
    domains: ['example.se'],
    astro: { major: 6, output: 'server' },
    config: { path: 'astro.config.ts', hasIntegrations: true, hasTailwindVite: true, isDefineConfigObject: true },
    css: { entry: 'src/styles/global.css', tailwindMajor: 4, daisyuiMajor: 5, primaries: [] },
    layouts: [{ file: 'src/layouts/Base.astro', pages: ['src/pages/index.astro'], footerRef: null }],
    footers: [],
    footerless: [],
    policyPage: null,
    iframes: [],
    trackers: [],
    banners: [],
    recaptcha: false,
    inventedMaps: [],
    alreadyWired: [],
    parseErrors: [],
    aliasImports: [],
    multiFooterPages: [],
    ...over,
  }
}

describe('classify', () => {
  test('a clean site with no iframes is notice', () => {
    expect(classify(clean())).toEqual({ classification: 'notice', reasons: [] })
  })

  test('a resolved Google Maps iframe makes the site maps', () => {
    expect(classify(clean({ iframes: [frame({})] }))).toEqual({ classification: 'maps', reasons: [] })
    expect(classify(clean({ iframes: [frame({ srcKind: 'data-file', dataPath: 'src/data/k.json' })] }))).toEqual({
      classification: 'maps',
      reasons: [],
    })
  })

  test('an invented map alone keeps the site maps with no reasons', () => {
    expect(classify(clean({ iframes: [frame({})], inventedMaps: [MAPS_SRC] }))).toEqual({ classification: 'maps', reasons: [] })
  })

  test('reCAPTCHA and alreadyWired add no reasons', () => {
    expect(classify(clean({ recaptcha: true, alreadyWired: ['dependency'] }))).toEqual({ classification: 'notice', reasons: [] })
  })

  test('own-domain iframes add nothing', () => {
    const own = [
      frame({ src: 'https://example.se/widget', host: 'example.se', service: null }),
      frame({ src: 'https://www.example.se/widget', host: 'www.example.se', service: null }),
      frame({ src: '/widget.html', host: 'example.se', service: null }),
    ]
    expect(classify(clean({ iframes: own }))).toEqual({ classification: 'notice', reasons: [] })
  })

  test('a relative iframe src with no known domain is still the site itself', () => {
    expect(classify(clean({ domains: [], iframes: [frame({ src: '/widget.html', host: null, service: null })] }))).toEqual({
      classification: 'notice',
      reasons: [],
    })
  })

  test.each<[string, Partial<Findings>, string]>([
    ['unresolved src', { iframes: [frame({ srcKind: 'unresolved', src: null })] }, 'unresolved iframe src in src/components/Map.astro'],
    [
      'unresolved src whose hint says Maps is still unresolved',
      { iframes: [frame({ srcKind: 'unresolved', src: null, host: 'www.google.com', service: 'google-maps' })] },
      'unresolved iframe src in src/components/Map.astro',
    ],
    [
      'unregistered host',
      { iframes: [frame({ src: 'https://calendar.google.com/calendar/embed?x', host: 'calendar.google.com', service: null })] },
      'unregistered iframe host calendar.google.com',
    ],
    [
      'resolved iframe with no host that is not relative',
      { iframes: [frame({ src: 'https://', host: null, service: null })] },
      'unknown iframe host in src/components/Map.astro',
    ],
    [
      'a registry service other than Maps in an iframe',
      { iframes: [frame({ src: 'https://www.googletagmanager.com/ns.html?id=GTM-X', host: 'www.googletagmanager.com', service: 'google-analytics' })] },
      'iframe service google-analytics is not wired by this batch',
    ],
    ['existing banner', { banners: ['cookiebot'] }, 'existing banner: cookiebot'],
    ['GA present', { trackers: ['google-analytics'] }, 'tracker google-analytics: the batch wires notice and maps only'],
    ['tailwind 3', { css: { entry: 'src/styles/global.css', tailwindMajor: 3, daisyuiMajor: 5, primaries: [] } }, 'tailwind 3: @source needs Tailwind 4'],
    ['daisyui 4', { css: { entry: 'src/styles/global.css', tailwindMajor: 4, daisyuiMajor: 4, primaries: [] } }, 'daisyui 4: the components need daisyUI 5'],
    [
      'unknown tailwind and daisyui versions',
      { css: { entry: 'src/styles/global.css', tailwindMajor: null, daisyuiMajor: null, primaries: [] } },
      'unknown versions: tailwindcss, daisyui',
    ],
    ['unknown astro version', { astro: { major: 0, output: 'static' } }, 'unknown versions: astro'],
    ['astro 5', { astro: { major: 5, output: 'static' } }, 'astro 5: the package supports Astro 6 and 7'],
    ['no CSS entry', { css: { entry: null, tailwindMajor: 4, daisyuiMajor: 5, primaries: [] } }, 'no CSS entry with @import "tailwindcss"'],
    [
      'two layouts',
      {
        layouts: [
          { file: 'src/layouts/A.astro', pages: ['src/pages/a.astro'], footerRef: null },
          { file: 'src/layouts/B.astro', pages: ['src/pages/b.astro'], footerRef: null },
        ],
      },
      'several layouts and no single shared one: src/layouts/A.astro, src/layouts/B.astro',
    ],
    ['no layout', { layouts: [{ file: 'src/layouts/Unused.astro', pages: [], footerRef: null }] }, 'no layout renders <html>/<body> for any page'],
    [
      'footer ambiguous',
      { multiFooterPages: [{ page: 'src/pages/index.astro', footers: 2 }] },
      'footer ambiguous: src/pages/index.astro renders 2 footers',
    ],
    [
      'config shape',
      { config: { path: 'astro.config.mjs', hasIntegrations: false, hasTailwindVite: true, isDefineConfigObject: false } },
      'config shape: astro.config.mjs has no integrations and is not defineConfig({…})',
    ],
    ['no config', { config: { path: '', hasIntegrations: false, hasTailwindVite: false, isDefineConfigObject: false } }, 'no astro.config file'],
    [
      'parse error',
      { parseErrors: [{ file: 'src/pages/x.astro', message: 'Astro parse error: boom (1:2)' }] },
      'parse error in src/pages/x.astro: Astro parse error: boom (1:2)',
    ],
    [
      'path alias',
      { aliasImports: [{ file: 'src/pages/index.astro', specifier: '@/components/Footer.astro' }] },
      'imports through path aliases are not followed: @/components/Footer.astro',
    ],
  ])('needs-human, one reason: %s', (_name, over, reason) => {
    expect(classify(clean(over))).toEqual({ classification: 'needs-human', reasons: [reason] })
  })

  test('a Maps iframe next to a needs-human reason is needs-human', () => {
    expect(classify(clean({ iframes: [frame({})], trackers: ['google-analytics'] })).classification).toBe('needs-human')
  })

  test('parse errors are deduplicated by file (each detector reports its own)', () => {
    const e = { file: 'src/pages/x.astro', message: 'Astro parse error: boom' }
    expect(classify(clean({ parseErrors: [e, e, { ...e, message: 'other' }] })).reasons).toEqual(['parse error in src/pages/x.astro: Astro parse error: boom'])
  })

  test('the same reason from several iframes is listed once', () => {
    const u = frame({ srcKind: 'unresolved', src: null })
    expect(classify(clean({ iframes: [u, { ...u, start: 20 }] })).reasons).toEqual(['unresolved iframe src in src/components/Map.astro'])
  })
})

describe('detect', () => {
  test('stores site and domains and classifies; a parse error anywhere makes it needs-human', () => {
    const r = detect(
      inline({
        'astro.config.ts': "import { defineConfig } from 'astro/config'\nexport default defineConfig({ integrations: [] })\n",
        'src/pages/broken.astro': '<div>{</div>\n',
      }),
      'example',
      ['example.se'],
    )
    expect(r.site).toBe('example')
    expect(r.domains).toEqual(['example.se'])
    expect(r.classification).toBe('needs-human')
    expect(r.reasons.filter((x) => x.startsWith('parse error in src/pages/broken.astro: '))).toHaveLength(1)
  })

  test.each([
    ['munkforstradgardstjanst', 'notice'],
    ['nhrk', 'needs-human'],
    ['a-tak', 'needs-human'],
    ['vasshallakatthotell', 'maps'],
    ['aspomad', 'maps'],
    ['domeijstapetserarverkstad', 'maps'],
    ['traforadling', 'maps'],
  ])('pilot %s: %s, matching the committed snapshot', (site, classification) => {
    const r = detect(pilot(site), site, [`${site}.se`])
    expect(r.classification).toBe(classification)
    expect(r).toMatchSnapshot()
  })
})
