import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { classify, type Findings } from '../../../ci/rollout/detect/classify'
import { detect } from '../../../ci/rollout/detect/index'
import { detectScripts } from '../../../ci/rollout/detect/scripts'
import { aliasedAstroImports } from '../../../ci/rollout/lib/site-imports'
import { diskSite, fixtureSite, globToRegExp, type SiteFiles } from '../../../ci/rollout/lib/site-files'
import { normaliseReport, servicesOf } from '../../../ci/rollout/lib/report'
import type { IframeInfo, WidgetInfo } from '../../../ci/rollout/types'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const pilot = (site: string, side: 'before' | 'merged' = 'before') => fixtureSite(join(FIXTURES, site, side))

/** `base` with `extra` files added (or replaced), in memory. */
function withFiles(base: SiteFiles, extra: Record<string, string>): SiteFiles {
  return {
    root: base.root,
    list: (glob) => [...new Set([...base.list(glob), ...Object.keys(extra).filter((p) => globToRegExp(glob).test(p))])].sort(),
    read: (path) => extra[path] ?? base.read(path),
    exists: (path) => path in extra || base.exists(path),
  }
}

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

describe('detectScripts: Google Maps loads outside an iframe', () => {
  test('a Google Calendar embed URL in frontmatter data is no tracker: detectIframes reports it', () => {
    const fm = "const cals = [{ src: 'https://calendar.google.com/calendar/embed?src=x&ctz=Europe%2FStockholm' }]"
    const r = detectScripts(inline({ 'src/pages/kalendrar.astro': page('', fm) }))
    expect(r.trackers).toEqual([])
  })

  test('a Static Maps <img> is tracker google-maps', () => {
    const r = detectScripts(inline({ 'src/components/Map.astro': '<img src="https://maps.googleapis.com/maps/api/staticmap?center=57.1,12.2&zoom=14" alt="Karta" />\n' }))
    expect(r.trackers).toEqual(['google-maps'])
  })

  test('a .ts file that injects the Maps JavaScript API is tracker google-maps', () => {
    const r = detectScripts(
      inline({ 'src/scripts/map.ts': "const s = document.createElement('script')\ns.src = 'https://maps.googleapis.com/maps/api/js?key=abc'\ndocument.head.append(s)\n" }),
    )
    expect(r.trackers).toEqual(['google-maps'])
  })

  test('@googlemaps/js-api-loader in package.json or an import is tracker google-maps', () => {
    expect(detectScripts(inline({ 'package.json': JSON.stringify({ dependencies: { '@googlemaps/js-api-loader': '^1.16.0' } }) })).trackers).toEqual([
      'google-maps',
    ])
    expect(
      detectScripts(inline({ 'src/components/Map.astro': "---\nimport { Loader } from '@googlemaps/js-api-loader'\n---\n<div id=\"map\" />\n" })).trackers,
    ).toEqual(['google-maps'])
  })

  test('a <link> to maps.gstatic.com is tracker google-maps', () => {
    const r = detectScripts(inline({ 'src/layouts/Base.astro': page('<link rel="preconnect" href="https://maps.gstatic.com" />') }))
    expect(r.trackers).toEqual(['google-maps'])
  })

  test('a "Hitta hit" link to google.com/maps and a maps.google. link stay clean', () => {
    const r = detectScripts(
      inline({
        'src/components/Contact.astro':
          '<a href="https://www.google.com/maps/place/Annebergsv%C3%A4gen+12">Hitta hit</a>\n<a href="https://maps.google.com/?q=Varberg">Karta</a>\n',
      }),
    )
    expect(r.trackers).toEqual([])
  })

  test('a map iframe src is not also a tracker, even on maps.googleapis.com', () => {
    const r = detectScripts(
      inline({
        'src/components/Map.astro': '<iframe title="Karta" src="https://www.google.com/maps/embed/v1/place?key=abc&q=Varberg"></iframe>\n<iframe title="Karta" src="https://maps.googleapis.com/maps/embed?x"></iframe>\n',
      }),
    )
    expect(r.trackers).toEqual([])
  })
})

