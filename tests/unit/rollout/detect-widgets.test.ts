import { describe, expect, test } from 'vitest'
import { detectWidgets } from '../../../ci/rollout/detect/widgets'
import { globToRegExp, type SiteFiles } from '../../../ci/rollout/lib/site-files'
import type { Report } from '../../../ci/rollout/types'

/** An in-memory site. */
function site(files: Record<string, string>): SiteFiles {
  const paths = Object.keys(files).sort()
  return {
    root: '/site',
    list: (glob) => paths.filter((p) => globToRegExp(glob).test(p)),
    read: (path) => {
      const text = files[path]
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return text
    },
    exists: (path) => path in files,
  }
}

const ID = '00000000-0000-0000-0000-000000000001'
const ID2 = '00000000-0000-0000-0000-000000000002'
const CDN = 'https://elfsightcdn.com/platform.js'
const STATIC = 'https://static.elfsight.com/platform/platform.js'
const SCRIPT = `<script src="${CDN}" async></script>`
const DIV = `<div class="elfsight-app-${ID}" data-elfsight-app-lazy></div>`
const V1 = `<!-- Elfsight Instagram Feed | Feed -->\n${SCRIPT}\n${DIV}\n`
const LAYOUT = `<html><body><slot /></body></html>\n`
const PAGE = 'src/pages/x.astro'
const layouts = (pages: string[] = []): Report['layouts'] => [{ file: 'src/layouts/Base.astro', pages, footerRef: null }]

const run = (files: Record<string, string>, l = layouts()) => detectWidgets(site({ 'src/layouts/Base.astro': LAYOUT, ...files }), l)
const reasonsOf = (files: Record<string, string>) => run(files).reasons
const OUTSIDE = (file: string) => `elfsight: ${file}: elfsight outside a recognised widget`

describe('detectWidgets: recognised widgets', () => {
  test('V1: script then div, siblings', () => {
    const text = `<section>\n${V1}</section>\n`
    const r = run({ [PAGE]: text })
    expect(r.reasons).toEqual([])
    expect(r.parseErrors).toEqual([])
    expect(r.wired).toEqual([])
    const s = text.indexOf('<script')
    const d = text.indexOf('<div')
    expect(r.widgets).toEqual([
      {
        file: PAGE,
        start: d,
        end: d + DIV.length,
        service: 'elfsight',
        script: CDN,
        scriptAt: { start: s, end: s + SCRIPT.length },
        pages: [PAGE],
      },
    ])
  })

  test('V1 with is:inline and the attributes in another order', () => {
    const r = run({ [PAGE]: `<script async is:inline src="${CDN}"></script>\n<div data-elfsight-app-lazy class="elfsight-app-${ID}"></div>\n` })
    expect(r.reasons).toEqual([])
    expect(r.widgets).toHaveLength(1)
  })

  test('V2: script before the section, div nested', () => {
    const r = run({ 'src/pages/x.astro': `${SCRIPT}\n<section class="py-8">\n  <div class="container">\n    ${DIV}\n  </div>\n</section>\n` })
    expect(r.reasons).toEqual([])
    expect(r.widgets).toHaveLength(1)
  })

  test('V2: script after the section, div over three lines', () => {
    const div = `<div\n      class="elfsight-app-${ID}"\n      data-elfsight-app-lazy>\n    </div>`
    const r = run({ [PAGE]: `<section>\n  <div>\n    ${div}\n  </div>\n</section>\n<script is:inline src="${CDN}" async></script>\n` })
    expect(r.reasons).toEqual([])
    expect(r.widgets).toHaveLength(1)
  })

  test('V3: the static.elfsight.com loader, script as written', () => {
    const r = run({ [PAGE]: `<script src="${STATIC}" async></script>\n${DIV}\n` })
    expect(r.reasons).toEqual([])
    expect(r.widgets.map((w) => w.script)).toEqual([STATIC])
  })

  test('two divs and one script in a file: two widgets sharing the script', () => {
    const r = run({ [PAGE]: `${SCRIPT}\n${DIV}\n<p>x</p>\n<div class="elfsight-app-${ID2}" data-elfsight-app-lazy></div>\n` })
    expect(r.reasons).toEqual([])
    expect(r.widgets).toHaveLength(2)
    expect(r.widgets[0]!.scriptAt).toEqual(r.widgets[1]!.scriptAt)
    expect(r.widgets[0]!.start).not.toBe(r.widgets[1]!.start)
  })

  test('a widget in a component lists the pages that import it', () => {
    const use = "---\nimport Feed from '../components/Feed.astro'\n---\n<main><Feed /></main>\n"
    const r = run({
      'src/components/Feed.astro': V1,
      'src/pages/index.astro': use,
      'src/pages/om.astro': use,
      'src/pages/kontakt.astro': '<main />\n',
    })
    expect(r.reasons).toEqual([])
    expect(r.widgets.map((w) => w.pages)).toEqual([['src/pages/index.astro', 'src/pages/om.astro']])
  })

  test('a widget in a layout lists the layout pages', () => {
    const r = run({ 'src/layouts/Base.astro': `<html><body><slot />${V1}</body></html>\n` }, layouts(['src/pages/a.astro', 'src/pages/b.astro']))
    expect(r.reasons).toEqual([])
    expect(r.widgets.map((w) => w.pages)).toEqual([['src/pages/a.astro', 'src/pages/b.astro']])
  })

  test('a widget in a component imported only by a layout lists the layout pages', () => {
    const r = run(
      {
        'src/components/Feed.astro': V1,
        'src/layouts/Base.astro': "---\nimport Feed from '../components/Feed.astro'\n---\n<html><body><slot /><Feed /></body></html>\n",
      },
      layouts(['src/pages/index.astro']),
    )
    expect(r.reasons).toEqual([])
    expect(r.widgets.map((w) => w.pages)).toEqual([['src/pages/index.astro']])
  })

  test('a widget in a component nobody imports has no pages', () => {
    expect(run({ 'src/components/Feed.astro': V1 }).widgets.map((w) => w.pages)).toEqual([[]])
  })
})

