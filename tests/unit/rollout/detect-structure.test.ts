import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { detectStructure } from '../../../ci/rollout/detect/structure'
import { diskSite, fixtureSite, globToRegExp, type SiteFiles } from '../../../ci/rollout/lib/site-files'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const pilot = (site: string) => fixtureSite(join(FIXTURES, site, 'before'))
const fixtureText = (site: string, path: string) => readFileSync(join(FIXTURES, site, 'before', `${path}.txt`), 'utf8')

const dirs: string[] = []
function inline(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'detect-structure-'))
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

/** `base` with extra in-memory files on top. */
function withFiles(base: SiteFiles, extra: Record<string, string>): SiteFiles {
  return {
    root: base.root,
    list: (glob) => [...new Set([...base.list(glob), ...Object.keys(extra).filter((p) => globToRegExp(glob).test(p))])].sort(),
    read: (path) => extra[path] ?? base.read(path),
    exists: (path) => path in extra || base.exists(path),
  }
}

const LAYOUT = `---
import SiteFooter from '../components/SiteFooter.astro'
---
<html lang="sv"><body><slot /><SiteFooter /></body></html>
`
const FOOTER = `<footer class="bg-neutral text-neutral-content/80 py-6"><p>©</p></footer>\n`

describe('detectStructure: pilot fixtures', () => {
  test('munkfors: one layout whose footer component is the VisionFooter strip; client footer rendered by the start page', () => {
    const r = detectStructure(pilot('munkforstradgardstjanst'))
    const base = fixtureText('munkforstradgardstjanst', 'src/layouts/Base.astro')
    expect(r.layouts).toEqual([
      {
        file: 'src/layouts/Base.astro',
        pages: ['src/pages/404.astro', 'src/pages/index.astro'],
        footerRef: { name: 'VisionFooter', start: base.indexOf('<VisionFooter') },
      },
    ])
    const footer = fixtureText('munkforstradgardstjanst', 'src/components/Footer.astro')
    expect(r.footers).toEqual([
      {
        file: 'src/components/Footer.astro',
        start: footer.indexOf('<footer'),
        end: footer.indexOf('</footer>') + '</footer>'.length,
        kind: 'component',
        textClass: 'text-neutral-content',
        centred: false,
        alignment: 'left',
      },
    ])
    expect(r.footerless).toEqual(['src/pages/404.astro'])
    expect(r.policyPage).toBeNull()
    expect(r.parseErrors).toEqual([])
  })

  test('vasshalla: the privacy page is /gdpr', () => {
    expect(detectStructure(pilot('vasshallakatthotell')).policyPage).toBe('/gdpr')
  })

  test('domeij: the layout has no footer; the start page renders the footer itself; 404 is footerless', () => {
    const r = detectStructure(pilot('domeijstapetserarverkstad'))
    expect(r.layouts).toEqual([
      { file: 'src/layouts/Base.astro', pages: ['src/pages/404.astro', 'src/pages/index.astro'], footerRef: null },
    ])
    // VisionFooter.astro is in the repo but rendered nowhere.
    expect(r.footers.map((f) => [f.file, f.kind, f.textClass, f.centred])).toEqual([
      ['src/components/Footer.astro', 'component', null, false],
    ])
    expect(r.footerless).toEqual(['src/pages/404.astro'])
  })

  test('traforadling: a meta-refresh redirect page is not footerless; the splash start page is', () => {
    const site = withFiles(pilot('traforadling'), {
      'src/pages/levene_sag_ab.astro': `---
---
<html><head><meta http-equiv="refresh" content="0; url=/kontakt-levene" /><title>Levene</title></head></html>
`,
    })
    const r = detectStructure(site)
    expect(r.footerless).toEqual(['src/pages/404.astro', 'src/pages/index.astro'])
    expect(r.footers.map((f) => f.file)).toEqual(['src/components/FooterLevene.astro', 'src/components/FooterSkaraborg.astro'])
    expect(r.layouts.map((l) => l.file)).toEqual(['src/layouts/Base.astro'])
  })

  test.each([
    ['a-tak', 'VisionFooter', ['src/components/Footer.astro'], ['src/pages/404.astro']],
    ['aspomad', 'Footer', ['src/components/Footer.astro'], []],
    ['domeijstapetserarverkstad', null, ['src/components/Footer.astro'], ['src/pages/404.astro']],
    ['munkforstradgardstjanst', 'VisionFooter', ['src/components/Footer.astro'], ['src/pages/404.astro']],
    ['nhrk', 'VisionFooter', ['src/components/Footer.astro'], ['src/pages/404.astro']],
    [
      'traforadling',
      'VisionFooter',
      ['src/components/FooterLevene.astro', 'src/components/FooterSkaraborg.astro'],
      ['src/pages/404.astro', 'src/pages/index.astro'],
    ],
    // OmOssContent's <footer> belongs to a <blockquote>, not to the page.
    ['vasshallakatthotell', 'VisionFooter', ['src/components/Footer.astro'], ['src/pages/404.astro']],
  ])('%s: footerRef, footers and footerless match where the pilot placed things', (site, ref, footers, footerless) => {
    const r = detectStructure(pilot(site))
    expect(r.layouts).toHaveLength(1)
    expect(r.layouts[0]!.footerRef?.name ?? null).toBe(ref)
    expect(r.footers.map((f) => f.file)).toEqual(footers)
    expect(r.footerless).toEqual(footerless)
    expect(r.parseErrors).toEqual([])
  })
})

