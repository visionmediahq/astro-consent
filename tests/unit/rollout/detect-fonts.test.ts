import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { detectFonts } from '../../../ci/rollout/detect/fonts'
import { detect } from '../../../ci/rollout/detect/index'
import { fixtureSite, globToRegExp, type SiteFiles } from '../../../ci/rollout/lib/site-files'
import type { FontsInfo } from '../../../ci/rollout/types'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const site = (name: string): SiteFiles => fixtureSite(join(FIXTURES, 'fonts', name))

/** `base` with `extra` files added (or replaced; `null` removes one), in memory. */
function withFiles(base: SiteFiles | null, extra: Record<string, string | null>): SiteFiles {
  const added = Object.entries(extra).flatMap(([p, t]) => (t === null ? [] : [p]))
  const removed = new Set(Object.entries(extra).flatMap(([p, t]) => (t === null ? [p] : [])))
  return {
    root: base?.root ?? '/nowhere',
    list: (glob) =>
      [...new Set([...(base?.list(glob) ?? []), ...added.filter((p) => globToRegExp(glob).test(p))])].filter((p) => !removed.has(p)).sort(),
    read: (path) => {
      const t = extra[path]
      if (typeof t === 'string') return t
      if (removed.has(path) || !base) throw new Error(`ENOENT ${path}`)
      return base.read(path)
    },
    exists: (path) => typeof extra[path] === 'string' || (!removed.has(path) && (base?.exists(path) ?? false)),
  }
}

const fonts = (files: SiteFiles): FontsInfo => detectFonts(files, 'src/styles/global.css')

/** Each location as `kind file: first line of its text`. */
function where(files: SiteFiles, r: FontsInfo): string[] {
  return r.locations.map((l) => `${l.kind} ${l.file}: ${files.read(l.file).slice(l.start, l.end).split('\n')[0]!.trim()}`)
}

const KNUT = 'https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Barlow:ital,wght@0,300;0,400;0,500;0,600;1,400&display=swap'
const TW = '@import "tailwindcss";\n'
const LINK = `<link rel="stylesheet" href="${KNUT}" />`
const page = (head: string, frontmatter = "import '../styles/global.css'"): string =>
  `---\n${frontmatter}\n---\n<html lang="sv">\n  <head>\n    ${head}\n  </head>\n  <body><slot /></body>\n</html>\n`
/** A minimal site: a layout with `head` and a Tailwind entry. */
const mini = (head: string, extra: Record<string, string | null> = {}, frontmatter?: string): SiteFiles =>
  withFiles(null, { 'src/layouts/Base.astro': page(head, frontmatter), 'src/styles/global.css': TW, ...extra })

function needsHuman(r: FontsInfo, fragment: string): void {
  expect(r.status).toBe('needs-human')
  expect(r.url).toBeNull()
  expect(r.reasons.some((x) => x.includes(fragment)), `${JSON.stringify(r.reasons)} should mention "${fragment}"`).toBe(true)
}