// Two home-made click-to-load maps, copied unchanged from the sites' main before they were wired:
// arjangs-elmontage src/components/KontaktContent.astro at 6337541aa (embed URL in a `data-map-src`
// template literal; detect classed the site notice) and stromsbacka src/components/KontaktMap.astro
// at 10315351d (embed URL string in the <script>; detect said `tracker google-maps`).
const ARJANGS = readFileSync(join(FIXTURES, 'map-script-arjangs-elmontage.astro.txt'), 'utf8')
const STROMSBACKA = readFileSync(join(FIXTURES, 'map-script-stromsbacka.astro.txt'), 'utf8')
// The same, with the URL reaching `data-src` through a variable: tranemoglas src/pages/kontakt.astro
// at 5bd19c266 (frontmatter `const mapSrc = `…&output=embed``), and gron-kontor
// src/pages/kontakta-oss.astro + src/data/company.ts at 9debb06c4 (imported `mapsEmbedUrl`, a `+`
// concatenation with `&output=embed` in its own literal). Both were classed notice.
const TRANEMOGLAS = readFileSync(join(FIXTURES, 'map-script-tranemoglas.astro.txt'), 'utf8')
const GRON_PAGE = readFileSync(join(FIXTURES, 'map-script-gron-kontor.astro.txt'), 'utf8')
const GRON_COMPANY = readFileSync(join(FIXTURES, 'map-script-gron-kontor-company.ts.txt'), 'utf8')

describe('detectScripts: embeds built by a script (#57)', () => {
  test('arjangs: an embed URL in a data- attribute template literal is a script-built embed, not a tracker', () => {
    const r = detectScripts(inline({ 'src/components/KontaktContent.astro': ARJANGS }))
    expect(r.scriptBuilt).toEqual([{ service: 'google-maps', file: 'src/components/KontaktContent.astro', where: 'data-map-src' }])
    expect(r.trackers).toEqual([])
  })

  test('stromsbacka: an embed URL string inside a <script> is a script-built embed, not a tracker', () => {
    const r = detectScripts(inline({ 'src/components/KontaktMap.astro': STROMSBACKA }))
    expect(r.scriptBuilt).toEqual([{ service: 'google-maps', file: 'src/components/KontaktMap.astro', where: 'script' }])
    expect(r.trackers).toEqual([])
  })

  test.each([
    ['a quoted data-src on a div', '<div data-src="https://www.google.com/maps/embed?pb=!1m2" />', 'data-src'],
    ['a Calendar embed in a data- attribute', '<div data-cal="https://calendar.google.com/calendar/embed?src=x" />', 'data-cal'],
    ['a Calendar embed in a script', "<script>f.src = 'https://calendar.google.com/calendar/embed?src=x'</script>", 'script'],
    ['an Embed API URL in a script', '<script is:inline>f.src = `https://www.google.com/maps/embed/v1/place?q=${q}`</script>', 'script'],
  ])('%s is a script-built embed', (_name, markup, where) => {
    const r = detectScripts(inline({ 'src/components/M.astro': `${markup}\n` }))
    expect(r.scriptBuilt.map((s) => s.where)).toEqual([where])
    expect(r.trackers).toEqual([])
  })

  test('links, iframes and component props are not script-built embeds', () => {
    const r = detectScripts(
      inline({
        'src/components/M.astro':
          "---\nimport Map from './Map.astro'\n---\n" +
          '<a href={`https://www.google.com/maps/search/?api=1&query=${q}`}>Hitta hit</a>\n' +
          '<a href="https://calendar.google.com/calendar/render?action=TEMPLATE">Lägg till</a>\n' +
          '<div data-href="https://maps.google.com/?q=Varberg" />\n' +
          '<iframe title="Karta" data-src="https://www.google.com/maps/embed?pb=!1m2"></iframe>\n' +
          '<Map src="https://www.google.com/maps/embed?pb=!1m2" />\n' +
          '<!-- <div data-map-src="https://www.google.com/maps/embed?pb=!1m2" /> -->\n',
      }),
    )
    expect(r.scriptBuilt).toEqual([])
    expect(r.trackers).toEqual([])
  })

  test('a Maps JavaScript API script stays tracker google-maps', () => {
    const r = detectScripts(inline({ 'src/components/Map.astro': "<script>s.src = 'https://maps.googleapis.com/maps/api/js?key=abc'</script>\n" }))
    expect(r.trackers).toEqual(['google-maps'])
    expect(r.scriptBuilt).toEqual([])
  })

  test('a link to an embed URL is not a script-built embed', () => {
    const r = detectScripts(inline({ 'src/components/M.astro': '<a href="https://www.google.com/maps/embed?pb=!1m2">Karta</a>\n' }))
    expect(r.scriptBuilt).toEqual([])
  })

  test.each([
    ['&amp; before output=embed', '<div data-src="https://maps.google.com/maps?q=Varberg&amp;output=embed" />'],
    ['My Maps /maps/d/embed', '<div data-src="https://www.google.com/maps/d/embed?mid=abc" />'],
    ['My Maps /maps/d/u/0/embed', '<div data-src="https://www.google.com/maps/d/u/0/embed?mid=abc" />'],
    ['Calendar /calendar/u/0/embed', '<div data-src="https://calendar.google.com/calendar/u/0/embed?src=x" />'],
  ])('embed URL shape: %s', (_name, markup) => {
    expect(detectScripts(inline({ 'src/components/M.astro': `${markup}\n` })).scriptBuilt.map((s) => s.where)).toEqual(['data-src'])
  })

  test('tranemoglas: data-src={mapSrc} from a frontmatter template literal, iframe made in the script', () => {
    const r = detectScripts(inline({ 'src/pages/kontakt.astro': TRANEMOGLAS }))
    expect(r.scriptBuilt).toEqual([{ service: 'google-maps', file: 'src/pages/kontakt.astro', where: 'createElement' }])
    expect(r.trackers).toEqual([])
  })

  test('gron-kontor: the embed URL is a + concatenation in an imported data module', () => {
    const r = detectScripts(inline({ 'src/pages/kontakta-oss.astro': GRON_PAGE, 'src/data/company.ts': GRON_COMPANY }))
    expect(r.scriptBuilt).toEqual([{ service: 'google-maps', file: 'src/pages/kontakta-oss.astro', where: 'createElement' }])
    expect(r.trackers).toEqual([])
  })

  test('createElement(iframe) with no Maps or Calendar embed in reach is not flagged (hkc-fitness leasing calculator)', () => {
    const r = detectScripts(
      inline({
        'src/pages/formanscykel.astro':
          "---\nimport { FORMAN } from '../data/site'\n---\n" +
          '<div data-kalkyl-fasad data-src="https://example.leaseabike.se/kalkyl"><button data-kalkyl-start>Räkna</button></div>\n' +
          '<a href="https://www.google.com/maps/search/?api=1&query=Varberg">Hitta hit</a>\n' +
          "<script>\n  const iframe = document.createElement('iframe')\n  iframe.src = fasad.dataset.src\n</script>\n",
        'src/data/site.ts': "export const FORMAN = 1\nexport const mapsUrl = 'https://www.google.com/maps/place/Varberg'\n",
      }),
    )
    expect(r.scriptBuilt).toEqual([])
  })

  test('createElement(iframe) beside a literal map <iframe> in the same file is not flagged by that iframe', () => {
    const r = detectScripts(
      inline({
        'src/pages/x.astro':
          '<iframe title="Karta" src="https://www.google.com/maps/embed?pb=!1m2"></iframe>\n' +
          "<script>\n  const v = document.createElement('iframe')\n  v.src = 'https://player.vimeo.com/video/1'\n</script>\n",
      }),
    )
    expect(r.scriptBuilt).toEqual([])
  })
})