describe('detectWidgets: refused forms', () => {
  test('V4: a class built in a template literal inside a ternary', () => {
    const text = `---\nconst id = import.meta.env.PUBLIC_ELFSIGHT_WIDGET_ID\n---\n{id ? (\n  <Fragment>\n    <div class={\`elfsight-app-\${id}\`} data-elfsight-app-lazy></div>\n    ${SCRIPT}\n  </Fragment>\n) : (\n  <p>Följ oss</p>\n)}\n`
    const r = run({ [PAGE]: text })
    expect(r.widgets).toEqual([])
    expect(r.reasons).toContain(`elfsight: ${PAGE}: widget div class is not a literal`)
  })

  test('a literal div and script inside an expression', () => {
    const r = run({ [PAGE]: `---\nconst show = true\n---\n{show ? (<Fragment>${SCRIPT}${DIV}</Fragment>) : <p>x</p>}\n` })
    expect(r.widgets).toEqual([])
    expect(r.reasons).toContain(`elfsight: ${PAGE}: elfsight script inside an expression`)
    expect(r.reasons).toContain(`elfsight: ${PAGE}: widget div inside an expression`)
  })

  test('a script with no div, a div with no script', () => {
    expect(reasonsOf({ [PAGE]: `${SCRIPT}\n` })).toContain(`elfsight: ${PAGE}: elfsight script with no widget div`)
    expect(reasonsOf({ [PAGE]: `${DIV}\n` })).toContain(`elfsight: ${PAGE}: widget div with no elfsight script`)
  })

  test('the loader in a layout and the div in a page: both reasons', () => {
    const r = run({ 'src/layouts/Base.astro': `<html><head>${SCRIPT}</head><body><slot /></body></html>\n`, [PAGE]: `${DIV}\n` }, layouts([PAGE]))
    expect(r.widgets).toEqual([])
    expect(r.reasons).toContain('elfsight: src/layouts/Base.astro: elfsight script with no widget div')
    expect(r.reasons).toContain(`elfsight: ${PAGE}: widget div with no elfsight script`)
  })

  test('two loaders in one file', () => {
    const r = run({ [PAGE]: `${SCRIPT}\n${DIV}\n${SCRIPT}\n` })
    expect(r.widgets).toEqual([])
    expect(r.reasons).toContain(`elfsight: ${PAGE}: two elfsight scripts`)
  })

  test.each([
    ['defer', `<script src="${CDN}" defer></script>`],
    ['type', `<script type="module" src="${CDN}"></script>`],
    ['data-use-service-core', `<script src="${CDN}" data-use-service-core defer></script>`],
  ])('script attribute %s is not understood', (name, script) => {
    const r = run({ [PAGE]: `${script}\n${DIV}\n` })
    expect(r.widgets).toEqual([])
    expect(r.reasons).toContain(`elfsight: ${PAGE}: script attribute ${name} not understood`)
  })

  test('an unknown loader URL', () => {
    const url = 'https://apps.elfsight.com/p/platform.js'
    const r = run({ [PAGE]: `<script src="${url}" async></script>\n${DIV}\n` })
    expect(r.widgets).toEqual([])
    expect(r.reasons).toContain(`elfsight: ${PAGE}: loader ${url} not recognised`)
  })

  test.each([
    ['a child element', `<div class="elfsight-app-${ID}" data-elfsight-app-lazy><p>Laddar</p></div>`, 'widget div has <p>'],
    ['text', `<div class="elfsight-app-${ID}" data-elfsight-app-lazy>Laddar</div>`, 'widget div has text'],
    ['another attribute', `<div class="elfsight-app-${ID}" id="feed" data-elfsight-app-lazy></div>`, 'widget div has attribute id'],
    ['another class', `<div class="elfsight-app-${ID} mt-4" data-elfsight-app-lazy></div>`, `widget div has class elfsight-app-${ID} mt-4`],
  ])('a div with %s', (_name, div, reason) => {
    const r = run({ [PAGE]: `${SCRIPT}\n${div}\n` })
    expect(r.widgets).toEqual([])
    expect(r.reasons).toContain(`elfsight: ${PAGE}: ${reason}`)
  })
})