describe('detectFonts: wireable patterns', () => {
  test('knutssonsbil: one-line stylesheet link and two preconnects', () => {
    const files = site('knutssonsbil')
    const r = fonts(files)
    expect(r).toMatchObject({ status: 'wire', url: KNUT, urls: [KNUT], csp: [], reasons: [] })
    expect(where(files, r)).toEqual([
      'preconnect src/layouts/Base.astro: <link rel="preconnect" href="https://fonts.googleapis.com" />',
      'preconnect src/layouts/Base.astro: <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
      `link src/layouts/Base.astro: ${LINK}`,
    ])
  })

  test('ahatrafikskola: a link split over lines', () => {
    const files = site('ahatrafikskola')
    const r = fonts(files)
    expect(r.status).toBe('wire')
    expect(r.url).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?family=Bricolage\+Grotesque:opsz,wght@12\.\.96,400;/)
    expect(r.locations.map((l) => l.kind)).toEqual(['preconnect', 'preconnect', 'link'])
    const link = r.locations[2]!
    expect(files.read(link.file).slice(link.start, link.end)).toMatch(/^<link\n\s+rel="stylesheet"\n\s+href="[^"]+"\n\s+\/>$/)
  })

  test('ernstedt: preload as=style, a print/onload stylesheet and a noscript copy (any attribute order)', () => {
    const files = site('ernstedt')
    const r = fonts(files)
    expect(r.status).toBe('wire')
    expect(r.urls).toHaveLength(1)
    expect(r.locations.map((l) => l.kind)).toEqual(['preconnect', 'preconnect', 'preload', 'link', 'noscript'])
    const ns = r.locations[4]!
    expect(files.read(ns.file).slice(ns.start, ns.end)).toMatch(/^<noscript><link [^>]+\/><\/noscript>$/)
  })

  test('onoffshore: multi-line preload + stylesheet, a CSP in _headers that keeps self', () => {
    const files = site('onoffshore')
    const r = fonts(files)
    expect(r.status).toBe('wire')
    expect(r.locations.map((l) => l.kind)).toEqual(['preconnect', 'preconnect', 'preload', 'link'])
    expect(r.csp.map((c) => [c.file, c.kind])).toEqual([['_headers', 'headers']])
    const c = r.csp[0]!
    expect(files.read(c.file).slice(c.start, c.end)).toMatch(/^ {2}Content-Security-Policy: default-src 'self';.*form-action 'self';$/)
  })

  test('arjangs-elmontage: a frontmatter const used only as href, in a link and a noscript', () => {
    const files = site('arjangs-elmontage')
    const r = fonts(files)
    expect(r.status).toBe('wire')
    expect(r.url).toBe('https://fonts.googleapis.com/css2?family=Kanit:wght@500;600;700;800&family=Open+Sans:wght@400;500;600;700&display=swap')
    expect(where(files, r)).toEqual([
      'const src/layouts/Base.astro: const fontHref =',
      'preconnect src/layouts/Base.astro: <link rel="preconnect" href="https://fonts.googleapis.com" />',
      'preconnect src/layouts/Base.astro: <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
      'link src/layouts/Base.astro: <link',
      'noscript src/layouts/Base.astro: <noscript>',
    ])
    const c = r.locations[0]!
    expect(files.read(c.file).slice(c.start, c.end)).toMatch(/^const fontHref =\n {2}'https:[^']+'$/)
  })

  test('ljrevision: @import url(...) on line 1 of global.css, preconnects in the layout', () => {
    const files = site('ljrevision')
    const r = fonts(files)
    expect(r.status).toBe('wire')
    expect(r.url).toBe('https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&display=swap')
    expect(where(files, r)).toEqual([
      'preconnect src/layouts/Base.astro: <link rel="preconnect" href="https://fonts.googleapis.com" />',
      'preconnect src/layouts/Base.astro: <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
      `import src/styles/global.css: @import url("${r.url}");`,
    ])
  })

  test('a quoted @import "…" is the same pattern', () => {
    const r = fonts(withFiles(null, { 'src/styles/global.css': `@import "${KNUT}";\n${TW}` }))
    expect(r.status).toBe('wire')
    expect(r.locations.map((l) => l.kind)).toEqual(['import'])
  })

  test('kfkmekan: a CSP meta in the layout that keeps self is reported, not refused', () => {
    const files = site('kfkmekan')
    const r = fonts(files)
    expect(r.status).toBe('wire')
    expect(r.locations.map((l) => l.kind)).toEqual(['preconnect', 'preconnect', 'link'])
    expect(r.csp.map((c) => [c.file, c.kind])).toEqual([['src/layouts/Base.astro', 'meta']])
    const c = r.csp[0]!
    expect(files.read(c.file).slice(c.start, c.end)).toMatch(/^<meta\n\s+http-equiv="Content-Security-Policy"/)
  })

  test('&amp; in an attribute is decoded in the url', () => {
    const r = fonts(mini(`<link rel="stylesheet" href="${KNUT.replaceAll('&', '&amp;')}" />`))
    expect(r.status).toBe('wire')
    expect(r.url).toBe(KNUT)
  })

  test('an image preload with a dynamic href is not a stylesheet (ernstedt, farstaglas)', () => {
    const r = fonts(mini(`${LINK}\n    {heroPreload && <link rel="preload" as="image" href={heroPreload} fetchpriority="high" />}`, {}, "import '../styles/global.css'\nconst { heroPreload } = Astro.props"))
    expect(r.reasons).toEqual([])
    expect(r.status).toBe('wire')
  })

  test('the same url in two layouts is one url', () => {
    const r = fonts(mini(LINK, { 'src/layouts/Other.astro': page(LINK) }))
    expect(r.status).toBe('wire')
    expect(r.locations.map((l) => l.file)).toEqual(['src/layouts/Base.astro', 'src/layouts/Other.astro'])
  })

  test('comments are not loads: an HTML comment, a frontmatter comment, a CSS comment', () => {
    const r = fonts(
      mini(`<!-- <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Old&display=swap" /> -->\n    ${LINK}`, {
        'src/styles/global.css': `${TW}/* was: @import url("https://fonts.googleapis.com/css2?family=Old"); */\n`,
      }, "import '../styles/global.css'\n// fonts come from https://fonts.googleapis.com\n/* https://fonts.gstatic.com */"),
    )
    expect(r.status).toBe('wire')
    expect(r.urls).toEqual([KNUT])
    expect(r.locations.map((l) => l.kind)).toEqual(['link'])
  })
})