describe('detectStructure: synthetic cases', () => {
  test('a page with no layout and no <footer> is footerless', () => {
    const r = detectStructure(inline({ 'src/pages/bare.astro': '<main><h1>Hej</h1></main>\n' }))
    expect(r.layouts).toEqual([])
    expect(r.footerless).toEqual(['src/pages/bare.astro'])
  })

  test('a frontmatter Astro.redirect page is not footerless', () => {
    const r = detectStructure(
      inline({ 'src/pages/old.astro': "---\nreturn Astro.redirect('/new')\n---\n", 'src/pages/new.astro': '<main />\n' }),
    )
    expect(r.footerless).toEqual(['src/pages/new.astro'])
  })

  test('a meta refresh next to visible content is not redirect-only', () => {
    const r = detectStructure(
      inline({
        'src/pages/moved.astro': '<html><head><meta http-equiv="Refresh" content="0; url=/" /></head><body><p>Flyttad</p></body></html>\n',
      }),
    )
    expect(r.footerless).toEqual(['src/pages/moved.astro'])
  })

  test('a head-only page without a meta refresh is not redirect-only', () => {
    const r = detectStructure(inline({ 'src/pages/blank.astro': '<html><head><title>Tom</title></head></html>\n' }))
    expect(r.footerless).toEqual(['src/pages/blank.astro'])
  })

  test('404 with its own <html> is footerless and not a layout', () => {
    const r = detectStructure(
      inline({
        'src/layouts/Main.astro': LAYOUT,
        'src/components/SiteFooter.astro': FOOTER,
        'src/pages/index.astro': "---\nimport Main from '../layouts/Main.astro'\n---\n<Main><main /></Main>\n",
        'src/pages/404.astro': '<html><body><main><h1>404</h1></main></body></html>\n',
      }),
    )
    expect(r.layouts.map((l) => [l.file, l.pages])).toEqual([['src/layouts/Main.astro', ['src/pages/index.astro']]])
    expect(r.footerless).toEqual(['src/pages/404.astro'])
  })

  test.each([
    ['a-tak', [false]],
    ['aspomad', [true]],
    ['domeijstapetserarverkstad', [false]],
    ['munkforstradgardstjanst', [false]],
    ['nhrk', [true]],
    ['traforadling', [false, false]],
    ['vasshallakatthotell', [false]],
  ])('%s: centred follows the footer\'s last-child chain', (site, centred) => {
    expect(detectStructure(pilot(site)).footers.map((f) => f.centred)).toEqual(centred)
  })

  test.each([
    ['a-tak', ['left']],
    ['aspomad', ['centred']],
    // the chain's only alignment is md:text-right
    ['domeijstapetserarverkstad', ['unknown']],
    ['munkforstradgardstjanst', ['left']],
    ['nhrk', ['centred']],
    // centred by scoped CSS, which detect cannot see
    ['traforadling', ['unknown', 'unknown']],
    ['vasshallakatthotell', ['left']],
  ])('%s: alignment follows the footer\'s last-child chain', (site, alignment) => {
    const footers = detectStructure(pilot(site)).footers
    expect(footers.map((f) => f.alignment)).toEqual(alignment)
    expect(footers.map((f) => f.centred)).toEqual(alignment.map((a) => a === 'centred'))
  })

  test('alignment: left for an explicit split or start row, unknown when the chain has no alignment utility', () => {
    const page = (footer: string) => inline({ 'src/pages/index.astro': `${footer}\n` })
    const alignment = (footer: string) => detectStructure(page(footer)).footers[0]!.alignment
    expect(alignment('<footer><div class="border-t text-center"><p>©</p></div></footer>')).toBe('centred')
    expect(alignment('<footer><div class="flex flex-col md:flex-row items-center justify-between"><p>©</p><p>by</p></div></footer>')).toBe('left')
    expect(alignment('<footer><div class="flex justify-start text-center"><p>©</p><p>by</p></div></footer>')).toBe('left')
    expect(alignment('<footer><div class="text-left"><p>©</p><p class="text-center">by</p></div></footer>')).toBe('left')
    // a split class on a row with one child does not stop the chain
    expect(alignment('<footer><div class="flex justify-between"><div class="text-center"><p>©</p></div></div></footer>')).toBe('centred')
    expect(alignment('<footer><div class="flex justify-between"><div><p>©</p></div></div></footer>')).toBe('unknown')
    // Ruling 27: text-left and justify-start mark left on any element of the chain; justify-between needs a row
    expect(alignment('<footer class="text-left"><div><p>©</p></div></footer>')).toBe('left')
    expect(alignment('<footer><div class="justify-start"><p>©</p></div></footer>')).toBe('left')
    expect(alignment('<footer><div class="flex justify-between"><p>©</p></div></footer>')).not.toBe('left')
    // no alignment utility anywhere on the chain
    expect(alignment('<footer class="footer"><div class="footer-bottom"><p>©</p><p>by</p></div></footer>')).toBe('unknown')
    expect(alignment('<footer><div><p>©</p></div></footer>')).toBe('unknown')
    expect(alignment('<footer><div class="md:text-right"><p>©</p><p>by</p></div></footer>')).toBe('unknown')
    // a component's markup is not visible here
    expect(alignment('<footer><div><Links /></div></footer>')).toBe('unknown')
  })

  test('centred: a text-center row at the end of the last-child chain', () => {
    const page = (footer: string) => inline({ 'src/pages/index.astro': `${footer}\n` })
    const centred = (footer: string) => detectStructure(page(footer)).footers[0]!.centred
    // nhrk's shape: footer > wrapper > [grid, centred © row]
    expect(centred('<footer><div class="mx-auto"><div class="grid"><p>a</p><p>b</p></div><div class="border-t text-center"><p>©</p></div></div></footer>')).toBe(true)
    expect(centred('<footer><div><div class="flex justify-center"><a>x</a></div></div></footer>')).toBe(true)
    // a split bottom row stops the chain, even with items-center on a flex-col
    expect(centred('<footer><div class="flex flex-col md:flex-row items-center justify-between"><p>©</p><p>by</p></div></footer>')).toBe(false)
    expect(centred('<footer><div class="flex justify-start text-center"><p>©</p><p>by</p></div></footer>')).toBe(false)
    expect(centred('<footer><div class="text-left"><p>©</p><p class="text-center">by</p></div></footer>')).toBe(false)
    // a split class on a row with one child does not stop the chain
    expect(centred('<footer><div class="flex justify-between"><div class="text-center"><p>©</p></div></div></footer>')).toBe(true)
    // the chain ends without a centring class; a centred row that is not last does not count
    expect(centred('<footer><div class="text-center"><p>©</p></div><div><p>by</p></div></footer>')).toBe(false)
    expect(centred('<footer><div><p>©</p></div></footer>')).toBe(false)
    // a component's markup is not visible here: the chain ends
    expect(centred('<footer><div><Links /></div></footer>')).toBe(false)
  })

  test('a footer is centred when its class has text-center or justify-center', () => {
    const files = (cls: string) =>
      inline({ 'src/pages/index.astro': `<html><body><main /><footer class="${cls}">©</footer></body></html>\n` })
    expect(detectStructure(files('bg-base-200 text-center p-4')).footers[0]!.centred).toBe(true)
    expect(detectStructure(files('flex justify-center')).footers[0]!.centred).toBe(true)
    expect(detectStructure(files('flex justify-between md:text-center')).footers[0]!.centred).toBe(false)
  })

  test('textClass is the text colour class, not a size or alignment', () => {
    const r = detectStructure(
      inline({
        'src/layouts/Main.astro': LAYOUT,
        'src/components/SiteFooter.astro': FOOTER,
        'src/pages/index.astro': "---\nimport Main from '../layouts/Main.astro'\n---\n<Main />\n",
      }),
    )
    expect(r.footers.map((f) => [f.kind, f.textClass, f.centred])).toEqual([['component', 'text-neutral-content/80', false]])
    const sized = detectStructure(
      inline({ 'src/pages/index.astro': '<footer class="text-sm text-center text-white/70">©</footer>\n' }),
    )
    expect(sized.footers.map((f) => [f.kind, f.textClass, f.centred])).toEqual([['page', 'text-white/70', true]])
  })

  test('a <footer> written in a layout is kind layout; the layout then has no footerRef', () => {
    const layout = '<html><body><slot /><footer class="text-base-content">©</footer></body></html>\n'
    const r = detectStructure(
      inline({
        'src/layouts/Main.astro': layout,
        'src/pages/index.astro': "---\nimport Main from '../layouts/Main.astro'\n---\n<Main />\n",
      }),
    )
    expect(r.footers).toEqual([
      {
        file: 'src/layouts/Main.astro',
        start: layout.indexOf('<footer'),
        end: layout.indexOf('</footer>') + 9,
        kind: 'layout',
        textClass: 'text-base-content',
        centred: false,
        alignment: 'unknown',
      },
    ])
    expect(r.layouts[0]!.footerRef).toBeNull()
    expect(r.footerless).toEqual([])
  })

  test('footerRef uses the local import name, which may differ from the file name', () => {
    const layout = `---
import Bottom from '../components/SiteFooter.astro'
---
<html><body><slot /><Bottom /></body></html>
`
    const r = detectStructure(
      inline({
        'src/layouts/Main.astro': layout,
        'src/components/SiteFooter.astro': FOOTER,
        'src/pages/index.astro': "---\nimport Main from '../layouts/Main.astro'\n---\n<Main />\n",
      }),
    )
    expect(r.layouts[0]!.footerRef).toEqual({ name: 'Bottom', start: layout.indexOf('<Bottom') })
  })

  test('layout via import alias: a page importing Main.astro as L and rendering <L> uses it', () => {
    const r = detectStructure(
      inline({
        'src/layouts/Main.astro': LAYOUT,
        'src/components/SiteFooter.astro': FOOTER,
        'src/pages/a/index.astro': "---\nimport L from '../../layouts/Main.astro'\n---\n<L><main /></L>\n",
        'src/pages/b.astro': "---\nimport L from '../layouts/Main.astro'\n---\n<main />\n",
      }),
    )
    // b.astro imports the layout but never renders it.
    expect(r.layouts.map((l) => l.pages)).toEqual([['src/pages/a/index.astro']])
    expect(r.footerless).toEqual(['src/pages/b.astro'])
  })

  test('policyPage is the route of a privacy page, or null', () => {
    const page = '<main />\n'
    expect(detectStructure(inline({ 'src/pages/integritetspolicy.astro': page })).policyPage).toBe('/integritetspolicy')
    expect(detectStructure(inline({ 'src/pages/cookies/index.astro': page })).policyPage).toBe('/cookies')
    expect(detectStructure(inline({ 'src/pages/om-oss.astro': page })).policyPage).toBeNull()
    expect(detectStructure(inline({ 'src/pages/gdpr.astro': page })).policyPage).toBe('/gdpr')
    expect(detectStructure(inline({ 'src/pages/GDPR-policy.astro': page })).policyPage).toBe('/GDPR-policy')
    expect(detectStructure(inline({ 'src/pages/dataskyddspolicy.astro': page })).policyPage).toBe('/dataskyddspolicy')
    expect(detectStructure(inline({ 'src/pages/om/dataskydd.md': page })).policyPage).toBe('/om/dataskydd')
  })

  test('pages prefixed with _ are not routes', () => {
    const r = detectStructure(inline({ 'src/pages/_draft.astro': '<main />\n', 'src/pages/_privacy.astro': '<main />\n' }))
    expect(r.footerless).toEqual([])
    expect(r.policyPage).toBeNull()
  })

  test('a file that does not parse is recorded and skipped', () => {
    const r = detectStructure(
      inline({ 'src/pages/broken.astro': '---\nconst a = 1\n---\n<div>{</div>\n', 'src/pages/ok.astro': '<main />\n' }),
    )
    expect(r.parseErrors.map((e) => e.file)).toEqual(['src/pages/broken.astro'])
    expect(r.parseErrors[0]!.message).toMatch(/parse error/i)
    expect(r.footerless).toEqual(['src/pages/ok.astro'])
  })

  test('multiFooterPages: a page that renders more than one client footer, counting repeated uses', () => {
    const r = detectStructure(
      inline({
        'src/layouts/Main.astro': LAYOUT,
        'src/components/SiteFooter.astro': FOOTER,
        'src/pages/index.astro': `---\nimport Main from '../layouts/Main.astro'\n---\n<Main><main /></Main>\n`,
        'src/pages/twice.astro':
          `---\nimport Main from '../layouts/Main.astro'\nimport SiteFooter from '../components/SiteFooter.astro'\n---\n<Main><main /><SiteFooter /></Main>\n`,
        'src/pages/own.astro': '<html><body><main /><footer>a</footer><footer>b</footer></body></html>\n',
      }),
    )
    expect(r.multiFooterPages).toEqual([
      { page: 'src/pages/own.astro', footers: 2 },
      { page: 'src/pages/twice.astro', footers: 2 },
    ])
  })

  test('multiFooterPages is empty on every pilot fixture', () => {
    for (const site of ['a-tak', 'aspomad', 'domeijstapetserarverkstad', 'munkforstradgardstjanst', 'nhrk', 'traforadling', 'vasshallakatthotell']) {
      expect(detectStructure(pilot(site)).multiFooterPages, site).toEqual([])
    }
  })
})