describe('detectWidgets: every occurrence is accounted for', () => {
  test('an inline loader beside a recognised widget', () => {
    const inline = `<script is:inline>(function(){var s=document.createElement('script');s.src='${CDN}';document.head.appendChild(s)})()</script>`
    const r = run({ [PAGE]: `${V1}${inline}\n` })
    expect(r.reasons).toEqual([OUTSIDE(PAGE)])
  })

  test('a loader URL in the frontmatter beside a recognised widget', () => {
    expect(reasonsOf({ [PAGE]: `---\nconst u = '${CDN}'\n---\n${V1}` })).toEqual([OUTSIDE(PAGE)])
  })

  test.each([
    ['src/content/blog/post.md', `Text\n\n${SCRIPT}\n`],
    ['src/lib/feed.ts', `export const loader = '${CDN}'\n`],
    ['src/data/widgets.json', `{ "loader": "${CDN}" }\n`],
    ['astro.config.mjs', `// ${CDN}\nexport default {}\n`],
    ['public/feed.js', `document.querySelector('.elfsight-app-x')\n`],
  ])('elfsight in %s', (file, text) => {
    expect(reasonsOf({ [PAGE]: V1, [file]: text })).toEqual([OUTSIDE(file)])
  })

  test('a loader in a set:html string', () => {
    const text = `<Fragment set:html={'<script src="${CDN}"></script>'} />\n`
    expect(reasonsOf({ [PAGE]: text })).toEqual([OUTSIDE(PAGE)])
  })

  test('a snippet inside an HTML comment in .astro counts for nothing', () => {
    expect(run({ [PAGE]: `<main>\n<!-- ${SCRIPT}\n${DIV} -->\n</main>\n` })).toEqual({ widgets: [], wired: [], reasons: [], parseErrors: [] })
  })

  test.each([
    ['//', `// ${CDN}\nexport {}\n`],
    ['/* */', `/* <div class="elfsight-app-${ID}"></div> */\nexport {}\n`],
  ])('a snippet inside a %s comment in a .ts file is a reason', (_kind, text) => {
    expect(reasonsOf({ 'src/lib/x.ts': text })).toEqual([OUTSIDE('src/lib/x.ts')])
  })

  test('a Content-Security-Policy line in public/_headers is not a load', () => {
    const headers = `/*\n  Content-Security-Policy: default-src 'self'; script-src 'self' https://elfsightcdn.com https://static.elfsight.com\n  X-Frame-Options: DENY\n`
    expect(reasonsOf({ 'public/_headers': headers })).toEqual([])
  })

  test('another public/_headers line naming elfsight is a reason', () => {
    expect(reasonsOf({ 'public/_headers': `/*\n  Link: <${CDN}>; rel=preload; as=script\n` })).toEqual([OUTSIDE('public/_headers')])
  })

  test('an elfsight package dependency', () => {
    const pkg = JSON.stringify({ dependencies: { astro: '^6.0.0', 'react-elfsight-widget': '^1.0.0' } })
    expect(reasonsOf({ 'package.json': pkg })).toEqual(['elfsight: package react-elfsight-widget'])
  })

  test('a frontmatter import of an elfsight module', () => {
    const text = "---\nimport Feed from 'elfsight-astro'\n---\n<Feed />\n"
    expect(reasonsOf({ [PAGE]: text })).toEqual([`elfsight: import elfsight-astro in ${PAGE}`])
  })

  test('an astro.config import of an elfsight module', () => {
    const text = "import elfsight from 'astro-elfsight'\nexport default { integrations: [elfsight()] }\n"
    expect(reasonsOf({ 'astro.config.mjs': text })).toEqual(['elfsight: import astro-elfsight in astro.config.mjs'])
  })

  test('a package ConsentWidget holding the div is already wired: no widget, no reason', () => {
    const text = `---\nimport ConsentWidget from '@visionmediahq/astro-consent/components/ConsentWidget.astro'\n---\n<ConsentWidget service="elfsight" script="${CDN}" title="Innehållet">\n  ${DIV}\n</ConsentWidget>\n`
    expect(run({ [PAGE]: text })).toEqual({ widgets: [], wired: ['elfsight'], reasons: [], parseErrors: [] })
  })

  test('a local component named ConsentWidget is not the package one', () => {
    const text = `---\nimport ConsentWidget from '../components/ConsentWidget.astro'\n---\n<ConsentWidget service="elfsight" script="${CDN}">\n  ${DIV}\n</ConsentWidget>\n`
    const r = run({ [PAGE]: text, 'src/components/ConsentWidget.astro': '<slot />\n' })
    expect(r.wired).toEqual([])
    expect(r.reasons).toContain(`elfsight: ${PAGE}: widget div with no elfsight script`)
  })

  test.each([
    ['a .css file', 'src/styles/feed.css', `.elfsight-app-${ID} { margin: 0 }\n`],
    ['a scoped <style>', PAGE, `<main />\n<style>\n  :global(.elfsight-app-${ID}) { margin: 0 }\n</style>\n`],
  ])('a CSS rule naming the widget class in %s is a reason', (_name, file, text) => {
    expect(reasonsOf({ [file]: text })).toEqual([OUTSIDE(file)])
  })

  test('the word Elfsight in visible text counts for nothing', () => {
    expect(reasonsOf({ [PAGE]: '<p>Flödet visas med Elfsight.</p>\n' })).toEqual([])
  })

  test('a file that does not parse is swept whole and reported', () => {
    const r = run({ [PAGE]: `<div>{</div>\n<!-- ${SCRIPT} -->\n` })
    expect(r.parseErrors.map((e) => e.file)).toEqual([PAGE])
    expect(r.reasons).toEqual([OUTSIDE(PAGE)])
  })
})