describe('detectFonts: self-hosted and none', () => {
  test('olarpsvasstak: no font loading at all is none; the CSP strings in middleware are still listed', () => {
    const files = site('olarpsvasstak')
    const r = fonts(files)
    expect(r).toMatchObject({ status: 'none', url: null, urls: [], locations: [], reasons: [] })
    expect(r.csp.map((c) => [c.file, c.kind, files.read(c.file).slice(c.start, c.end)])).toEqual([
      ['src/middleware.ts', 'module', `"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"`],
      ['src/middleware.ts', 'module', `"font-src 'self' https://fonts.gstatic.com"`],
    ])
  })

  test('gron-kontor: @font-face and public/fonts; a comment naming fonts.googleapis.com is not a load', () => {
    expect(fonts(site('gron-kontor'))).toMatchObject({ status: 'self-hosted', reasons: [], locations: [] })
  })

  test('Vildmarkscamp: the Astro fonts config', () => {
    expect(fonts(site('Vildmarkscamp'))).toMatchObject({ status: 'self-hosted', reasons: [] })
  })

  test('sveplant: an @fontsource dependency', () => {
    expect(fonts(site('sveplant'))).toMatchObject({ status: 'self-hosted', reasons: [] })
  })

  test('woff2 files under src/assets with @font-face', () => {
    const r = fonts(mini('', { 'src/styles/global.css': `${TW}@font-face { font-family: 'X'; src: url('../assets/fonts/x.woff2'); }\n` }))
    expect(r.status).toBe('self-hosted')
  })

  test('a site without fonts is none', () => {
    expect(fonts(mini('<link rel="icon" href="/favicon.webp" />'))).toEqual({
      status: 'none',
      url: null,
      urls: [],
      locations: [],
      csp: [],
      reasons: [],
    })
  })
})