describe('detectScripts: banners, reCAPTCHA, already wired', () => {
  test.each([
    ['Cookiebot', '<script id="Cookiebot" src="https://consent.cookiebot.com/uc.js" data-cbid="x"></script>', 'cookiebot'],
    ['CookieYes', '<script src="https://cdn-cookieyes.com/client_data/abc/script.js"></script>', 'cookieyes'],
  ])('%s is an existing banner', (_name, tag, expected) => {
    expect(detectScripts(inline({ 'src/layouts/Base.astro': page(tag) })).banners).toEqual([expected])
  })

  test('an Elfsight loader is neither a banner nor a tracker', () => {
    for (const src of ['https://static.elfsight.com/platform/platform.js', 'https://elfsightcdn.com/platform.js']) {
      const r = detectScripts(inline({ 'src/layouts/Base.astro': page(`<script src="${src}" async></script><script is:inline>var u='${src}'</script>`) }))
      expect(r.banners).toEqual([])
      expect(r.trackers).toEqual([])
    }
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

  test('a consent gate whose localStorage key is in a variable is an existing banner', () => {
    const r = detectScripts(
      inline({ 'src/components/Gate.astro': "<script>\nconst KEY = 'cookie-consent'\nif (localStorage.getItem(KEY) === '1') load()\n</script>\n" }),
    )
    expect(r.banners).toEqual(["home-made gate: localStorage with 'cookie-consent' in src/components/Gate.astro"])
  })

  test('a consent gate whose document.cookie name is in a variable is an existing banner', () => {
    const r = detectScripts(
      inline({ 'src/scripts/gate.ts': "const NAME = 'site_consent'\nexport const ok = () => document.cookie.includes(NAME)\n" }),
    )
    expect(r.banners).toEqual(["home-made gate: document.cookie with 'site_consent' in src/scripts/gate.ts"])
  })

  test('a file with localStorage and no consent-like literal is not a banner', () => {
    const r = detectScripts(
      inline({ 'src/components/Theme.astro': "<button class=\"btn\">Acceptera</button>\n<script>\nconst KEY = 'theme'\nlocalStorage.setItem(KEY, 'dark')\n</script>\n" }),
    )
    expect(r.banners).toEqual([])
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
    widgets: [],
    parseErrors: [],
    aliasImports: [],
    multiFooterPages: [],
    ownHtmlPages: [],
    wired: [],
    widgetReasons: [],
    scriptBuilt: [],
    scriptHosts: [],
    ...over,
  }
}

describe('classify', () => {
  test('a clean site with no iframes is notice', () => {
    expect(classify(clean())).toEqual({ classification: 'notice', reasons: [] })
  })

  test('a resolved Google Maps iframe makes the site consent', () => {
    expect(classify(clean({ iframes: [frame({})] }))).toEqual({ classification: 'consent', reasons: [] })
    expect(classify(clean({ iframes: [frame({ srcKind: 'data-file', dataPath: 'src/data/k.json' })] }))).toEqual({
      classification: 'consent',
      reasons: [],
    })
  })

  test('a Google Calendar iframe makes the site consent', () => {
    expect(classify(clean({ iframes: [frame({ service: 'google-calendar', host: 'calendar.google.com' })] }))).toEqual({
      classification: 'consent',
      reasons: [],
    })
  })

  test('an invented map alone keeps the site consent with no reasons', () => {
    expect(classify(clean({ iframes: [frame({})], inventedMaps: [MAPS_SRC] }))).toEqual({ classification: 'consent', reasons: [] })
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
    ['GA present', { trackers: ['google-analytics'] }, 'tracker google-analytics: the batch wires notice and consent only'],
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
      'own <html> page (Ruling 39)',
      { ownHtmlPages: ['src/pages/kampanj.astro'] },
      'page renders its own <html>: src/pages/kampanj.astro',
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

  test('widget reasons are listed as they are; wired services alone make the site consent', () => {
    expect(classify(clean({ widgetReasons: ['elfsight: src/pages/x.astro: two elfsight scripts'] }))).toEqual({
      classification: 'needs-human',
      reasons: ['elfsight: src/pages/x.astro: two elfsight scripts'],
    })
    expect(classify(clean({ wired: ['elfsight'] }))).toEqual({ classification: 'consent', reasons: [] })
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

  const FEED_PAGE =
    "---\nimport Base from '../layouts/Base.astro'\n---\n<Base title=\"Flöde\">\n  <section>\n    <!-- Elfsight Instagram Feed | Flöde -->\n" +
    '    <script src="https://elfsightcdn.com/platform.js" async></script>\n' +
    '    <div class="elfsight-app-00000000-0000-0000-0000-000000000001" data-elfsight-app-lazy></div>\n  </section>\n</Base>\n'

  test('an Elfsight widget makes a notice site consent, with no banner and no tracker', () => {
    const r = detect(withFiles(pilot('munkforstradgardstjanst'), { 'src/pages/flode.astro': FEED_PAGE }), 'x', ['x.se'])
    expect(r.banners).toEqual([])
    expect(r.trackers).toEqual([])
    expect(r.reasons).toEqual([])
    expect(r.classification).toBe('consent')
    expect(r.services).toEqual(['elfsight'])
    expect(r.widgets.map((w) => [w.file, w.pages])).toEqual([['src/pages/flode.astro', ['src/pages/flode.astro']]])
  })

  test('a Cookiebot script beside the widget is still a banner', () => {
    const cookiebot = '<script id="Cookiebot" src="https://consent.cookiebot.com/uc.js" data-cbid="x"></script>\n'
    const r = detect(withFiles(pilot('munkforstradgardstjanst'), { 'src/pages/flode.astro': FEED_PAGE + cookiebot }), 'x', ['x.se'])
    expect(r.banners).toEqual(['cookiebot'])
    expect(r.classification).toBe('needs-human')
    expect(r.reasons).toContain('existing banner: cookiebot')
  })

  test('an Elfsight reason makes the site needs-human', () => {
    const r = detect(withFiles(pilot('munkforstradgardstjanst'), { 'src/pages/flode.astro': FEED_PAGE.replace(' async>', ' defer>') }), 'x', ['x.se'])
    expect(r.classification).toBe('needs-human')
    expect(r.reasons).toEqual(['elfsight: src/pages/flode.astro: script attribute defer not understood', 'elfsight: src/pages/flode.astro: elfsight outside a recognised widget'])
  })

  test('an already wired widget re-detects as consent', () => {
    const wired =
      "---\nimport Base from '../layouts/Base.astro'\nimport ConsentWidget from '@visionmediahq/astro-consent/components/ConsentWidget.astro'\n---\n" +
      '<Base title="Flöde"><ConsentWidget service="elfsight" script="https://elfsightcdn.com/platform.js" title="Innehållet">' +
      '<div class="elfsight-app-00000000-0000-0000-0000-000000000001" data-elfsight-app-lazy></div></ConsentWidget></Base>\n'
    const r = detect(withFiles(pilot('munkforstradgardstjanst'), { 'src/pages/flode.astro': wired }), 'x', ['x.se'])
    expect(r.reasons).toEqual([])
    expect(r.widgets).toEqual([])
    expect(r.classification).toBe('consent')
    expect(r.services).toEqual(['elfsight'])
  })

  test('a notice site with arjangs-elmontage\'s click-to-load map is needs-human, not notice (#57)', () => {
    const r = detect(withFiles(pilot('munkforstradgardstjanst'), { 'src/components/KontaktContent.astro': ARJANGS }), 'x', ['x.se'])
    expect(r.classification).toBe('needs-human')
    expect(r.reasons).toEqual(['script-built embed google-maps in src/components/KontaktContent.astro (data-map-src)'])
    expect(r.trackers).toEqual([])
  })

  test('stromsbacka\'s map built in a <script> gives the same kind of reason', () => {
    const r = detect(withFiles(pilot('munkforstradgardstjanst'), { 'src/components/KontaktMap.astro': STROMSBACKA }), 'x', ['x.se'])
    expect(r.classification).toBe('needs-human')
    expect(r.reasons).toEqual(['script-built embed google-maps in src/components/KontaktMap.astro (script)'])
  })

  test.each([
    ['tranemoglas', { 'src/pages/kontakt.astro': TRANEMOGLAS }, 'src/pages/kontakt.astro'],
    ['gron-kontor', { 'src/pages/kontakta-oss.astro': GRON_PAGE, 'src/data/company.ts': GRON_COMPANY }, 'src/pages/kontakta-oss.astro'],
  ])('a notice site with %s\'s map behind a variable is needs-human', (_site, extra, file) => {
    const r = detect(withFiles(pilot('munkforstradgardstjanst'), extra), 'x', ['x.se'])
    expect(r.classification).toBe('needs-human')
    expect(r.reasons).toEqual([`script-built embed google-maps in ${file} (createElement)`])
  })

  test.each([
    ['munkforstradgardstjanst', 'notice'],
    ['nhrk', 'needs-human'],
    ['a-tak', 'needs-human'],
    ['vasshallakatthotell', 'consent'],
    ['aspomad', 'consent'],
    ['domeijstapetserarverkstad', 'consent'],
    ['traforadling', 'consent'],
  ])('pilot %s: %s, matching the committed snapshot', (site, classification) => {
    const r = detect(pilot(site), site, [`${site}.se`])
    expect(r.classification).toBe(classification)
    expect(r).toMatchSnapshot()
  })
})

describe('servicesOf and normaliseReport', () => {
  const widget: WidgetInfo = {
    file: 'src/pages/index.astro',
    start: 0,
    end: 10,
    service: 'elfsight',
    script: 'https://elfsightcdn.com/platform.js',
    scriptAt: { start: 20, end: 30 },
    pages: ['src/pages/index.astro'],
  }

  test('sorted and unique; unresolved and own iframes are left out', () => {
    const iframes = [
      frame({ service: 'google-maps' }),
      frame({ service: 'google-calendar', host: 'calendar.google.com' }),
      frame({ service: 'google-maps' }),
      frame({ srcKind: 'unresolved', src: null, service: 'google-ads' }),
      frame({ service: null, host: null }),
    ]
    expect(servicesOf({ iframes, widgets: [widget] })).toEqual(['elfsight', 'google-calendar', 'google-maps'])
    expect(servicesOf({ iframes: [], widgets: [] }, ['google-ads', 'elfsight'])).toEqual(['elfsight', 'google-ads'])
  })

  test('an old stored report with maps loads as consent with services and widgets', () => {
    const { services: _s, widgets: _w, ...rest } = detect(inline({}), 'x', ['x.se'])
    const old = { ...rest, classification: 'maps', iframes: [frame({})] }
    const r = normaliseReport(old)
    expect(r.classification).toBe('consent')
    expect(r.services).toEqual(['google-maps'])
    expect(r.widgets).toEqual([])
  })
})