describe('detectFonts: needs-human', () => {
  test('a template-literal href', () => {
    needsHuman(
      fonts(mini('<link rel="stylesheet" href={`https://fonts.googleapis.com/css2?family=${family}&display=swap`} />', {}, "import '../styles/global.css'\nconst family = 'Oswald'")),
      'expression',
    )
  })

  test('a stylesheet href from the environment beside a literal one', () => {
    needsHuman(fonts(mini(`${LINK}\n    <link rel="stylesheet" href={import.meta.env.PUBLIC_FONT_CSS} />`)), 'dynamic href')
  })

  test('a font-ish stylesheet href from the environment alone', () => {
    needsHuman(fonts(mini('<link rel="stylesheet" href={import.meta.env.PUBLIC_FONT_CSS} />')), 'dynamic href')
  })

  test('a Google Fonts url in a .env file', () => {
    needsHuman(fonts(mini('', { '.env.example': `PUBLIC_FONT_CSS=${KNUT}\n` })), '.env.example')
  })

  test('two distinct urls', () => {
    const other = 'https://fonts.googleapis.com/css2?family=Lato:wght@400&display=swap'
    const r = fonts(mini(`${LINK}\n    <link rel="stylesheet" href="${other}" />`))
    needsHuman(r, '2 distinct')
    expect(r.urls).toEqual([KNUT, other])
  })

  test('the css v1 API', () => {
    needsHuman(fonts(mini('<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Open+Sans:400,700&display=swap" />')), 'css v1')
  })

  test('a text= subset', () => {
    needsHuman(fonts(mini(`<link rel="stylesheet" href="${KNUT}&text=Hello" />`)), 'text=')
  })

  test('icon families: Material Symbols in css2 and the Material Icons API', () => {
    needsHuman(
      fonts(mini('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" />')),
      'icon',
    )
    needsHuman(fonts(mini('<link rel="stylesheet" href="https://fonts.googleapis.com/icon?family=Material+Icons" />')), 'icon')
  })

  test('http or protocol-relative urls', () => {
    needsHuman(fonts(mini(`<link rel="stylesheet" href="${KNUT.replace('https:', '')}" />`)), 'not understood')
  })

  test('a Google Fonts host in a .ts module that is not a CSP', () => {
    needsHuman(fonts(mini(LINK, { 'src/lib/fonts.ts': `export const FONT_CSS = '${KNUT}'\n` })), 'src/lib/fonts.ts')
  })

  test('a Google Fonts host in a component <script> or <style>', () => {
    needsHuman(fonts(mini(`${LINK}\n    <script is:inline>const l = document.createElement('link'); l.href = 'https://fonts.googleapis.com/css2?family=X'</script>`)), 'outside')
    needsHuman(fonts(mini(`<style>@import url('${KNUT}');</style>`)), 'outside')
  })

  test('a Google Fonts host in a data file or in public/', () => {
    needsHuman(fonts(mini(LINK, { 'src/data/site.json': `{ "fonts": "${KNUT}" }\n` })), 'src/data/site.json')
    needsHuman(fonts(mini(LINK, { 'public/legacy.html': `<link rel="stylesheet" href="${KNUT}">\n` })), 'public/legacy.html')
  })

  test('the Astro fonts config is already set', () => {
    const config = "import { defineConfig } from 'astro/config'\nexport default defineConfig({ fonts: [] })\n"
    needsHuman(fonts(mini(LINK, { 'astro.config.mjs': config })), 'fonts config')
  })

  test('src/styles/fonts.css or public/fonts/ already exist', () => {
    needsHuman(fonts(mini(LINK, { 'src/styles/fonts.css': '/* mine */\n' })), 'src/styles/fonts.css')
    needsHuman(fonts(mini(LINK, { 'public/fonts/a.woff2': 'x' })), 'public/fonts/')
  })

  test("a CSP whose font-src lacks 'self'", () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; font-src https://fonts.gstatic.com" />`
    const r = fonts(mini(`${meta}\n    ${LINK}`))
    needsHuman(r, 'font-src')
    expect(r.csp).toHaveLength(1)
  })

  test("a CSP without font-src whose default-src lacks 'self'", () => {
    const headers = "/*\n  Content-Security-Policy: default-src https:; style-src 'self' fonts.googleapis.com\n"
    needsHuman(fonts(mini(LINK, { 'public/_headers': headers })), 'font-src')
  })

  test('the const is used for something besides href', () => {
    const fm = `import '../styles/global.css'\nconst fontHref = '${KNUT}'`
    needsHuman(fonts(mini('<link rel="stylesheet" href={fontHref} />\n    <meta name="x" content={fontHref} />', {}, fm)), 'fontHref')
  })

  test('a link inside an expression', () => {
    needsHuman(fonts(mini(`{withFonts && ${LINK}}`, {}, "import '../styles/global.css'\nconst withFonts = true")), 'expression')
  })

  test('a noscript holding something besides the font links', () => {
    needsHuman(fonts(mini(`${LINK}\n    <noscript>${LINK}<style>.js { display: none }</style></noscript>`)), 'noscript')
  })

  test('preconnects without a stylesheet', () => {
    needsHuman(fonts(mini('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />')), 'preconnect')
  })

  test('a font preload from fonts.gstatic.com', () => {
    needsHuman(fonts(mini(`${LINK}\n    <link rel="preload" as="font" type="font/woff2" href="https://fonts.gstatic.com/s/oswald/v1/x.woff2" crossorigin />`)), 'not understood')
  })

  test('an attribute the tool does not know', () => {
    needsHuman(fonts(mini(`<link id="gf" rel="stylesheet" href="${KNUT}" />`)), 'attribute id')
  })

  test('@import with a media query', () => {
    needsHuman(fonts(withFiles(null, { 'src/styles/global.css': `@import url("${KNUT}") screen;\n${TW}` })), '@import')
  })

  test('the file with the link does not import the Tailwind entry', () => {
    needsHuman(fonts(mini(LINK, {}, "import SEO from '../components/SEO.astro'")), 'does not import')
  })

  test('no Tailwind entry', () => {
    needsHuman(detectFonts(mini(LINK), null), 'Tailwind')
  })

  test('an .astro file that does not parse', () => {
    needsHuman(fonts(mini(LINK, { 'src/pages/broken.astro': `<div>{</div>\n<link rel="stylesheet" href="${KNUT}" />\n` })), 'parse')
  })
})

describe('detect: fonts is a separate field', () => {
  test('fonts does not change the classification or the reasons', () => {
    const files = site('knutssonsbil')
    const r = detect(files, 'knutssonsbil', ['knutssonsbil.se'])
    expect(r.fonts?.status).toBe('wire')
    const broken = detect(withFiles(files, { 'src/lib/fonts.ts': `export const X = '${KNUT}'\n` }), 'knutssonsbil', ['knutssonsbil.se'])
    expect(broken.fonts?.status).toBe('needs-human')
    expect(broken.classification).toBe(r.classification)
    expect(broken.reasons).toEqual(r.reasons)
  })
})

// Probes from the review of #74: none of the first set may come out `wire`; the second set is
// wireable as it stands.
describe('detectFonts: review probes', () => {
  const U = 'https://fonts.googleapis.com/css2?family=Oswald:wght@400;700&display=swap'
  const L = `<link rel="stylesheet" href="${U}" />`
  const pg = (head: string, fm = "import '../styles/global.css'", body = '<slot />'): string =>
    `---\n${fm}\n---\n<html><head>${head}</head><body>${body}</body></html>\n`
  const base = (head = L, extra: Record<string, string> = {}, fm?: string, body?: string): SiteFiles =>
    withFiles(null, { 'src/layouts/Base.astro': pg(head, fm, body), 'src/styles/global.css': TW, ...extra })
  const css = (text: string, head = ''): SiteFiles => withFiles(null, { 'src/layouts/Base.astro': pg(head), 'src/styles/global.css': text })
  const pkg = (dep: string): string => JSON.stringify({ dependencies: { astro: '^6.1.6', [dep]: '^1.0.0' } })

  test.each<[string, SiteFiles, string]>([
    ['a module string with a directive and a <link>', base(L, { 'src/lib/head.ts': `export const h = "font-src 'self'; <link rel=stylesheet href=${U}>"` }), 'src/lib/head.ts'],
    ['a module template with a CSP meta and a <link>', base(L, { 'src/middleware.ts': "export const html = `<meta content=\"default-src 'self'; style-src 'self' https://fonts.googleapis.com\"><link rel=stylesheet href=\"" + U + "\">`" }), 'src/middleware.ts'],
    ['a .md file outside src/', base(L, { 'content/blog/a.md': `<link rel="stylesheet" href="${U}">` }), 'content/blog/a.md'],
    ['a module outside src/', base(L, { 'integrations/fonts.ts': `export default { hooks: { 'astro:config:setup': ({ injectScript }) => injectScript('head-inline', "document.head.insertAdjacentHTML('beforeend','<link rel=stylesheet href=${U}>')") } }` }), 'integrations/fonts.ts'],
    ['an .astro file outside src/', base(L, { 'lib/Head.astro': `${L}\n` }), 'lib/Head.astro'],
    ['the Web Font Loader script', base(L, {}, undefined, '<script is:inline src="https://ajax.googleapis.com/ajax/libs/webfont/1.6.26/webfont.js"></script>'), 'Web Font Loader'],
    ['WebFont.load with no host', base(L, { 'src/scripts/fonts.ts': "WebFont.load({ google: { families: ['Oswald'] } })\n" }), 'WebFont.load'],
    ['a webfontloader dependency', base(L, { 'package.json': pkg('webfontloader') }), 'webfontloader'],
    ['an unplugin-fonts dependency', base('', { 'package.json': pkg('unplugin-fonts') }), 'unplugin-fonts'],
    ['an astro-font dependency', base(L, { 'package.json': pkg('astro-font') }), 'astro-font'],
    ['an astro-google-fonts-optimizer dependency', base(L, { 'package.json': pkg('astro-google-fonts-optimizer') }), 'astro-google-fonts-optimizer'],
    ['@import text inside a CSS string', css(`${TW}.a::before { content: "@import url(${U});" }\n`), 'outside'],
    ['@import inside @media braces', css(`${TW}@media print { @import url(${U}); }\n`), 'outside'],
    ['the href const also spread', base('<link rel="stylesheet" href={f} /><div {...f}></div>', {}, `import '../styles/global.css'\nconst f = '${U}'`), 'const f'],
    ['an HTML file named .ico (lannabilcenter)', base(L, { 'public/favicon.ico': `<!doctype html><link rel="stylesheet" href="${U}">\n` }), 'public/favicon.ico'],
    ["a second CSP string whose font-src lacks 'self'", base(L, { 'src/middleware.ts': `export const A = "font-src 'self' https://fonts.gstatic.com"\nexport const B = "font-src https://fonts.gstatic.com"\n` }), 'font-src'],
    ['a CSP meta inside an expression', base(`{csp && <meta http-equiv="Content-Security-Policy" content="default-src 'self'; font-src 'self' https://fonts.gstatic.com" />}${L}`, {}, "import '../styles/global.css'\nconst csp = true"), 'expression'],
    ['a <style> in a component', base(L, { 'src/components/X.astro': `<style is:global>@import url('${U}');</style>` }), 'src/components/X.astro'],
    ['a .mdx page', base(L, { 'src/content/a.mdx': `<link rel="stylesheet" href="${U}" />` }), 'src/content/a.mdx'],
    ['a vite plugin in astro.config', base(L, { 'astro.config.mjs': `export default { vite: { plugins: [{ transformIndexHtml: () => '<link href="${U}">' }] } }` }), 'astro.config.mjs'],
    ['set:html', base(L, {}, undefined, `<Fragment set:html={'<link rel="stylesheet" href="${U}">'} />`), 'expression'],
    ['a <link> in a page slotted into the layout without its own CSS import', base(L, { 'src/pages/i.astro': `---\nimport B from '../layouts/Base.astro'\n---\n<B>${L}</B>` }), 'does not import'],
    ['is:inline on the link', base(`<link is:inline rel="stylesheet" href="${U}" />`), 'is:inline'],
    ['an upper-case <LINK> (a component)', base(`<LINK rel="stylesheet" href="${U}" />`), 'outside'],
    ['a let href', base('<link rel="stylesheet" href={f} />', {}, `import '../styles/global.css'\nlet f = '${U}'`), 'outside'],
    ['the const in define:vars', base('<link rel="stylesheet" href={f} /><script define:vars={{ f }}>console.log(f)</script>', {}, `import '../styles/global.css'\nconst f = '${U}'`), 'const f'],
    ['an exported const', base('<link rel="stylesheet" href={f} />', {}, `import '../styles/global.css'\nexport const f = '${U}'`), 'const f'],
    ['a Link header in _headers', base(L, { _headers: `/*\n  Link: <${U}>; rel=preload; as=style\n` }), '_headers'],
    ['is:raw content', base(L, {}, undefined, `<div is:raw><link rel="stylesheet" href="${U}"></div>`), 'outside'],
    ['a JS comment in a template expression', base(L, {}, undefined, `{/* ${U} */}`), 'outside'],
    ['a url() to fonts.gstatic.com in @font-face', css(`${TW}@font-face{font-family:X;src:url(https://fonts.gstatic.com/s/x.woff2)}\n`, L), 'outside'],
  ])('%s is needs-human', (_name, files, fragment) => needsHuman(fonts(files), fragment))

  test.each<[string, SiteFiles]>([
    ['the layout and a component that both import the entry', base(L, { 'src/components/Head.astro': `---\nimport '../styles/global.css'\n---\n${L}` })],
    ['void links without a slash', base(`<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="${U}">\n<meta name="x" content="y">`)],
    ['the same @import twice', css(`@import url(${U});@import url(${U});\n${TW}`)],
    ['a scout/ folder (site-factory metadata, not served)', base(L, { 'scout/brief.json': `{ "fonts": "${U}" }\n` })],
  ])('%s is wire', (_name, files) => {
    const r = fonts(files)
    expect(r.reasons).toEqual([])
    expect(r.status).toBe('wire')
  })
})
