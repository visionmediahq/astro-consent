import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { detect } from '../../../ci/rollout/detect'
import { detectIframes } from '../../../ci/rollout/detect/iframes'
import { servicesOf } from '../../../ci/rollout/lib/report'
import { detectStructure } from '../../../ci/rollout/detect/structure'
import { fixtureSite, globToRegExp, type SiteFiles } from '../../../ci/rollout/lib/site-files'
import { wireEmbeds } from '../../../ci/rollout/wire/embeds'
import { INSTALL_SPEC } from '../../../ci/rollout/wire/index'
import { applyEdits, Planner } from '../../../ci/rollout/wire/engine'
import { wireLayout } from '../../../ci/rollout/wire/layout'
import { wireLinks } from '../../../ci/rollout/wire/links'
import { wirePrivacy } from '../../../ci/rollout/wire/privacy'
import { wireWidgets } from '../../../ci/rollout/wire/widgets'
import type { Report, WirePlan } from '../../../ci/rollout/types'

type Part = (p: Planner, r: Report) => void

const FIXTURES = join(import.meta.dirname, 'fixtures')
const WIRED = [
  'site-1218869363',
  'calendar-literal',
  'site-1243511314',
  'elfsight-v1',
  'elfsight-v2-after',
  'elfsight-v2-before',
  'elfsight-v3',
  'site-1286040212',
  'site-1243335919',
  'site-1245311266',
]
const expectedText = (site: string, path: string) => readFileSync(join(FIXTURES, site, 'expected', `${path}.txt`), 'utf8')

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

/** A report from detect's structure and iframe passes over `files`, the rest filled in. */
function reportFor(files: SiteFiles, over: Partial<Report> = {}): Report {
  const s = detectStructure(files)
  const f = detectIframes(files, ['x.se'])
  return {
    site: 'x',
    domains: ['x.se'],
    astro: { major: 6, output: 'static' },
    config: { path: 'astro.config.ts', hasIntegrations: true, hasTailwindVite: true, isDefineConfigObject: true },
    css: { entry: 'src/styles/global.css', tailwindMajor: 4, daisyuiMajor: 5, primaries: [] },
    layouts: s.layouts,
    footers: s.footers,
    footerless: s.footerless,
    policyPage: s.policyPage,
    iframes: f.iframes,
    trackers: [],
    banners: [],
    recaptcha: false,
    inventedMaps: [],
    alreadyWired: [],
    services: servicesOf({ iframes: f.iframes, widgets: [] }),
    widgets: [],
    classification: f.iframes.some((i) => i.service === 'google-maps') ? 'consent' : 'notice',
    reasons: [],
    ...over,
  }
}

function plan(parts: Part[], files: SiteFiles, r: Report): WirePlan {
  const p = new Planner(files)
  for (const part of parts) part(p, r)
  return p.result()
}

/** `path` after the plan's edits. */
function after(result: WirePlan, files: SiteFiles, path: string): string {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.refusals)}`)
  return applyEdits(files.read(path), result.edits.filter((e) => e.file === path))
}

const refusals = (result: WirePlan): string[] => (result.ok ? [] : result.refusals.map((r) => r.reason))

/** Runs `parts` on a synthetic site and returns `path` afterwards. */
function wire(parts: Part[], files: Record<string, string>, path: string, over: Partial<Report> = {}): string {
  const site = memSite(files)
  return after(plan(parts, site, reportFor(site, over)), site, path)
}

const LAYOUT_HEAD = `---
import Footer from '../components/Footer.astro'
import '../styles/global.css'
---

<html lang="sv">
  <body>
    <slot />
`
const FOOTER = `<footer class="bg-neutral text-neutral-content">
  <div class="container mx-auto">
    <p>Adress</p>
    <p>© Firma</p>
  </div>
</footer>
`
const PAGE = `---
import Base from '../layouts/Base.astro'
---

<Base>
  <h1>Hej</h1>
</Base>
`

/** Every wired pilot fixture: detect on before/, then all four parts. */
function fixturePlan(site: string): { files: SiteFiles; result: WirePlan } {
  const files = fixtureSite(join(FIXTURES, site, 'before'))
  const report = detect(files, site, [`${site}.se`])
  return { files, result: plan([wireLayout, wireLinks, wirePrivacy, wireEmbeds], files, report) }
}

describe('wireLayout', () => {
  test('footer component referenced: <ConsentBanner /> on the line before <Footer />, same indent', () => {
    const text = wire(
      [wireLayout],
      {
        'src/layouts/Base.astro': `${LAYOUT_HEAD}    <Footer />\n  </body>\n</html>\n`,
        'src/components/Footer.astro': FOOTER,
        'src/pages/index.astro': PAGE,
      },
      'src/layouts/Base.astro',
    )
    expect(text).toContain('    <slot />\n    <ConsentBanner />\n    <Footer />\n  </body>')
  })

  test('footer component renamed (Review Focus 1): <Foot /> from SiteFooter.astro gets the banner before it', () => {
    const text = wire(
      [wireLayout],
      {
        'src/layouts/Base.astro': `---\nimport Foot from '../components/SiteFooter.astro'\n---\n<html><body>\n\t<slot />\n\t<Foot />\n</body></html>\n`,
        'src/components/SiteFooter.astro': FOOTER,
        'src/pages/index.astro': PAGE,
      },
      'src/layouts/Base.astro',
    )
    expect(text).toContain('\t<slot />\n\t<ConsentBanner />\n\t<Foot />\n')
  })

  test('no footer in the layout: the last child of <body>, before </body>', () => {
    const text = wire(
      [wireLayout],
      { 'src/layouts/Base.astro': `${LAYOUT_HEAD.replace("import Footer from '../components/Footer.astro'\n", '')}    <script>console.log(1)</script>\n  </body>\n</html>\n`, 'src/pages/index.astro': PAGE },
      'src/layouts/Base.astro',
    )
    expect(text).toContain('    <script>console.log(1)</script>\n    <ConsentBanner />\n  </body>')
  })

  test('a <footer> element in the layout itself: the banner goes right before it', () => {
    const text = wire(
      [wireLayout],
      { 'src/layouts/Base.astro': `---\n---\n<html><body>\n  <slot />\n  <footer class="p-4"><p>©</p></footer>\n</body></html>\n`, 'src/pages/index.astro': PAGE },
      'src/layouts/Base.astro',
    )
    expect(text).toContain('  <slot />\n  <ConsentBanner />\n  <footer class="p-4">')
  })

  test('the frontmatter import is appended after the last import line, in its quote and semicolon style', () => {
    const text = wire(
      [wireLayout],
      {
        'src/layouts/Base.astro': `---\nimport Footer from "../components/Footer.astro";\nimport "../styles/global.css"; // stilar\n\nconst { title } = Astro.props;\n---\n<html><body><slot /><Footer /></body></html>\n`,
        'src/components/Footer.astro': FOOTER,
        'src/pages/index.astro': PAGE,
      },
      'src/layouts/Base.astro',
    )
    expect(text.split('\n').slice(0, 4)).toEqual([
      '---',
      'import Footer from "../components/Footer.astro";',
      'import "../styles/global.css"; // stilar',
      'import ConsentBanner from "@visionmediahq/astro-consent/components/ConsentBanner.astro";',
    ])
    // Not at the start of a line: inline, right before the footer.
    expect(text).toContain('<slot /><ConsentBanner /><Footer />')
  })

  test('no imports: first in the frontmatter, semicolon taken from the first statement; no frontmatter: a new one', () => {
    const noImports = wire(
      [wireLayout],
      { 'src/layouts/Base.astro': `---\nconst year = 2026;\n---\n<html><body><slot /></body></html>\n`, 'src/pages/index.astro': PAGE },
      'src/layouts/Base.astro',
    )
    expect(noImports.startsWith("---\nimport ConsentBanner from '@visionmediahq/astro-consent/components/ConsentBanner.astro';\nconst year")).toBe(true)
    const noFrontmatter = wire(
      [wireLayout],
      { 'src/layouts/Base.astro': `<html><body><slot /></body></html>\n`, 'src/pages/index.astro': PAGE },
      'src/layouts/Base.astro',
    )
    expect(noFrontmatter).toBe(
      "---\nimport ConsentBanner from '@visionmediahq/astro-consent/components/ConsentBanner.astro'\n---\n<html><body><slot /><ConsentBanner /></body></html>\n",
    )
  })

  test('a banner anywhere in the layout (moved by hand) and its import: both skipped, no edits', () => {
    const files = memSite({
      'src/layouts/Base.astro': `---\nimport Footer from '../components/Footer.astro'\nimport ConsentBanner from '@visionmediahq/astro-consent/components/ConsentBanner.astro'\n---\n<html><body><ConsentBanner /><slot /><Footer /></body></html>\n`,
      'src/components/Footer.astro': FOOTER,
      'src/pages/index.astro': PAGE,
    })
    expect(plan([wireLayout], files, reportFor(files))).toEqual({
      ok: true,
      edits: [],
      newFiles: [],
      skipped: ['ConsentBanner import (src/layouts/Base.astro)', 'banner (src/layouts/Base.astro)'],
    })
  })

  test('the footer rendered twice in the layout: refused', () => {
    const files = memSite({
      'src/layouts/Base.astro': `---\nimport Footer from '../components/Footer.astro'\n---\n<html><body><slot /><Footer /><Footer /></body></html>\n`,
      'src/components/Footer.astro': FOOTER,
      'src/pages/index.astro': PAGE,
    })
    expect(refusals(plan([wireLayout], files, reportFor(files)))).toEqual(['found 2, expected exactly 1'])
  })

  test.each(WIRED)('%s: the layout comes out as expected/', (site) => {
    const { files, result } = fixturePlan(site)
    expect(after(result, files, 'src/layouts/Base.astro')).toBe(expectedText(site, 'src/layouts/Base.astro'))
  })
})

describe('wireLinks', () => {
  const site = (footer: string, extra: Record<string, string> = {}) => ({
    'src/layouts/Base.astro': `${LAYOUT_HEAD}    <Footer />\n  </body>\n</html>\n`,
    'src/components/Footer.astro': footer,
    'src/pages/index.astro': PAGE,
    ...extra,
  })

  test('footer text class copied; a centred footer gets no justify-start!', () => {
    const text = wire(
      [wireLinks],
      site(`<footer class="bg-neutral text-neutral-content/80">\n  <div class="container text-center">\n    <p>Adress</p>\n    <p>©</p>\n  </div>\n</footer>\n`),
      'src/components/Footer.astro',
    )
    expect(text).toBe(
      "---\nimport PrivacyLinks from '@visionmediahq/astro-consent/components/PrivacyLinks.astro'\n---\n<footer class=\"bg-neutral text-neutral-content/80\">\n  <div class=\"container text-center\">\n    <p>Adress</p>\n    <p>©</p>\n    <PrivacyLinks class=\"text-neutral-content/80 mt-2\" />\n  </div>\n</footer>\n",
    )
  })

  test.each([
    ['a split footer (justify-between row)', '<div class="flex justify-between">\n      <p>Firma</p>\n      <p>Vision Media</p>\n    </div>'],
    ['a left-aligned footer (text-left)', '<div class="text-left">\n      <p>Firma</p>\n    </div>'],
  ])('%s with no © bar gets justify-start!', (_name, bar) => {
    const text = wire(
      [wireLinks],
      site(`<footer class="text-white">\n  <div class="container">\n    <div class="grid"><p>a</p><p>b</p></div>\n    ${bar}\n  </div>\n</footer>\n`),
      'src/components/Footer.astro',
    )
    expect(text).toContain('    <PrivacyLinks class="text-white justify-start!" />\n  </div>\n</footer>')
  })

  test('a footer aligned only by its own CSS (alignment unknown), no © bar: no justify-start!', () => {
    const text = wire(
      [wireLinks],
      site(`<footer class="site-footer">\n  <div class="inner"><p>a</p></div>\n  <div class="bottom"><p>Firma</p></div>\n</footer>\n`),
      'src/components/Footer.astro',
    )
    expect(text).toContain('  <div class="bottom"><p>Firma</p></div>\n  <PrivacyLinks />\n</footer>')
  })

  // #47: a footer with several sections got the links after its © bottom bar, outside every
  // container. They go into the bar now, right after the © element, in its row.
  describe('the © bottom bar (#47)', () => {
    const real = (name: string): string => readFileSync(join(FIXTURES, `footer-${name}.astro.txt`), 'utf8')
    const POLICY_PAGE = { 'src/pages/integritetspolicy.astro': PAGE }
    const tags = (text: string): number => text.split('<PrivacyLinks').length - 1

    test('a client footer: in the bar after ©, before "Drivs av"; white text (the footer CSS sets color: #fff)', () => {
      const text = wire([wireLinks], site(real('site-1264859170')), 'src/components/Footer.astro')
      expect(text).toContain(
        'Alla rättigheter förbehållna.\n      </p>\n      <PrivacyLinks class="text-white/70" />\n      <p class="text-xs" style="color: rgba(255,255,255,0.5);">\n        Drivs av',
      )
      expect(text).toContain('    </div>\n  </div>\n</footer>')
      expect(tags(text)).toBe(1)
    })

    test('a DaisyUI .footer grid: between © and the logo; colours only in CSS variables, so no class', () => {
      const text = wire([wireLinks], site(real('site-1224521538')), 'src/components/Footer.astro')
      expect(text).toContain('Alla rättigheter förbehållna.</p>\n    <PrivacyLinks />\n    <Image\n')
      expect(text).toContain('    />\n  </div>\n</footer>')
      expect(tags(text)).toBe(1)
    })

    test("a © bar with its own Integritetspolicy link: the bar's own link to policy_url is replaced (PrivacyLinks renders it)", () => {
      const text = wire([wireLinks], site(real('site-1236396223'), POLICY_PAGE), 'src/components/Footer.astro')
      expect(text).toContain('Verkstad AB.\n      </p>\n      <PrivacyLinks class="text-white/70" />\n    </div>\n  </div>\n</footer>')
      expect(text).not.toContain('<p class="footer-legal">')
      // The column link above the bar stays.
      expect(text).toContain('<li><a href="/integritetspolicy/" class="footer-link">Integritetspolicy</a></li>')
      expect(tags(text)).toBe(1)
    })

    test('the same © bar with an existing privacy.json: its policy_url path decides', () => {
      const privacy = (url: string) => ({ 'src/data/privacy.json': JSON.stringify({ services: [], policy_url: url }) })
      const same = wire([wireLinks], site(real('site-1236396223'), privacy('https://x.se/integritetspolicy')), 'src/components/Footer.astro')
      expect(same).not.toContain('<p class="footer-legal">')
      const other = wire([wireLinks], site(real('site-1236396223'), { ...POLICY_PAGE, ...privacy('https://x.se/gdpr/') }), 'src/components/Footer.astro')
      expect(other).toContain('<p class="footer-legal">')
    })

    test.each([
      ['no policy page', {}],
      ['a policy page at another path', { 'src/pages/gdpr.astro': PAGE }],
    ])('the same © bar with %s: the link stays, the links go after ©', (_name, extra) => {
      const text = wire([wireLinks], site(real('site-1236396223'), extra), 'src/components/Footer.astro')
      expect(text).toContain('Verkstad AB.\n      </p>\n      <PrivacyLinks class="text-white/70" />\n      <p class="footer-legal">')
    })

    // #61: the bar's own policy link deeper than the © row's siblings.
    test('a policy link in a neighbouring flex div of the bar is replaced in place', () => {
      const text = wire(
        [wireLinks],
        site('<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="flex justify-between">\n    <p>© Firma</p>\n    <div class="flex items-center gap-5">\n      <a href="/integritetspolicy/" class="text-xs">Integritetspolicy</a>\n      <span class="text-xs">Exempelby</span>\n    </div>\n  </div>\n</footer>\n', POLICY_PAGE),
        'src/components/Footer.astro',
      )
      expect(text).toContain('    <p>© Firma</p>\n    <div class="flex items-center gap-5">\n      <PrivacyLinks class="text-white" />\n      <span class="text-xs">Exempelby</span>')
      expect(text).not.toContain('Integritetspolicy</a>')
      expect(tags(text)).toBe(1)
    })

    test("the GDPR item in the bar's link list, href from a localize() call, becomes the links (justify-start! in a block <li>)", () => {
      const text = wire(
        [wireLinks],
        site("<footer class=\"text-white\">\n  <div class=\"grid\"><p>a</p><p>b</p></div>\n  <div class=\"flex flex-col\">\n    <p>© {year} Firma</p>\n    <ul class=\"flex gap-x-6\">\n      <li><a href=\"mailto:x@y.se\">x@y.se</a></li>\n      <li><a href={localize('/gdpr/', lang)} class=\"topbar-link\">GDPR</a></li>\n    </ul>\n  </div>\n</footer>\n", { 'src/pages/gdpr.astro': PAGE }),
        'src/components/Footer.astro',
      )
      expect(text).toContain('      <li><PrivacyLinks class="text-white justify-start!" /></li>\n    </ul>')
      expect(text).toContain('    <p>© {year} Firma</p>\n    <ul')
      expect(tags(text)).toBe(1)
    })

    test('a policy link inside a sentence, or two of them, stays: the links go after ©', () => {
      for (const deep of ['<p>Läs vår <a href="/integritetspolicy/">integritetspolicy</a>.</p>', '<div class="flex"><a href="/integritetspolicy/">A</a><a href="/integritetspolicy">B</a></div>']) {
        const text = wire(
          [wireLinks],
          site(`<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="flex">\n    <p>© Firma</p>\n    ${deep}\n  </div>\n</footer>\n`, POLICY_PAGE),
          'src/components/Footer.astro',
        )
        expect(text).toContain(`    <p>© Firma</p>\n    <PrivacyLinks class="text-white" />\n    ${deep}`)
      }
    })

    test('review of #63: a policy link with a phrasing or address ancestor anywhere stays (no <nav> inside <p>)', () => {
      for (const deep of [
        '<p>Läs <u><a href="/integritetspolicy/">integritetspolicy</a></u></p>',
        '<p>Se <abbr title="x"><a href="/integritetspolicy/">GDPR</a></abbr></p>',
        '<address>Storgatan 1<div><a href="/integritetspolicy/">Integritetspolicy</a></div></address>',
        '<dl><dt><a href="/integritetspolicy/">Integritetspolicy</a></dt><dd>Läs</dd></dl>',
      ]) {
        const text = wire(
          [wireLinks],
          site(`<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="flex">\n    <p>© Firma</p>\n    ${deep}\n  </div>\n</footer>\n`, POLICY_PAGE),
          'src/components/Footer.astro',
        )
        expect(text).toContain(`    <p>© Firma</p>\n    <PrivacyLinks class="text-white" />\n    ${deep}`)
      }
      // A wrapper that holds only the link is replaced whole, so nothing is left inside a <p>.
      const whole = wire(
        [wireLinks],
        site('<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="flex">\n    <p>© Firma</p>\n    <p><abbr title="x"><a href="/integritetspolicy/">GDPR</a></abbr></p>\n  </div>\n</footer>\n', POLICY_PAGE),
        'src/components/Footer.astro',
      )
      expect(whole).toContain('    <p>© Firma</p>\n    <PrivacyLinks class="text-white" />\n  </div>')
    })

    test('re-review of #63: only flow containers may hold the links; hidden or decorative content never does', () => {
      for (const deep of [
        '<div><u><a href="/integritetspolicy/">P</a></u><span>x</span></div>',
        '<div><pre>x <a href="/integritetspolicy/">P</a></pre><span>x</span></div>',
        '<div><svg viewBox="0 0 1 1"><title>t</title><a href="/integritetspolicy/">P</a></svg><span>x</span></div>',
        '<div aria-hidden="true"><div><a href="/integritetspolicy/">P</a></div><span>x</span></div>',
        '<div class="hidden md:flex"><a href="/integritetspolicy/">P</a><span>x</span></div>',
        '<div class="max-md:hidden"><a href="/integritetspolicy/">P</a><span>x</span></div>',
        '<div hidden><a href="/integritetspolicy/">P</a><span>x</span></div>',
      ]) {
        const text = wire(
          [wireLinks],
          site(`<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="flex">\n    <p>© Firma</p>\n    ${deep}\n  </div>\n</footer>\n`, POLICY_PAGE),
          'src/components/Footer.astro',
        )
        expect(text).toContain(`    <p>© Firma</p>\n    <PrivacyLinks class="text-white" />\n    ${deep}`)
      }
    })

    // #65: the search refused too little.
    const barWith = (deep: string, style = ''): Record<string, string> =>
      site(`<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="flex">\n    <p>© Firma</p>\n    ${deep}\n  </div>\n</footer>\n${style}`, POLICY_PAGE)
    const stays = (deep: string, style = ''): void => {
      const text = wire([wireLinks], barWith(deep, style), 'src/components/Footer.astro')
      expect(text).toContain(`    <p>© Firma</p>\n    <PrivacyLinks class="text-white" />\n    ${deep}`)
    }

    test('#65: a link in <details>, opacity-0, display:none (inline, scoped, @media) or class:list stays', () => {
      for (const deep of [
        '<details><summary>Mer</summary><a href="/integritetspolicy/">P</a></details>',
        '<div class="opacity-0"><a href="/integritetspolicy/">P</a><span>x</span></div>',
        '<div class="md:opacity-0"><a href="/integritetspolicy/">P</a><span>x</span></div>',
        '<div style="display: none"><a href="/integritetspolicy/">P</a><span>x</span></div>',
        '<div class:list={[\'flex\', { hidden: !open }]}><a href="/integritetspolicy/">P</a><span>x</span></div>',
        '<div class="flex" class:list={[x]}><a href="/integritetspolicy/">P</a><span>x</span></div>',
        '<div class={cls}><div><a href="/integritetspolicy/">P</a><span>x</span></div></div>',
      ]) stays(deep)
      // The hidden element is an ancestor of the link's parent: the search refuses to pass it.
      const deep = '<div class="off"><div><a href="/integritetspolicy/">P</a><span>x</span></div></div>'
      stays(deep, '<style>\n  .off { display: none; }\n</style>\n')
      stays(deep, '<style>\n  @media (max-width: 640px) {\n    .off { display: none !important; }\n  }\n</style>\n')
      // Shown: replaced as before.
      const shown = wire([wireLinks], barWith(deep, '<style>\n  .off { display: flex; }\n</style>\n'), 'src/components/Footer.astro')
      expect(shown).toContain('<div class="off"><div><PrivacyLinks class="text-white justify-start!" /><span>x</span></div></div>')
    })

    test('#65: a list or table row passes the search but never holds the links itself', () => {
      for (const deep of ['<ul><a href="/integritetspolicy/">P</a><li>x</li></ul>', '<table><tbody><tr><a href="/integritetspolicy/">P</a><td>x</td></tr></tbody></table>']) stays(deep)
      // Through them to a cell or an item it does.
      const text = wire([wireLinks], barWith('<table><tbody><tr><td><a href="/integritetspolicy/">P</a></td><td>x</td></tr></tbody></table>'), 'src/components/Footer.astro')
      expect(text).toContain('<tr><td><PrivacyLinks class="text-white justify-start!" /></td>')
    })

    test('#65: a second policy link (conditional, a component, inside the © line) keeps wire from replacing either', () => {
      for (const second of ['{show && <a href="/integritetspolicy">B</a>}', '<Link href="/integritetspolicy/">B</Link>', '{show ? <a href="/integritetspolicy/">B</a> : null}']) {
        stays(`<div class="flex"><a href="/integritetspolicy/">A</a>${second}</div>`)
      }
      // The © line's own link counts too, for a direct sibling of © as for a deeper one.
      for (const deep of ['<div class="flex"><a href="/integritetspolicy/">A</a><span>x</span></div>', '<a href="/integritetspolicy/">A</a>']) {
        const files = site(`<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="flex">\n    <p>© Firma · <a href="/integritetspolicy/">Integritet</a></p>\n    ${deep}\n  </div>\n</footer>\n`, POLICY_PAGE)
        const text = wire([wireLinks], files, 'src/components/Footer.astro')
        expect(text).toContain(`    <p>© Firma · <a href="/integritetspolicy/">Integritet</a></p>\n    <PrivacyLinks class="text-white" />\n    ${deep}`)
      }
    })

    test('#65: a lone conditional or component policy link is not replaced (the links would render only when it does)', () => {
      stays('<div class="flex">{show && <a href="/integritetspolicy/">B</a>}<span>x</span></div>')
      stays('<div class="flex"><Link href="/integritetspolicy/">B</Link><span>x</span></div>')
    })

    test('#65: a link inside the © element is never the one replaced, even when the © element is a flow container', () => {
      const text = wire(
        [wireLinks],
        site('<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="flex">\n    <div>© Firma <a href="/integritetspolicy/">P</a></div>\n    <p>VM</p>\n  </div>\n</footer>\n', POLICY_PAGE),
        'src/components/Footer.astro',
      )
      expect(text).toContain('    <div>© Firma <a href="/integritetspolicy/">P</a></div>\n    <PrivacyLinks class="text-white" />\n    <p>VM</p>')
    })

    test('#65: a © paragraph that is itself the container: a div takes its classes and holds it and the links', () => {
      const text = wire([wireLinks], site(real('site-1369745148'), POLICY_PAGE), 'src/components/Footer.astro')
      expect(text).toContain(
        '  <div class="border-t border-base-300">\n    <div class="site-container py-5 text-sm">\n      <p>\n        &copy; Copyright {new Date().getFullYear()}, Exempel Ingenjörsbyrå AB\n      </p>\n      <PrivacyLinks class="justify-start! mt-2" />\n    </div>\n  </div>\n</footer>',
      )
      expect(tags(text)).toBe(1)
    })

    test.each([
      ['padding', '<p class="px-6 text-sm">© Firma</p>', '<div class="px-6 text-sm">\n      <p>© Firma</p>\n      <PrivacyLinks class="text-white justify-start! mt-2" />\n    </div>'],
      ['a centred max-width box', '<p class="mx-auto max-w-6xl text-center">© Firma</p>', '<div class="mx-auto max-w-6xl text-center">\n      <p>© Firma</p>\n      <PrivacyLinks class="text-white mt-2" />\n    </div>'],
      ['a flex container', '<p class="container flex gap-4">© Firma</p>', '<div class="container flex gap-4">\n      <p>© Firma</p>\n      <PrivacyLinks class="text-white" />\n    </div>'],
      ['on one line', '<p class="container">© Firma</p>', '<div class="container"><p>© Firma</p><PrivacyLinks class="text-white justify-start! mt-2" /></div>', true],
    ])('#65: a © element with layout classes (%s) is wrapped', (_name, mark, expected, inline = false) => {
      const bar = inline ? `<div class="border-t">${mark}</div>` : `<div class="border-t">\n    ${mark}\n  </div>`
      const text = wire([wireLinks], site(`<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  ${bar}\n</footer>\n`), 'src/components/Footer.astro')
      expect(text).toContain(inline ? expected : `\n    ${expected}\n  </div>\n</footer>`)
    })

    test('#65: a © element with only text classes is not wrapped', () => {
      const plain = wire([wireLinks], site('<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="border-t">\n    <p class="text-sm text-white/50">© Firma</p>\n  </div>\n</footer>\n'), 'src/components/Footer.astro')
      expect(plain).toContain('    <p class="text-sm text-white/50">© Firma</p>\n    <PrivacyLinks class="text-white justify-start! mt-2" />\n  </div>')
    })

    const unwrapped = (mark: string, style = ''): void => {
      const text = wire([wireLinks], site(`<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="border-t">\n    ${mark}\n  </div>\n</footer>\n${style}`), 'src/components/Footer.astro')
      expect(text).toContain(`  <div class="border-t">\n    ${mark}\n    <PrivacyLinks class="text-white justify-start! mt-2" />\n  </div>`)
    }

    test('#65 review: a © element that scoped CSS names (tag, class or id) is not wrapped: the rule would lose it', () => {
      for (const style of [
        '<style>\n  p.copy { color: red; }\n</style>\n',
        '<style>\n  .border-t > p { margin: 0; }\n</style>\n',
        '<style>\n  .copy { padding: 1rem; }\n</style>\n',
        '<style>\n  @media (min-width: 40rem) { #rights { text-align: right; } }\n</style>\n',
      ]) unwrapped('<p id="rights" class="copy px-4">© Firma</p>', style)
      // A rule for something else does not stop it.
      const text = wire([wireLinks], site('<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="border-t">\n    <p class="copy px-4">© Firma</p>\n  </div>\n</footer>\n<style>\n  .copyright, .grid span, #copy-x { color: red; }\n</style>\n'), 'src/components/Footer.astro')
      expect(text).toContain('<div class="copy px-4">\n      <p>© Firma</p>')
    })

    test('#65 review: a <span> or <small> needs a container, max-w-* or mx-auto; padding alone is inline spacing', () => {
      unwrapped('<span class="px-2">© Firma</span>')
      unwrapped('<small class="py-1 text-xs">© Firma</small>')
      const text = wire([wireLinks], site('<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="border-t">\n    <small class="mx-auto px-2">© Firma</small>\n  </div>\n</footer>\n'), 'src/components/Footer.astro')
      expect(text).toContain('<div class="mx-auto px-2">\n      <small>© Firma</small>')
    })

    test('#65 review: under white-space pre*, the © element is wrapped but not re-indented', () => {
      for (const ws of ['whitespace-pre-line', 'whitespace-pre', 'md:whitespace-pre-wrap']) {
        const text = wire([wireLinks], site(`<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="border-t">\n    <p class="container ${ws}">\n      © Firma\n    </p>\n  </div>\n</footer>\n`), 'src/components/Footer.astro')
        expect(text).toContain(`    <div class="container ${ws}">\n      <p>\n      © Firma\n    </p>\n      <PrivacyLinks`)
      }
      const inline = wire([wireLinks], site('<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="border-t">\n    <p class="container" style="white-space: pre-wrap">\n      © Firma\n    </p>\n  </div>\n</footer>\n'), 'src/components/Footer.astro')
      expect(inline).toContain('      <p style="white-space: pre-wrap">\n      © Firma\n    </p>\n      <PrivacyLinks')
      // Otherwise re-indented, as for site 1369745148.
      const plain = wire([wireLinks], site('<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="border-t">\n    <p class="container">\n      © Firma\n    </p>\n  </div>\n</footer>\n'), 'src/components/Footer.astro')
      expect(plain).toContain('      <p>\n        © Firma\n      </p>\n      <PrivacyLinks')
    })

    test('re-review of #63: a © line straight in the footer container: no deep search in the link columns', () => {
      const text = wire(
        [wireLinks],
        site('<footer class="text-white">\n  <div class="container">\n    <div class="grid"><ul><li><a href="/integritetspolicy/">Integritetspolicy</a></li><li><a href="/om">Om</a></li></ul></div>\n    <p>© Firma</p>\n  </div>\n</footer>\n', POLICY_PAGE),
        'src/components/Footer.astro',
      )
      expect(text).toContain('<li><a href="/integritetspolicy/">Integritetspolicy</a></li>')
      expect(text).toContain('    <p>© Firma</p>\n    <PrivacyLinks class="text-white justify-start! mt-2" />\n  </div>')
    })

    test('re-review of #63: a deep replacement in a centred block takes no justify-start!; its colour is the nearest background', () => {
      const centred = wire(
        [wireLinks],
        site('<footer class="bg-gray-900">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="flex flex-col">\n    <p>© Firma</p>\n    <div class="text-center"><a href="/integritetspolicy/">P</a> <span>|</span> <a href="/v">V</a></div>\n  </div>\n</footer>\n', POLICY_PAGE),
        'src/components/Footer.astro',
      )
      expect(centred).toContain('<div class="text-center"><PrivacyLinks class="text-white/70" /> <span>|</span>')
      const card = wire(
        [wireLinks],
        site('<footer class="bg-gray-900">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="flex flex-col">\n    <p>© Firma</p>\n    <div class="flex bg-white"><a href="/integritetspolicy/">P</a><a href="/v">V</a></div>\n  </div>\n</footer>\n', POLICY_PAGE),
        'src/components/Footer.astro',
      )
      expect(card).toContain('<div class="flex bg-white"><PrivacyLinks /><a href="/v">V</a></div>')
    })

    test("re-review of #63: a block row's direct sibling with a localize() href gets the block layout (the own path)", () => {
      const text = wire(
        [wireLinks],
        site("<footer class=\"text-white\">\n  <div class=\"grid\"><p>a</p><p>b</p></div>\n  <div class=\"text-left\">\n    <p>© Firma</p>\n    <a href={localize('/integritetspolicy/', lang)}>Integritetspolicy</a>\n  </div>\n</footer>\n", POLICY_PAGE),
        'src/components/Footer.astro',
      )
      expect(text).toContain('    <p>© Firma</p>\n    <PrivacyLinks class="text-white justify-start! mt-2" />\n  </div>')
    })

    test("re-review of #63: a localize() call with a literal language is not the Swedish policy link", () => {
      const deep = "<div class=\"flex\"><a href={localize('/integritetspolicy/', 'en')}>Privacy</a><span>x</span></div>"
      const text = wire(
        [wireLinks],
        site(`<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="flex">\n    <p>© Firma</p>\n    ${deep}\n  </div>\n</footer>\n`, POLICY_PAGE),
        'src/components/Footer.astro',
      )
      expect(text).toContain(`    <p>© Firma</p>\n    <PrivacyLinks class="text-white" />\n    ${deep}`)
    })

    test('review of #63: an href expression that only starts with a call to the policy path is not a link to it', () => {
      const deep = "<div class=\"flex\"><a href={isEn('/integritetspolicy/') ? '/en/privacy' : '/x'}>P</a></div>"
      const text = wire(
        [wireLinks],
        site(`<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="flex">\n    <p>© Firma</p>\n    ${deep}\n  </div>\n</footer>\n`, POLICY_PAGE),
        'src/components/Footer.astro',
      )
      expect(text).toContain(`    <p>© Firma</p>\n    <PrivacyLinks class="text-white" />\n    ${deep}`)
    })

    test("review of #63: a direct sibling of © with a localize() href is replaced, like a quoted one", () => {
      const text = wire(
        [wireLinks],
        site("<footer class=\"text-white\">\n  <div class=\"grid\"><p>a</p><p>b</p></div>\n  <div class=\"flex\">\n    <p>© Firma</p>\n    <a href={localize('/integritetspolicy/', lang)}>Integritetspolicy</a>\n  </div>\n</footer>\n", POLICY_PAGE),
        'src/components/Footer.astro',
      )
      expect(text).toContain('    <p>© Firma</p>\n    <PrivacyLinks class="text-white" />\n  </div>')
      expect(tags(text)).toBe(1)
    })

    test('a client footer with a dark background in scoped CSS, no text colour → text-white/70 after ©', () => {
      const text = wire([wireLinks], site(real('site-1236342450')), 'src/components/Footer.astro')
      expect(text).toContain('Exempel AB</p>\n    <PrivacyLinks class="text-white/70" />\n    <p class="site-footer__address">')
      expect(tags(text)).toBe(1)
    })

    test('the same footer with a light scoped background: no class', () => {
      const text = wire([wireLinks], site(real('site-1236342450').replace('background: #0d1219;', 'background: #f4f1ea;')), 'src/components/Footer.astro')
      expect(text).toContain('Exempel AB</p>\n    <PrivacyLinks />\n')
    })

    test('a dark inline background, bar inside the single wrapper → text-white/70 after ©, no justify-start!', () => {
      const text = wire([wireLinks], site(real('site-1248890993')), 'src/components/Footer.astro')
      expect(text).toContain('förbehållna.\n            </p>\n            <PrivacyLinks class="text-white/70" />\n            <a\n')
      expect(tags(text)).toBe(1)
    })

    test('a Tailwind dark background (bg-gray-900) with no text class → text-white/70', () => {
      const text = wire(
        [wireLinks],
        site(`<footer class="bg-gray-900">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="flex justify-between">\n    <p>© Firma</p>\n    <p>Vision Media</p>\n  </div>\n</footer>\n`),
        'src/components/Footer.astro',
      )
      expect(text).toContain('    <p>© Firma</p>\n    <PrivacyLinks class="text-white/70" />\n    <p>Vision Media</p>')
    })

    test('the footer text class wins; a flex bar needs no justify-start!', () => {
      const text = wire(
        [wireLinks],
        site(`<footer class="text-white">\n  <div class="container">\n    <div class="grid"><p>a</p><p>b</p></div>\n    <div class="flex justify-between">\n      <p>©</p>\n      <p>Vision Media</p>\n    </div>\n  </div>\n</footer>\n`),
        'src/components/Footer.astro',
      )
      expect(text).toContain('      <p>©</p>\n      <PrivacyLinks class="text-white" />\n      <p>Vision Media</p>\n    </div>\n  </div>\n</footer>')
    })

    test('a bar that is not a flex row: justify-start! and mt-2 under ©', () => {
      const text = wire(
        [wireLinks],
        site(`<footer class="text-white">\n  <div class="container">\n    <div class="grid"><p>a</p><p>b</p></div>\n    <div class="text-left">\n      <p>©</p>\n    </div>\n  </div>\n</footer>\n`),
        'src/components/Footer.astro',
      )
      expect(text).toContain('    <div class="text-left">\n      <p>©</p>\n      <PrivacyLinks class="text-white justify-start! mt-2" />\n    </div>')
    })

    test('a bar on one line: the links go inline right after the © element', () => {
      const text = wire(
        [wireLinks],
        site(`<footer class="site-footer">\n  <div class="inner"><p>a</p></div>\n  <div class="bottom"><p>©</p></div>\n</footer>\n`),
        'src/components/Footer.astro',
      )
      expect(text).toContain('  <div class="bottom"><p>©</p><PrivacyLinks class="justify-start! mt-2" /></div>\n</footer>')
    })

    test('"Alla rättigheter" and "Copyright" mark the bar too', () => {
      for (const mark of ['Alla rättigheter förbehållna', 'Copyright 2026 Firma']) {
        const text = wire(
          [wireLinks],
          site(`<footer>\n  <div class="cols"><p>a</p></div>\n  <div class="flex">\n    <span>${mark}</span>\n    <span>VM</span>\n  </div>\n</footer>\n`),
          'src/components/Footer.astro',
        )
        expect(text).toContain(`    <span>${mark}</span>\n    <PrivacyLinks />\n    <span>VM</span>`)
      }
    })

    // Review of #59, I1: the background that counts is the nearest one above the links.
    test('a plain <footer>, © bar inside a bg-neutral block → text-neutral-content, centred bar: mt-2 only', () => {
      const text = wire([wireLinks], site(real('site-1241411107')), 'src/components/Footer.astro')
      expect(text).toContain('Exempel AB</p>\n        <PrivacyLinks class="text-neutral-content mt-2" />\n      </div>\n    </div>\n  </div>\n\n</footer>')
      expect(tags(text)).toBe(1)
    })

    test('the nearest background wins: a bg-base-200 bar on a dark footer gets no class', () => {
      const text = wire(
        [wireLinks],
        site(`<footer style="background: #111">\n  <div class="cols"><p>a</p></div>\n  <div class="flex bg-base-200">\n    <p>© Firma</p>\n    <p>VM</p>\n  </div>\n</footer>\n`),
        'src/components/Footer.astro',
      )
      expect(text).toContain('    <p>© Firma</p>\n    <PrivacyLinks />\n    <p>VM</p>')
    })

    test('a dark background set only inside @media does not count', () => {
      const css = real('site-1236342450').replace('background: #0d1219;', 'background: #f4f1ea;').replace('</style>', '  @media (min-width: 768px) {\n    .site-footer { background: #0d1219; }\n  }\n</style>')
      const text = wire([wireLinks], site(css), 'src/components/Footer.astro')
      expect(text).toContain('Exempel AB</p>\n    <PrivacyLinks />\n')
    })

    // #61: a background in a CSS variable is unknown; white text on the footer's own surface says it is dark.
    test.each([
      ['site-1253341044 (text-white/NN classes)', '<footer style="background-color: var(--color-on-secondary);">\n  <div class="grid"><p class="text-white/50">a</p><p>b</p></div>\n  <div class="flex">\n    <p class="text-white/45">© Firma</p>\n    <p>VM</p>\n  </div>\n</footer>\n', '<p class="text-white/45">© Firma</p>'],
      ['site-1244371378 (inline rgba white)', '<footer style="background: var(--color-primary);">\n  <div class="grid"><p style="color: rgba(255,255,255,0.6);">a</p><p>b</p></div>\n  <div class="flex">\n    <p style="color: rgba(255,255,255,0.4);">© Firma</p>\n    <p>VM</p>\n  </div>\n</footer>\n', '<p style="color: rgba(255,255,255,0.4);">© Firma</p>'],
      ['site-1243539503 (text-white headings, colour in a variable)', '<footer style="background: var(--dark-surface); color: var(--dark-text-secondary);">\n  <div class="grid"><h4 class="text-white">Om oss</h4><p>b</p></div>\n  <div class="flex">\n    <p>© Firma</p>\n    <p>VM</p>\n  </div>\n</footer>\n', '<p>© Firma</p>'],
    ])('%s: unknown background with white text → text-white/70', (_name, footer, mark) => {
      expect(wire([wireLinks], site(footer), 'src/components/Footer.astro')).toContain(`    ${mark}\n    <PrivacyLinks class="text-white/70" />\n    <p>VM</p>`)
    })

    test('unknown background: white text on an element with its own background (a button) does not count', () => {
      const text = wire(
        [wireLinks],
        site('<footer style="background: var(--surface);">\n  <div class="grid"><a class="bg-blue-700 text-white">Ring</a><p>b</p></div>\n  <div class="flex">\n    <p>© Firma</p>\n    <p>VM</p>\n  </div>\n</footer>\n'),
        'src/components/Footer.astro',
      )
      expect(text).toContain('    <p>© Firma</p>\n    <PrivacyLinks />\n    <p>VM</p>')
    })

    test.each([
      ['a daisyUI button', '<a class="btn btn-primary text-white">Ring</a>'],
      ['a daisyUI badge', '<span class="badge badge-accent text-white">Ny</span>'],
      ['a background image', '<div style="background-image: url(/x.jpg)"><h3 class="text-white">Hej</h3></div>'],
      ['screen-reader text', '<span class="sr-only text-white">Meny</span>'],
    ])('review of #63: unknown background, white text only in %s: no class', (_name, el) => {
      const text = wire(
        [wireLinks],
        site(`<footer style="background: var(--surface);">\n  <div class="grid">${el}<p>b</p></div>\n  <div class="flex">\n    <p>© Firma</p>\n    <p>VM</p>\n  </div>\n</footer>\n`),
        'src/components/Footer.astro',
      )
      expect(text).toContain('    <p>© Firma</p>\n    <PrivacyLinks />\n    <p>VM</p>')
    })

    test.each([
      ['a variant background', '<a class="md:bg-black text-white">Ring</a>'],
      ['hidden text', '<span class="hidden text-white">x</span>'],
    ])('re-review of #63: unknown background, white text only in %s: no class', (_name, el) => {
      const text = wire(
        [wireLinks],
        site(`<footer style="background: var(--surface);">\n  <div class="grid">${el}<p>b</p></div>\n  <div class="flex">\n    <p>© Firma</p>\n    <p>VM</p>\n  </div>\n</footer>\n`),
        'src/components/Footer.astro',
      )
      expect(text).toContain('    <p>© Firma</p>\n    <PrivacyLinks />\n    <p>VM</p>')
    })

    test('a known light background: white text elsewhere changes nothing', () => {
      const text = wire(
        [wireLinks],
        site('<footer class="bg-white">\n  <div class="grid"><p class="text-white">a</p><p>b</p></div>\n  <div class="flex">\n    <p>© Firma</p>\n    <p>VM</p>\n  </div>\n</footer>\n'),
        'src/components/Footer.astro',
      )
      expect(text).toContain('    <p>© Firma</p>\n    <PrivacyLinks />\n    <p>VM</p>')
    })

    // Review of #59, I2 (site 1249140272, site 1276898577, site 1273269910): a block bar with a left-aligned ©.
    test('a block bar with no alignment (detect: unknown) → justify-start! mt-2 under ©', () => {
      const text = wire(
        [wireLinks],
        site(`<footer class="bg-gray-900 text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="border-t border-white/10">\n    <div class="max-w-6xl mx-auto px-6 py-5">\n      <p class="text-sm text-white/50">© {year} Firma</p>\n    </div>\n  </div>\n</footer>\n`),
        'src/components/Footer.astro',
      )
      expect(text).toContain('      <p class="text-sm text-white/50">© {year} Firma</p>\n      <PrivacyLinks class="text-white justify-start! mt-2" />\n    </div>')
    })

    test('a block column with md:text-right → justify-start! md:justify-end!', () => {
      const text = wire(
        [wireLinks],
        site(`<footer class="text-white">\n  <div class="grid md:grid-cols-2">\n    <div><p>a</p></div>\n    <div class="md:text-right">\n      <p>© Firma</p>\n    </div>\n  </div>\n</footer>\n`),
        'src/components/Footer.astro',
      )
      expect(text).toContain('      <p>© Firma</p>\n      <PrivacyLinks class="text-white justify-start! md:justify-end! mt-2" />\n    </div>')
    })

    // Review of #59, I4.
    test('"Copyright" in a heading is not a © line: the links stay at the slot\'s end', () => {
      const text = wire(
        [wireLinks],
        site(`<footer>\n  <div class="cols">\n    <h3>Copyright och villkor</h3>\n    <p>a</p>\n  </div>\n  <div class="nav"><a href="/">Hem</a></div>\n</footer>\n`),
        'src/components/Footer.astro',
      )
      expect(text).toContain('  <div class="nav"><a href="/">Hem</a></div>\n  <PrivacyLinks />\n</footer>')
    })

    test('"Copyright {year}" is a © line', () => {
      const text = wire(
        [wireLinks],
        site(`<footer>\n  <div class="cols"><p>a</p></div>\n  <div class="flex">\n    <p>Copyright {year} Firma</p>\n    <p>VM</p>\n  </div>\n</footer>\n`),
        'src/components/Footer.astro',
      )
      expect(text).toContain('    <p>Copyright {year} Firma</p>\n    <PrivacyLinks />\n    <p>VM</p>')
    })

    test("a dark footer with no © bar still gets the readable class, at today's place", () => {
      const text = wire([wireLinks], site(`<footer style="background: #111">\n  <div>\n    <p>a</p>\n    <p>b</p>\n  </div>\n</footer>\n`), 'src/components/Footer.astro')
      expect(text).toContain('    <p>b</p>\n    <PrivacyLinks class="text-white/70" />\n  </div>')
    })
  })

  test('footer with no text class and no background: no colour class (the block row gets justify-start! mt-2)', () => {
    const text = wire([wireLinks], site(FOOTER.replace('bg-neutral text-neutral-content', 'pt-8')), 'src/components/Footer.astro')
    expect(text).toContain('    <p>© Firma</p>\n    <PrivacyLinks class="justify-start! mt-2" />\n  </div>')
  })

  test('daisyUI bg-neutral on the footer, no text class → text-neutral-content (#47 review)', () => {
    const text = wire([wireLinks], site(FOOTER.replace(' text-neutral-content', '')), 'src/components/Footer.astro')
    expect(text).toContain('    <p>© Firma</p>\n    <PrivacyLinks class="text-neutral-content justify-start! mt-2" />\n  </div>')
  })

  test('descends through single-child wrappers, not counting decoration (Rulings 17, 23)', () => {
    const text = wire(
      [wireLinks],
      site(
        `<footer>\n  <div class="absolute inset-0" aria-hidden="true"><svg></svg></div>\n  <img src="/bg.png" alt="" />\n  <div class="outer">\n    <div class="inner">\n      <p>a</p>\n      <p>b</p>\n    </div>\n  </div>\n</footer>\n`,
      ),
      'src/components/Footer.astro',
    )
    expect(text).toContain('      <p>b</p>\n      <PrivacyLinks />\n    </div>\n  </div>\n</footer>')
  })

  // Ruling 29: the descent stops before phrasing or interactive content.
  test('a footer whose only child is a <p> with a link: the links go after the <p>, not inside it (Ruling 29)', () => {
    const text = wire([wireLinks], site(`<footer class="p-4">\n  <p>© Firma <a href="/integritet">Integritet</a></p>\n</footer>\n`), 'src/components/Footer.astro')
    expect(text).toContain('  <p>© Firma <a href="/integritet">Integritet</a></p>\n  <PrivacyLinks class="justify-start! mt-2" />\n</footer>')
  })

  test('a footer wrapper whose only child is a link: the links go in the wrapper, not inside the <a> (Ruling 29)', () => {
    const text = wire(
      [wireLinks],
      site(`<footer>\n  <div class="wrap">\n    <a href="/"><span>Hem</span></a>\n  </div>\n</footer>\n`),
      'src/components/Footer.astro',
    )
    expect(text).toContain('    <a href="/"><span>Hem</span></a>\n    <PrivacyLinks />\n  </div>\n</footer>')
  })

  test('the deepest single-child wrapper takes the links when the chain ends in a leaf', () => {
    const text = wire([wireLinks], site(`<footer>\n  <div class="wrap">\n    <p>©</p>\n  </div>\n</footer>\n`), 'src/components/Footer.astro')
    expect(text).toContain('    <p>©</p>\n    <PrivacyLinks class="justify-start! mt-2" />\n  </div>\n</footer>')
  })

  test('two footers in two files: two edits (and two imports)', () => {
    const files = memSite({
      'src/layouts/Base.astro': `${LAYOUT_HEAD}    <Footer />\n  </body>\n</html>\n`,
      'src/components/Footer.astro': FOOTER,
      'src/components/OtherFooter.astro': FOOTER,
      'src/layouts/Other.astro': `---\nimport OtherFooter from '../components/OtherFooter.astro'\n---\n<div><slot /><OtherFooter /></div>\n`,
      'src/pages/index.astro': PAGE,
      'src/pages/annan.astro': `---\nimport Other from '../layouts/Other.astro'\n---\n<Other><p>x</p></Other>\n`,
    })
    const result = plan([wireLinks], files, reportFor(files))
    expect(result.ok && result.edits.map((e) => [e.file, e.target])).toEqual([
      ['src/components/Footer.astro', 'PrivacyLinks import (src/components/Footer.astro)'],
      ['src/components/Footer.astro', 'links (src/components/Footer.astro)'],
      ['src/components/OtherFooter.astro', 'PrivacyLinks import (src/components/OtherFooter.astro)'],
      ['src/components/OtherFooter.astro', 'links (src/components/OtherFooter.astro)'],
    ])
  })

  test('two <footer> elements in one layout: refused as ambiguous', () => {
    const files = memSite({
      'src/layouts/Base.astro': `<html><body><slot />{Astro.props.kort ? <footer><p>a</p></footer> : <footer><p>b</p></footer>}</body></html>\n`,
      'src/pages/index.astro': PAGE,
    })
    const result = plan([wireLinks], files, reportFor(files))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.refusals[0]).toEqual({
      file: 'src/layouts/Base.astro',
      target: 'links (src/layouts/Base.astro)',
      reason: 'ambiguous: 2 <footer> elements in src/layouts/Base.astro',
    })
  })

  // Brief: "footerless page with <main> → last child of <main>"; Ruling 16 refines it to the last
  // child of <main>'s only element child when there is exactly one.
  test('footerless page whose <main> has several children: the last child of <main>, with mt-6 (#47: air above the button)', () => {
    const text = wire(
      [wireLinks],
      { 'src/pages/404.astro': `<html><body>\n  <main>\n    <h1>404</h1>\n    <a href="/">Tillbaka</a>\n  </main>\n</body></html>\n` },
      'src/pages/404.astro',
    )
    expect(text).toContain('    <a href="/">Tillbaka</a>\n    <PrivacyLinks class="mt-6" />\n  </main>')
  })

  test("footerless page whose <main> has one element child: the last child of that child (Ruling 16)", () => {
    const text = wire(
      [wireLinks],
      { 'src/pages/404.astro': `<html><body>\n  <main class="flex">\n    <div class="box">\n      <h1>404</h1>\n      <a href="/">Tillbaka</a>\n    </div>\n  </main>\n</body></html>\n` },
      'src/pages/404.astro',
    )
    expect(text).toContain('      <a href="/">Tillbaka</a>\n      <PrivacyLinks class="mt-6" />\n    </div>\n  </main>')
  })

  test('a 404 whose <main> holds only an <h1>: the links go in <main>, not inside the heading (Ruling 29)', () => {
    const text = wire(
      [wireLinks],
      { 'src/pages/404.astro': `<html><body>\n  <main>\n    <h1>Sidan finns inte</h1>\n  </main>\n</body></html>\n` },
      'src/pages/404.astro',
    )
    expect(text).toContain('    <h1>Sidan finns inte</h1>\n    <PrivacyLinks class="mt-6" />\n  </main>')
  })

  test('footerless page without <main>: the last child of the outermost template element (a <script> beside it does not count)', () => {
    const text = wire(
      [wireLinks],
      {
        'src/layouts/Base.astro': `<html><body><slot /></body></html>\n`,
        'src/pages/index.astro': `${PAGE}\n<script>\n  console.log('x')\n</script>\n`,
      },
      'src/pages/index.astro',
    )
    expect(text).toContain('  <h1>Hej</h1>\n  <PrivacyLinks class="mt-6" />\n</Base>')
  })

  test('footerless page with its own <html> and no <main>: the last child of <body>', () => {
    const text = wire([wireLinks], { 'src/pages/tack.astro': `<html>\n  <body>\n    <p>Tack!</p>\n  </body>\n</html>\n` }, 'src/pages/tack.astro')
    expect(text).toContain('    <p>Tack!</p>\n    <PrivacyLinks class="mt-6" />\n  </body>')
  })

  test('footerless page with two top-level elements and no <main>: refused', () => {
    const files = memSite({ 'src/pages/delad.astro': `<header>a</header>\n<section>b</section>\n` })
    expect(refusals(plan([wireLinks], files, reportFor(files)))).toEqual(['found 2, expected exactly 1'])
  })

  test('already wired footer and page: skipped, no edits', () => {
    const IMPORT = "---\nimport PrivacyLinks from '@visionmediahq/astro-consent/components/PrivacyLinks.astro'\n---\n"
    const files = memSite({
      'src/layouts/Base.astro': `${LAYOUT_HEAD}    <Footer />\n  </body>\n</html>\n`,
      'src/components/Footer.astro': `${IMPORT}<footer><div><p>a</p><PrivacyLinks /></div></footer>\n`,
      'src/pages/index.astro': PAGE,
      'src/pages/404.astro': `${IMPORT}<html><body><main><PrivacyLinks class="mt-8" /></main></body></html>\n`,
    })
    const result = plan([wireLinks], files, reportFor(files))
    expect(result.ok && result.edits).toEqual([])
  })

  test.each(WIRED)('%s: every footer and footerless page comes out as expected/', (site) => {
    const { files, result } = fixturePlan(site)
    const report = detect(files, site, [`${site}.se`])
    const paths = [...new Set([...report.footers.map((f) => f.file), ...report.footerless])]
    expect(paths.length).toBeGreaterThan(0)
    for (const path of paths) expect(after(result, files, path), path).toBe(expectedText(site, path))
  })
})

describe('wirePrivacy', () => {
  const privacy = (over: Partial<Report>, files: Record<string, string> = {}): WirePlan => {
    const site = memSite(files)
    return plan([wirePrivacy], site, reportFor(site, over))
  }

  test('notice → {"services":[]}', () => {
    expect(privacy({ classification: 'notice' })).toEqual({
      ok: true,
      edits: [],
      newFiles: [{ path: 'src/data/privacy.json', text: '{\n  "services": []\n}\n' }],
      skipped: [],
    })
  })

  test('maps → {"services":["google-maps"]}', () => {
    const result = privacy(
      {},
      { 'src/components/Map.astro': '<iframe src="https://www.google.com/maps/embed?pb=!1m2" title="Karta"></iframe>\n' },
    )
    expect(result.ok && result.newFiles).toEqual([{ path: 'src/data/privacy.json', text: '{\n  "services": [\n    "google-maps"\n  ]\n}\n' }])
  })

  test("policyPage '/integritetspolicy' on domain x.se (report.domains[0], Ruling 3) → policy_url", () => {
    const result = privacy({ policyPage: '/integritetspolicy', domains: ['x.se', 'www.x.se'] })
    expect(result.ok && JSON.parse(result.newFiles[0]!.text)).toEqual({ services: [], policy_url: 'https://x.se/integritetspolicy' })
  })

  test('a policy page but no domain: refused', () => {
    expect(refusals(privacy({ policyPage: '/integritetspolicy', domains: [] }))).toEqual(['no domain for policy_url (policy page /integritetspolicy)'])
  })

  test('existing privacy.json: skipped (already wired)', () => {
    expect(privacy({}, { 'src/data/privacy.json': '{"services":[]}' })).toEqual({ ok: true, edits: [], newFiles: [], skipped: ['privacy.json'] })
  })

  test('the services are report.services: widgets and calendars included', () => {
    const result = privacy({ services: ['elfsight', 'google-calendar', 'google-maps'] })
    expect(result.ok && JSON.parse(result.newFiles[0]!.text)).toEqual({ services: ['elfsight', 'google-calendar', 'google-maps'] })
  })

  test('an existing privacy.json that lists every service: skipped', () => {
    const existing = { 'src/data/privacy.json': '{"services":["google-maps","elfsight"]}' }
    expect(privacy({ services: ['elfsight', 'google-maps'] }, existing)).toEqual({ ok: true, edits: [], newFiles: [], skipped: ['privacy.json'] })
  })

  test('an existing privacy.json without elfsight: refused (the build would fail on it)', () => {
    const existing = { 'src/data/privacy.json': '{"services":["google-maps"]}' }
    expect(refusals(privacy({ services: ['elfsight', 'google-maps'] }, existing))).toEqual(['privacy.json exists without elfsight'])
  })

  test('an existing privacy.json that is not JSON: refused', () => {
    expect(refusals(privacy({ services: ['elfsight'] }, { 'src/data/privacy.json': '{"services":' }))).toEqual(['privacy.json exists and is not valid JSON'])
  })

  test.each(WIRED)('%s: privacy.json comes out as expected/', (site) => {
    const { result } = fixturePlan(site)
    expect(result.ok && result.newFiles).toEqual([{ path: 'src/data/privacy.json', text: expectedText(site, 'src/data/privacy.json') }])
  })
})

describe('wireEmbeds', () => {
  const MAP = 'src/components/Map.astro'
  const IMPORT = "import ConsentEmbed from '@visionmediahq/astro-consent/components/ConsentEmbed.astro'"
  const embed = (body: string, path = MAP) => wire([wireEmbeds], { [path]: body }, path)
  const refused = (body: string): string[] => {
    const site = memSite({ [MAP]: body })
    return refusals(plan([wireEmbeds], site, reportFor(site)))
  }

  test('literal src with &amp; (Review Focus 2): the src attribute is copied byte for byte', () => {
    const src = 'src="https://maps.google.com/maps?q=Storgatan+1&amp;hl=sv&amp;output=embed"'
    expect(embed(`<div>\n  <iframe ${src} width="600" title="Karta till oss" loading="lazy"></iframe>\n</div>\n`)).toBe(
      `---\n${IMPORT}\n---\n<div>\n  <ConsentEmbed service="google-maps" ${src} title="Karta till oss" />\n</div>\n`,
    )
  })

  test('expression src: src={sameExpression}, title expression kept', () => {
    const text = embed(
      `---\nconst url = 'https://www.google.com/maps/embed?pb=!1m2'\nconst namn = 'Firma'\n---\n<iframe src={url} title={\`Karta till \${namn}\`}></iframe>\n`,
    )
    expect(text).toContain('<ConsentEmbed service="google-maps" src={url} title={`Karta till ${namn}`} />\n')
    expect(text.startsWith(`---\n${IMPORT}\nconst url`)).toBe(true)
  })

  test("classes 'w-full h-[450px] rounded-lg' → wrapper div 'grid h-[450px] w-full rounded-lg' + aspect=\"auto\"", () => {
    expect(embed(`<iframe class="w-full h-[450px] rounded-lg" src="https://www.google.com/maps/embed?pb=!1" title="Karta"></iframe>\n`)).toContain(
      '<div class="grid h-[450px] w-full rounded-lg"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>\n',
    )
  })

  test('height="400" attribute → wrapper "grid h-[400px]" + aspect="auto"; "20rem" → h-[20rem]', () => {
    expect(embed(`<iframe src="https://www.google.com/maps/embed?pb=!1" height="400" title="Karta"></iframe>\n`)).toContain(
      '<div class="grid h-[400px]"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>',
    )
    expect(embed(`<iframe class="rounded" src="https://www.google.com/maps/embed?pb=!1" height="20rem" title="Karta"></iframe>\n`)).toContain(
      '<div class="grid h-[20rem] rounded">',
    )
  })

  test('no fixed height → wrapper with the classes, no aspect (the component default)', () => {
    expect(embed(`<iframe class="w-full rounded-lg" src="https://www.google.com/maps/embed?pb=!1" height="auto" title="Karta"></iframe>\n`)).toContain(
      '<div class="w-full rounded-lg"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" /></div>',
    )
  })

  test('fills a parent of definite height (h-full or height="100%") → <div class="grid h-full …"> + aspect="auto" (Ruling 25)', () => {
    expect(
      embed(`<section class="h-96">\n  <iframe class="h-full w-full" src="https://www.google.com/maps/embed?pb=!1" title="Karta"></iframe>\n</section>\n`),
    ).toContain('  <div class="grid h-full w-full"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>\n')
    expect(
      embed(`<div style="height: 24rem">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="100%" title="Karta"></iframe>\n</div>\n`),
    ).toContain('<div class="grid h-full"><ConsentEmbed')
  })

  // A percentage height against a parent with only a min-height resolves to auto: `grid h-full`
  // alone shrinks to the placeholder (120px where the site had 500px), so the min-height goes on
  // the wrapper (site 1217803084, site 1246505973, site 1231784589 and site 1217008669 were wired by hand like this).
  test('fills a parent that only has a min-height → the wrapper carries it as min-h-*', () => {
    expect(
      embed(
        `<div class="karta">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="100%" title="Karta"></iframe>\n</div>\n<style>\n  .karta { min-height: 30vh; }\n</style>\n`,
      ),
    ).toContain('<div class="grid h-full min-h-[30vh]"><ConsentEmbed')
    // site 1217803084: h-full on the parent is not a definite height; its min-h-[500px] is.
    expect(
      embed(`<div class="h-full min-h-[500px] rounded-lg">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" width="100%" height="100%" title="Karta"></iframe>\n</div>\n`),
    ).toContain('  <div class="grid h-full min-h-[500px]"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>\n')
    // Responsive min-h classes go along as written; an inline min-height too.
    expect(
      embed(`<div class="min-h-80 lg:min-h-[480px]">\n  <iframe class="w-full h-full" src="https://www.google.com/maps/embed?pb=!1" title="Karta"></iframe>\n</div>\n`),
    ).toContain('<div class="grid h-full min-h-80 lg:min-h-[480px] w-full"><ConsentEmbed')
    expect(
      embed(`<div style="min-height: 22rem">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="100%" title="Karta"></iframe>\n</div>\n`),
    ).toContain('<div class="grid h-full min-h-[22rem]"><ConsentEmbed')
  })

  test('min-h-0, a zero min-height or only a variant min-h is no height: refused as before (review of #44)', () => {
    const map = `<iframe class="w-full h-full" src="https://www.google.com/maps/embed?pb=!1" title="Karta"></iframe>`
    expect(refused(`<div class="flex-1 min-h-0">\n  ${map}\n</div>\n`)).toEqual(['map fills a parent of unknown height'])
    expect(refused(`<div class="min-h-[0px]">\n  ${map}\n</div>\n`)).toEqual(['map fills a parent of unknown height'])
    expect(refused(`<div class="md:min-h-[500px]">\n  ${map}\n</div>\n`)).toEqual(['map fills a parent of unknown height'])
    expect(refused(`<div style="min-height: 0">\n  ${map}\n</div>\n`)).toEqual(['map fills a parent of unknown height'])
    // height: 0 with padding (the aspect-ratio hack) is no definite height either; since #45 it is
    // refused as a padding-ratio box without an absolute iframe filling it.
    expect(
      refused(`<div class="r">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="100%" title="Karta"></iframe>\n</div>\n<style>\n  .r { padding-bottom: 56.25%; height: 0px; }\n</style>\n`),
    ).toEqual(["the map's parent is a padding-ratio box (padding-bottom: 56.25%) and the iframe does not fill it absolutely"])
  })

  test("the iframe's own inline min-height goes on the wrapper (site-1246505973, site-1231784589, site-1217008669)", () => {
    // site 1246505973: parent min-h-[360px], iframe style min-height: 360px: one min-h, the iframe's.
    expect(
      embed(
        `<div class="lg:col-span-3 min-h-[360px]">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" width="100%" height="100%" style="border: 0; min-height: 360px; display: block;" title="Karta"></iframe>\n</div>\n`,
      ),
    ).toContain('<div class="grid h-full min-h-[360px]"><ConsentEmbed')
    // site 1217008669: the parent is h-full (unknown); the iframe's min-height makes the box definite.
    expect(
      embed(`<div class="h-full">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="100%" style="border:0; min-height: 500px;" title="Karta"></iframe>\n</div>\n`),
    ).toContain('<div class="grid h-full min-h-[500px]"><ConsentEmbed')
    // A parent of definite height keeps the iframe's min-height as well.
    expect(
      embed(`<div class="h-96">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="100%" style="min-height:20rem" title="Karta"></iframe>\n</div>\n`),
    ).toContain('<div class="grid h-full min-h-[20rem]"><ConsentEmbed')
  })

  test("a parent min-height: the rule outside @media counts; two that disagree are refused", () => {
    // A smaller min-height on phones only makes the parent grow around the wrapper: nothing clips.
    expect(
      embed(
        `<div class="karta">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="100%" title="Karta"></iframe>\n</div>\n<style>\n  .karta { min-height: 500px; }\n  @media (max-width: 640px) { .karta { min-height: 300px; } }\n</style>\n`,
      ),
    ).toContain('<div class="grid h-full min-h-[500px]"><ConsentEmbed')
    expect(
      refused(
        `<div class="karta">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="100%" title="Karta"></iframe>\n</div>\n<style>\n  .karta { min-height: 500px; }\n  .karta { min-height: 30rem; }\n</style>\n`,
      ),
    ).toEqual(["the map's parent sets different min-heights (500px, 30rem)"])
  })

  // #43: a stylesheet rule beats the presentational height attribute (and a Tailwind utility,
  // which is layered), so `.box iframe { height: 100% }` makes the iframe fill its parent.
  test('scoped CSS height on the iframe beats its height attribute (#43)', () => {
    const lb = `<div class="kontakt-map__embed">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" width="100%" height="450" style="border:0;" title="Karta"></iframe>\n</div>\n<style>\n  .kontakt-map__embed { height: 450px; overflow: hidden; }\n  .kontakt-map__embed iframe { width: 100%; height: 100%; display: block; }\n  @media (max-width: 640px) { .kontakt-map__embed { height: 300px; } }\n</style>\n`
    expect(embed(lb)).toContain('  <div class="grid h-full"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>\n')
    // A fixed value: the rule's, not the attribute's; also through `>` and for a bare `iframe`.
    expect(
      embed(`<div class="box">\n  <iframe class="h-[450px]" src="https://www.google.com/maps/embed?pb=!1" height="450" title="Karta"></iframe>\n</div>\n<style>\n  .box > iframe { height: 380px !important; }\n</style>\n`),
    ).toContain('<div class="grid h-[380px]"><ConsentEmbed')
    expect(
      embed(`<section>\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="450" title="Karta"></iframe>\n</section>\n<style>\n  iframe { height: 25rem; }\n</style>\n`),
    ).toContain('<div class="grid h-[25rem]"><ConsentEmbed')
    // Rules inside @media set the height on some screens only: the base height stays (site 1241411946:
    // height="400", 260px on phones; site 1243303811: 460px, 260px on phones). Verify step 5
    // measures the phone widths.
    expect(
      embed(`<section>\n  <div>\n    <iframe src="https://www.google.com/maps/embed?pb=!1" height="400" title="Karta"></iframe>\n  </div>\n</section>\n<style>\n  @media (max-width: 640px) {\n    section iframe { height: 260px; }\n  }\n</style>\n`),
    ).toContain('<div class="grid h-[400px]"><ConsentEmbed')
    expect(
      embed(`<div class="wrap">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" title="Karta"></iframe>\n</div>\n<style>\n  .wrap iframe { height: 460px; }\n  @media (max-width: 639px) { .wrap iframe { height: 260px; } }\n</style>\n`),
    ).toContain('<div class="grid h-[460px]"><ConsentEmbed')
    // An inline style still beats the rule; a rule for another element's iframes does not apply.
    expect(
      embed(`<div class="box">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" style="height:400px" title="Karta"></iframe>\n</div>\n<style>\n  .box iframe { height: 100%; }\n</style>\n`),
    ).toContain('<div class="grid h-[400px]"><ConsentEmbed')
    expect(
      embed(`<div class="box">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="450" title="Karta"></iframe>\n</div>\n<style>\n  .video iframe { height: 100%; }\n  .box iframe { border: 0; }\n</style>\n`),
    ).toContain('<div class="grid h-[450px]"><ConsentEmbed')
  })

  test('scoped CSS height on the iframe that wire cannot follow: refused (#43)', () => {
    const map = `<div class="box">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="450" title="Karta"></iframe>\n</div>\n`
    expect(refused(`${map}<style>\n  .box iframe { height: auto; }\n</style>\n`)).toEqual(["scoped CSS sets the map iframe's height: auto"])
    expect(refused(`${map}<style>\n  .box iframe { height: 420px; }\n  section > .box > iframe { height: 300px; }\n</style>\n`)).toEqual([
      "scoped CSS sets the map iframe's height to different values (420px, 300px)",
    ])
    // Astro scopes every compound to the component, so `.kontakt iframe` matches only through an
    // ancestor in this file: here the grandparent, so the map fills a parent of unknown height.
    expect(
      refused(`<section class="kontakt">\n  <div>\n    <iframe src="https://www.google.com/maps/embed?pb=!1" height="450" title="Karta"></iframe>\n  </div>\n</section>\n<style>\n  .kontakt iframe { height: 100%; }\n</style>\n`),
    ).toEqual(['map fills a parent of unknown height'])
    // A selector that only ends in the letters "iframe" is not an iframe rule (review of #44).
    expect(embed(`<div class="map-">\n  <iframe id="map-iframe" class="map-iframe" src="https://www.google.com/maps/embed?pb=!1" height="450" title="Karta"></iframe>\n</div>\n<style>\n  #map-iframe { border: 0; height: 450px; }\n</style>\n`)).toContain(
      '<div class="grid h-[450px] map-iframe"><ConsentEmbed',
    )
    // :global(iframe) or an iframe compound with more than the element name: unsure, so refused.
    expect(refused(`${map}<style>\n  .box :global(iframe) { height: 100%; }\n</style>\n`)).toEqual([
      "scoped CSS '.box :global(iframe)' sets an iframe height and wire cannot tell if it is this map's",
    ])
    expect(refused(`${map}<style>\n  .box iframe[src] { height: 100%; }\n</style>\n`)).toEqual([
      "scoped CSS '.box iframe[src]' sets an iframe height and wire cannot tell if it is this map's",
    ])
    // A variant height class on the iframe lost to the rule; on the wrapper it would win: refused.
    expect(
      refused(`<div class="box">\n  <iframe class="md:h-96" src="https://www.google.com/maps/embed?pb=!1" height="450" title="Karta"></iframe>\n</div>\n<style>\n  .box iframe { height: 300px; }\n</style>\n`),
    ).toEqual(["iframe has a height class with a variant (md:h-96) that scoped CSS overrides"])
    // An ancestor compound wire cannot match (a pseudo-class, an id): unsure, so refused.
    expect(refused(`${map}<style>\n  .box:hover iframe { height: 100%; }\n</style>\n`)).toEqual([
      "scoped CSS '.box:hover iframe' sets an iframe height and wire cannot tell if it is this map's",
    ])
  })

  test('inline style sizing (Ruling 31): height:100% fills a sized parent; height: <n>px is fixed', () => {
    expect(
      embed(`<div class="h-[400px]">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" style="border:0;width:100%;HEIGHT : 100%" title="Karta"></iframe>\n</div>\n`),
    ).toContain('  <div class="grid h-full"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>\n')
    expect(
      embed(`<iframe class="w-full" src="https://www.google.com/maps/embed?pb=!1" style="height:450px" title="Karta"></iframe>\n`),
    ).toContain('<div class="grid h-[450px] w-full"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>')
  })

  test("an inline aspect-ratio on an iframe without a fixed height becomes the embed's aspect (#61, site-1250154895)", () => {
    expect(
      embed(`<iframe class="w-full" src="https://www.google.com/maps/embed?pb=!1" style="border:0; aspect-ratio: 4/3; height: auto" title="Karta"></iframe>\n`),
    ).toContain('<div class="w-full"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="4 / 3" /></div>')
    expect(embed(`<iframe src="https://www.google.com/maps/embed?pb=!1" style="aspect-ratio:1.5" title="Karta"></iframe>\n`)).toContain('title="Karta" aspect="1.5" />')
    // The last declaration wins, as in CSS.
    expect(embed(`<iframe src="https://www.google.com/maps/embed?pb=!1" style="aspect-ratio: 16/9; aspect-ratio: 1/1" title="Karta"></iframe>\n`)).toContain('title="Karta" aspect="1 / 1" />')
    // A fixed height wins, as before: the grid wrapper sizes it and the aspect is auto.
    expect(embed(`<iframe src="https://www.google.com/maps/embed?pb=!1" style="aspect-ratio: 4/3; height: 300px" title="Karta"></iframe>\n`)).toContain(
      '<div class="grid h-[300px]"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>',
    )
    // A value wire cannot copy safely keeps the default 16:9; verify's height check is the judge.
    expect(embed(`<iframe src="https://www.google.com/maps/embed?pb=!1" style="aspect-ratio: var(--r)" title="Karta"></iframe>\n`)).toContain('title="Karta" />')
  })

  test('an aspect-class parent with more in it is definite (#61): grid h-full inside it', () => {
    for (const aspect of ['aspect-video', 'aspect-square', 'aspect-[4/3]', 'aspect-4/3']) {
      expect(
        embed(`<div class="${aspect} w-full">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" width="100%" height="100%" style="border:0;" title="Karta"></iframe>\n  <span>Karta</span>\n</div>\n`),
      ).toContain(`<div class="${aspect} w-full">\n  <div class="grid h-full"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>\n  <span>Karta</span>\n</div>`)
    }
    // Only on some screens, or turned off: not definite.
    for (const aspect of ['md:aspect-video', 'aspect-auto']) {
      expect(refused(`<div class="${aspect}">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="100%" title="Karta"></iframe>\n</div>\n`)).toEqual(['map fills a parent of unknown height'])
    }
  })

  // #65 (site 1218955344): `grid h-full` inside the aspect box can't grow past it, and at 320px the
  // 16:9 box clipped the placeholder's Visa button. The aspect parent itself becomes the embed, with
  // that ratio; the embed's own box grows with its content. Deliberately replaces #61's output, which
  // put `<div class="grid h-full">` inside the aspect parent.
  test('a parent that holds only the map and is sized only by an aspect class becomes the embed with that aspect (#65)', () => {
    const map = '<iframe src="https://www.google.com/maps/embed?pb=!1" width="100%" height="100%" style="border:0;" title="Karta"></iframe>'
    const out = (props: string) => `<ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" ${props} />`
    for (const [aspect, ratio] of [
      ['aspect-video', '16 / 9'],
      ['aspect-square', '1 / 1'],
      ['aspect-[4/3]', '4 / 3'],
      ['aspect-4/3', '4 / 3'],
      ['aspect-[1.5/1]', '1.5 / 1'],
    ] as const) {
      expect(embed(`<div class="${aspect} w-full">\n  ${map}\n</div>\n`)).toBe(`---\n${IMPORT}\n---\n<div class="w-full">\n  ${out(`aspect="${ratio}"`)}\n</div>\n`)
    }
    // Only the aspect class: no wrapper at all. Other attributes stay on the wrapper as written.
    expect(embed(`<section>\n  <div class="aspect-video">\n    ${map}\n  </div>\n</section>\n`)).toContain(`<section>\n  ${out('aspect="16 / 9"')}\n</section>`)
    expect(embed(`<div id="karta" class="rounded-lg aspect-video overflow-hidden" data-animate>\n  ${map}\n</div>\n`)).toContain(
      `<div id="karta" class="rounded-lg overflow-hidden" data-animate>\n  ${out('aspect="16 / 9"')}\n</div>`,
    )
    // An absolutely positioned iframe filling a relative aspect box, and a filter utility, go too.
    expect(
      embed(`<div class="relative aspect-video">\n  <iframe class="absolute inset-0 w-full h-full border-0 grayscale" src="https://www.google.com/maps/embed?pb=!1" title="Karta"></iframe>\n</div>\n`),
    ).toContain(`<div class="relative [&_iframe]:grayscale">\n  ${out('aspect="16 / 9"')}\n</div>`)
    // An inline filter needs a div around the embed for its `div :global(iframe)` rule.
    expect(embed(`<div class="aspect-video">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="100%" style="filter: grayscale(1)" title="Karta"></iframe>\n</div>\n`)).toContain(
      `<div>\n  ${out('aspect="16 / 9"')}\n</div>`,
    )
  })

  test('an aspect parent that holds more than the map, or is sized by more than the class, keeps #61 (grid h-full inside)', () => {
    const map = '<iframe src="https://www.google.com/maps/embed?pb=!1" width="100%" height="100%" title="Karta"></iframe>'
    const inside = (extra = '') =>
      `<div class="grid h-full${extra}"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>`
    for (const parent of [
      `<div class="aspect-video">\n  ${map}\n  <p>Hitta hit</p>\n</div>\n`,
      `<div class="aspect-video min-h-[300px]">\n  ${map}\n</div>\n`,
      `<div class="aspect-video md:aspect-square">\n  ${map}\n</div>\n`,
      `<div class="aspect-video" style="max-height: 400px">\n  ${map}\n</div>\n`,
      `<div class="aspect-video karta">\n  ${map}\n</div>\n<style>\n  .karta { max-height: 400px; }\n</style>\n`,
      `<div class="aspect-video">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="100%" style="border-radius: 8px" title="Karta"></iframe>\n</div>\n`,
    ]) {
      expect(embed(parent)).toContain(inside())
    }
    // Review of #67: a flex or grid parent would shrink the embed (ConsentEmbed's root has no
    // width; 807×454 where main was 1280×720), with any variant or `!`.
    for (const cls of ['flex', 'inline-flex', 'md:flex', 'grid', '!grid', 'lg:grid!', 'place-items-center', 'items-center', 'justify-center', 'md:justify-start']) {
      expect(embed(`<div class="aspect-video w-full ${cls}">\n  ${map}\n</div>\n`)).toContain(`<div class="aspect-video w-full ${cls}">\n  ${inside()}\n</div>`)
    }
    expect(embed(`<div class="aspect-video">\n  <iframe class="w-full h-full map-frame" src="https://www.google.com/maps/embed?pb=!1" title="Karta"></iframe>\n</div>\n`)).toContain(
      inside(' w-full map-frame'),
    )
  })

  // #45 (site 1228881255, MapSection.astro): the iframe was absolutely positioned and filled a
  // padding-ratio box. An in-flow `grid h-full min-h-[320px]` wrapper left the map 320px tall with
  // an empty band below; the wrapper takes the iframe's place instead, and the box keeps its size.
  test('an absolute iframe that fills a position: relative padding-ratio box → wrapper "absolute inset-0 grid", no min-height (#45)', () => {
    const site = `<div class="overflow-hidden" style="border: 1px solid var(--kb-line);" data-animate data-animate-delay="0.1">
  <div style="position: relative; padding-bottom: 40%; min-height: 320px;">
    <iframe
      src="https://maps.google.com/maps?q=Exempel+Bil+AB%2C+Exempelby&t=&z=13&ie=UTF8&iwloc=&output=embed"
      style="position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; filter: grayscale(0.3) contrast(1.1);"
      allowfullscreen
      loading="lazy"
      referrerpolicy="no-referrer-when-downgrade"
      title="Exempel Bil AB — Exempelgatan 1, Exempelby"
    ></iframe>
  </div>
</div>
`
    const text = embed(site, 'src/components/MapSection.astro')
    expect(text).toContain(
      `  <div style="position: relative; padding-bottom: 40%; min-height: 320px;">\n    <div class="absolute inset-0 grid"><ConsentEmbed service="google-maps" src="https://maps.google.com/maps?q=Exempel+Bil+AB%2C+Exempelby&t=&z=13&ie=UTF8&iwloc=&output=embed" title="Exempel Bil AB — Exempelgatan 1, Exempelby" aspect="auto" /></div>\n  </div>`,
    )
    expect(text).toContain('div :global(iframe) {\n    filter: grayscale(0.3) contrast(1.1);\n  }')
  })

  test('absolute and filling via classes, a scoped rule, or top/left 0; the wrapper keeps the other classes (#45)', () => {
    const wrapper = (cls: string) => `<div class="${cls}"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>`
    expect(
      embed(`<div class="relative pb-[56.25%]">\n  <iframe class="absolute inset-0 w-full h-full rounded-lg" src="https://www.google.com/maps/embed?pb=!1" title="Karta"></iframe>\n</div>\n`),
    ).toContain(`<div class="relative pb-[56.25%]">\n  ${wrapper('absolute inset-0 grid rounded-lg')}\n</div>`)
    // The classic responsive embed: scoped rules on the box and its iframe, height: 0 included.
    expect(
      embed(
        `<div class="map-wrap">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" title="Karta"></iframe>\n</div>\n<style>\n  .map-wrap { position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; }\n  .map-wrap iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }\n</style>\n`,
      ),
    ).toContain(`<div class="map-wrap">\n  ${wrapper('absolute inset-0 grid')}\n</div>`)
    // The iframe's own min-height is not carried: the box sizes the wrapper. A definite-height box works too.
    expect(
      embed(`<div class="relative h-96">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" width="100%" height="100%" style="position:absolute;top:0;left:0;min-height:300px" title="Karta"></iframe>\n</div>\n`),
    ).toContain(`<div class="relative h-96">\n  ${wrapper('absolute inset-0 grid')}\n</div>`)
  })

  test('a padding-ratio box without an absolute filling iframe, an absolute iframe that does not fill, or a parent that is not relative: refused (#45)', () => {
    const src = 'src="https://www.google.com/maps/embed?pb=!1" title="Karta"'
    // site 1228881255's box with an in-flow iframe: before #45 this became `grid h-full min-h-[320px]`.
    expect(refused(`<div style="position: relative; padding-bottom: 40%; min-height: 320px;">\n  <iframe ${src} height="100%"></iframe>\n</div>\n`)).toEqual([
      "the map's parent is a padding-ratio box (padding-bottom: 40%) and the iframe does not fill it absolutely",
    ])
    expect(refused(`<div class="relative pt-[75%]">\n  <iframe class="w-full" ${src} height="450"></iframe>\n</div>\n`)).toEqual([
      "the map's parent is a padding-ratio box (pt-[75%]) and the iframe does not fill it absolutely",
    ])
    const notFilling = 'the map iframe is absolutely positioned but does not fill its parent'
    expect(refused(`<div class="relative h-96">\n  <iframe class="absolute inset-0" ${src}></iframe>\n</div>\n`)).toEqual([notFilling])
    expect(refused(`<div class="relative h-96">\n  <iframe class="absolute top-0 w-full h-full" ${src}></iframe>\n</div>\n`)).toEqual([notFilling])
    expect(refused(`<div class="relative h-96">\n  <iframe style="position: absolute; inset: 1rem; width: 100%; height: 100%" ${src}></iframe>\n</div>\n`)).toEqual([notFilling])
    expect(refused(`<div class="h-96">\n  <iframe class="absolute inset-0 w-full h-full" ${src}></iframe>\n</div>\n`)).toEqual([
      'the map iframe fills its parent absolutely, but the parent is not position: relative',
    ])
    // A position that changes on some screens: wire cannot tell.
    expect(refused(`<div class="relative h-96">\n  <iframe class="absolute md:static inset-0 w-full h-full" ${src}></iframe>\n</div>\n`)).toEqual([
      'the map iframe has a position class with a variant (md:static)',
    ])
    expect(
      refused(`<div class="relative h-96">\n  <iframe class="absolute inset-0 w-full h-full" ${src}></iframe>\n</div>\n<style>\n  @media (max-width: 640px) { iframe { position: static; } }\n</style>\n`),
    ).toEqual(["scoped CSS 'iframe' sets an iframe position and wire cannot tell if it applies to this map"])
    // Review of #67: a background map under other content in the box. The wrapper would sit under
    // that content (Visa unclickable) and a 0px box would spill over what follows; main refused it.
    expect(
      refused(`<div class="relative">\n  <iframe class="absolute inset-0 w-full h-full" ${src}></iframe>\n  <div class="relative z-10 p-8"><h2>Hitta hit</h2></div>\n</div>\n`),
    ).toEqual(['the map iframe fills its parent absolutely, but the parent holds more than the map'])
    // A comment beside it is no content (site 1218365709's KontaktSection holds only the iframe).
    expect(embed(`<div class="relative min-h-[400px] lg:min-h-0" data-animate>\n  <!-- karta -->\n  <iframe class="absolute inset-0 w-full h-full" style="border: 0; display: block;" ${src}></iframe>\n</div>\n`)).toContain(
      '<div class="absolute inset-0 grid"><ConsentEmbed',
    )
    // Review of #67: a min/max size class on the iframe is not dropped silently.
    for (const cls of ['max-h-96', 'min-h-[300px]', 'md:max-w-xl']) {
      expect(refused(`<div class="relative h-96">\n  <iframe class="absolute inset-0 w-full h-full ${cls}" ${src}></iframe>\n</div>\n`)).toEqual([
        `the map iframe has a min/max size class (${cls}) that the absolute wrapper does not carry`,
      ])
    }
  })

  test('a parent sized by a scoped aspect-ratio is definite (.contact-info-map-frame)', () => {
    const map = `<iframe src="https://www.google.com/maps/embed?pb=!1" width="100%" height="100%" style="border:0;" title="Karta"></iframe>`
    const aha = `<div class="frame">\n  ${map}\n</div>\n<style>\n  .frame {\n    aspect-ratio: 4 / 5;\n    overflow: hidden;\n  }\n  @media (max-width: 900px) {\n    .frame { aspect-ratio: 4 / 3; }\n  }\n</style>\n`
    expect(embed(aha)).toContain(`<div class="frame">\n  <div class="grid h-full"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>\n</div>`)
    // Only on some screens, turned off on some, or not a ratio: not definite.
    for (const css of [
      '@media (min-width: 900px) { .frame { aspect-ratio: 4 / 5; } }',
      '.frame { aspect-ratio: 4 / 5; }\n  @media (max-width: 640px) { .frame { aspect-ratio: auto; } }',
      '.frame { aspect-ratio: auto; }',
      '.frame { aspect-ratio: var(--r); }',
      '.frame { aspect-ratio: 4 / 5; }\n  .frame { aspect-ratio: auto; }',
      '.frame { aspect-ratio: 4 / 5; }\n  @media (max-width: 600px) { .wrap .frame { aspect-ratio: auto; } }',
      '.frame { aspect-ratio: 4 / 5; }\n  .frame:hover { aspect-ratio: auto; }',
      '.frame { aspect-ratio: 0; }',
      '.frame { aspect-ratio: 1 / 0; }',
    ]) {
      expect(refused(`<div class="frame">\n  ${map}\n</div>\n<style>\n  ${css}\n</style>\n`)).toEqual(['map fills a parent of unknown height'])
    }
    expect(embed(`<div class="frame">\n  ${map}\n</div>\n<style>\n  .frame { aspect-ratio: 4 / 5 !important; }\n</style>\n`)).toContain('<div class="grid h-full"><ConsentEmbed')
    // A display that drops the box (contents, inline, none), in scoped CSS (by class, element or id) or a class: not definite.
    for (const css of [
      '.frame { aspect-ratio: 4 / 5; display: contents; }',
      '.frame { aspect-ratio: 4 / 5; }\n  @media (max-width: 640px) { .frame { display: inline; } }',
      '.frame { aspect-ratio: 4 / 5; }\n  div { display: contents; }',
      '.frame { aspect-ratio: 4 / 5; }\n  .wrap > div { aspect-ratio: auto; }',
      '.frame { aspect-ratio: 4 / 5; }\n  #karta { display: inline; }',
    ]) {
      expect(refused(`<div class="frame" id="karta">\n  ${map}\n</div>\n<style>\n  ${css}\n</style>\n`)).toEqual(['map fills a parent of unknown height'])
    }
    for (const cls of ['contents', 'inline', 'md:hidden', '!contents', 'contents!', 'md:!hidden', '[display:contents]']) {
      expect(refused(`<div class="frame ${cls}">\n  ${map}\n</div>\n<style>\n  .frame { aspect-ratio: 4 / 5; }\n</style>\n`)).toEqual(['map fills a parent of unknown height'])
    }
    expect(embed(`<div class="frame">\n  ${map}\n</div>\n<style>\n  .frame { display: block; aspect-ratio: 4 / 5; }\n</style>\n`)).toContain('<div class="grid h-full"><ConsentEmbed')
    // An inline style wins over the scoped rule; an inline box has no aspect-ratio.
    for (const style of ['aspect-ratio: auto', 'display: inline', 'display: contents']) {
      expect(refused(`<div class="frame" style="${style}">\n  ${map}\n</div>\n<style>\n  .frame { aspect-ratio: 4 / 5; }\n</style>\n`)).toEqual(['map fills a parent of unknown height'])
    }
    expect(refused(`<span class="frame">\n  ${map}\n</span>\n<style>\n  .frame { aspect-ratio: 4 / 5; }\n</style>\n`)).toEqual(['map fills a parent of unknown height'])
  })

  test('inline style height:100% in an unsized parent: refused (Ruling 31)', () => {
    expect(refused(`<div>\n  <iframe src="https://www.google.com/maps/embed?pb=!1" style="width:100%;height:100%" title="Karta"></iframe>\n</div>\n`)).toEqual([
      'map fills a parent of unknown height',
    ])
  })

  test("scoped CSS for a class the wrapper keeps sets display or another height: refused (a client map was 0px tall)", () => {
    const wrap = `<div class="karta">\n  <iframe class="contact-map" src="https://www.google.com/maps/embed?pb=!1" height="100%" title="Karta"></iframe>\n</div>\n`
    expect(refused(`${wrap}<style>\n  .karta { min-height: 500px; }\n  .contact-map {\n    width: 100%;\n    height: 100%;\n    display: block;\n  }\n</style>\n`)).toEqual([
      "scoped CSS for the iframe's class .contact-map sets display: block, which beats the wrapper's grid",
    ])
    expect(
      refused(`<iframe class="map rounded" src="https://www.google.com/maps/embed?pb=!1" height="450" title="Karta"></iframe>\n<style>\n  section .map:hover { height: auto }\n</style>\n`),
    ).toEqual(["scoped CSS for the iframe's class .map sets height: auto, which beats the wrapper's h-[450px]"])
    expect(
      refused(`<iframe class="map" src="https://www.google.com/maps/embed?pb=!1" height="450" title="Karta"></iframe>\n<style>\n  .map { height: 50% }\n</style>\n`),
    ).toEqual(["scoped CSS for the iframe's class .map sets height: 50%, which beats the wrapper's h-[450px]"])
  })

  test('scoped CSS for a kept class that agrees with the wrapper (display: grid, height: 100% on h-full, other properties) is wired', () => {
    const text = embed(
      `<div class="karta">\n  <iframe class="contact-map" src="https://www.google.com/maps/embed?pb=!1" height="100%" title="Karta"></iframe>\n</div>\n<style>\n  .karta { min-height: 500px; }\n  .contact-map { height: 100%; display: grid; border-radius: 8px; }\n  .contact-mapx, .other .contact-map-wrap { display: block; }\n</style>\n`,
    )
    expect(text).toContain('<div class="grid h-full min-h-[500px] contact-map"><ConsentEmbed')
    // A definite height still stretches the grid's embed; display: none hides it as before; a
    // pseudo-element or :not() rule does not style the wrapper itself; case and !important agree.
    const fixed = embed(
      `<iframe class="map" src="https://www.google.com/maps/embed?pb=!1" height="450" title="Karta"></iframe>\n<style>\n  .map { height: 450px; display: Grid !important; }\n  @media (min-width: 768px) { .map { height: 500px } }\n  @media (max-width: 640px) { .map { display: none } }\n  section .map:hover { height: 30rem }\n  .map::before { display: block; content: ""; height: auto }\n  div:not(.map) { display: block }\n</style>\n`,
    )
    expect(fixed).toContain('<div class="grid h-[450px] map"><ConsentEmbed')
  })

  test('fills a parent of unknown height: refused', () => {
    expect(refused(`<div class="karta">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="100%" title="Karta"></iframe>\n</div>\n`)).toEqual([
      'map fills a parent of unknown height',
    ])
  })

  test('inline style="filter: grayscale(0.2)" → a scoped div :global(iframe) rule carries the filter (as site-1218869363/merged)', () => {
    expect(
      embed(
        `<section>\n  <iframe src="https://www.google.com/maps/embed?pb=!1" style="border:0; filter: grayscale(0.2)" title="Karta"></iframe>\n</section>\n`,
      ),
    ).toBe(
      `---\n${IMPORT}\n---\n<section>\n  <div><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" /></div>\n</section>\n<style>\n  div :global(iframe) {\n    filter: grayscale(0.2);\n  }\n</style>\n`,
    )
    // With a scoped <style> already in the file: the rule goes last in it.
    expect(
      embed(
        `<div class="w-full">\n  <iframe class="w-full" src="https://www.google.com/maps/embed?pb=!1" style="filter: grayscale(0.2)" title="Karta"></iframe>\n</div>\n<style>\n  p {\n    color: red;\n  }\n</style>\n`,
      ),
    ).toContain('  p {\n    color: red;\n  }\n\n  div :global(iframe) {\n    filter: grayscale(0.2);\n  }\n</style>\n')
  })

  // Ruling 30: the wrapper keeps the iframe's classes, so a class-targeted rule would filter the
  // placeholder (and the Visa button) too, and the iframe twice.
  test.each([
    ['.karta { filter }', '  .karta {\n    filter: grayscale(1);\n  }'],
    ['.karta:hover { … filter }', '  .karta:hover {\n    opacity: 0.9;\n    filter: none;\n  }'],
  ])('a scoped rule targeting the iframe by class (%s): refused (Ruling 30)', (_name, rule) => {
    expect(
      refused(`<iframe class="karta w-full" src="https://www.google.com/maps/embed?pb=!1" title="Karta"></iframe>\n<style>\n${rule}\n</style>\n`),
    ).toEqual(["filter rule targets the iframe's class"])
  })

  // A Tailwind filter utility on the iframe would grey the placeholder (and the Visa button) on the
  // wrapper; it goes on the wrapper as `[&_iframe]:<utility>` so it reaches only the loaded map (site 1253343488).
  test("class 'w-full h-full grayscale' → wrapper '[&_iframe]:grayscale', not 'grayscale'", () => {
    const text = embed(
      `<div class="h-72">\n  <iframe class="w-full h-full grayscale" src="https://www.google.com/maps/embed?pb=!1" title="Karta"></iframe>\n</div>\n`,
    )
    expect(text).toContain('<div class="grid h-full w-full [&_iframe]:grayscale"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>')
  })

  test.each([['sepia'], ['blur-sm'], ['brightness-90'], ['contrast-125'], ['saturate-50'], ['-hue-rotate-15'], ['invert'], ['grayscale-50'], ['drop-shadow-md']])(
    'filter utility %s moves under [&_iframe]:',
    (util) => {
      expect(embed(`<iframe class="w-full ${util}" src="https://www.google.com/maps/embed?pb=!1" title="Karta"></iframe>\n`)).toContain(
        `<div class="w-full [&_iframe]:${util}"><ConsentEmbed`,
      )
    },
  )

  test('a filter utility with a variant (hover:grayscale-0): refused', () => {
    expect(
      refused(`<iframe class="w-full grayscale hover:grayscale-0" src="https://www.google.com/maps/embed?pb=!1" title="Karta"></iframe>\n`),
    ).toEqual(['iframe has a filter class with a variant (hover:grayscale-0)'])
  })

  test('a scoped rule that targets the iframe through a child combinator: refused', () => {
    expect(
      refused(
        `<div class="w">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" title="Karta"></iframe>\n</div>\n<style>\n  .w > iframe { filter: sepia(1); }\n</style>\n`,
      ),
    ).toEqual(["cannot rewrite the style selector '.w > iframe' for the map's wrapper"])
  })

  test('missing title → refused: iframe has no title', () => {
    expect(refused(`<iframe src="https://www.google.com/maps/embed?pb=!1"></iframe>\n`)).toEqual(['iframe has no title'])
    expect(refused(`<iframe src="https://www.google.com/maps/embed?pb=!1" title=""></iframe>\n`)).toEqual(['iframe has no title'])
  })

  test('needs-human report → the whole plan refused with report.reasons', () => {
    const site = memSite({ [MAP]: `<iframe src="https://www.google.com/maps/embed?pb=!1" title="Karta"></iframe>\n` })
    const reasons = ['unresolved iframe src in src/pages/kalendrar.astro', 'tracker gtm: the batch wires notice and consent only']
    const result = plan([wireLayout, wireLinks, wirePrivacy, wireEmbeds], site, reportFor(site, { classification: 'needs-human', reasons }))
    expect(result.ok).toBe(false)
    expect(refusals(result)).toEqual(expect.arrayContaining(reasons))
  })

  test("the site's own iframes are left alone", () => {
    const files = memSite({ [MAP]: `<iframe src="/widget.html" title="Widget"></iframe>\n` })
    expect(plan([wireEmbeds], files, reportFor(files))).toEqual({ ok: true, edits: [], newFiles: [], skipped: [] })
  })

  test.each([
    ['site-1218869363', 'src/components/ContactMap.astro'],
    ['site-1243511314', 'src/components/Contact.astro'],
    ['site-1243335919', 'src/components/ContactFormSection.astro'],
    ['site-1245311266', 'src/components/ContactSection.astro'],
  ])('%s: the map component comes out as expected/ (scoped-style rewrites included)', (site, path) => {
    const { files, result } = fixturePlan(site)
    expect(after(result, files, path)).toBe(expectedText(site, path))
  })
})

describe('wireWidgets', () => {
  const SCRIPT = '<script is:inline src="https://elfsightcdn.com/platform.js" async></script>'
  const div = (n: number): string => `<div class="elfsight-app-00000000-0000-0000-0000-00000000000${n}" data-elfsight-app-lazy></div>`
  const IMPORT = "import ConsentWidget from '@visionmediahq/astro-consent/components/ConsentWidget.astro'"
  const open = (script = 'https://elfsightcdn.com/platform.js'): string => `<ConsentWidget service="elfsight" script="${script}" title="Innehållet">`

  /** detect's widgets over `files` (the bare site has no layout or config: its other reasons are dropped), then wireWidgets alone. */
  const widgets = (files: Record<string, string>, over: (r: Report) => Partial<Report> = () => ({})): { site: SiteFiles; result: WirePlan } => {
    const site = memSite(files)
    const report: Report = { ...detect(site, 'x', ['x.se']), classification: 'consent', reasons: [] }
    return { site, result: plan([wireWidgets], site, { ...report, ...over(report) }) }
  }

  test('two divs and one script in a file: two wrappers, the script line removed once, one import', () => {
    const path = 'src/pages/index.astro'
    const { site, result } = widgets({ [path]: `<section>\n  ${SCRIPT}\n  ${div(1)}\n  <p>Text.</p>\n  ${div(2)}\n</section>\n` })
    expect(result.ok && result.edits.map((e) => e.target)).toEqual([
      `ConsentWidget import (${path})`,
      `widget (${path}:3)`,
      `widget (${path}:5)`,
      `widget script (${path})`,
    ])
    expect(after(result, site, path)).toBe(
      `---\n${IMPORT}\n---\n<section>\n  ${open()}\n  ${div(1)}\n  </ConsentWidget>\n  <p>Text.</p>\n  ${open()}\n  ${div(2)}\n  </ConsentWidget>\n</section>\n`,
    )
  })

  test('the same widget id in two files, each with its script (Review Focus 2): both wired', () => {
    const a = 'src/components/News.astro'
    const b = 'src/pages/nyheter.astro'
    const { site, result } = widgets({ [a]: `${SCRIPT}\n${div(1)}\n`, [b]: `<main>\n  ${SCRIPT}\n  ${div(1)}\n</main>\n` })
    expect(after(result, site, a)).toBe(`---\n${IMPORT}\n---\n${open()}\n${div(1)}\n</ConsentWidget>\n`)
    expect(after(result, site, b)).toBe(`---\n${IMPORT}\n---\n<main>\n  ${open()}\n  ${div(1)}\n  </ConsentWidget>\n</main>\n`)
  })

  test('the loader URL is kept as written (V3, Task 0 probe)', () => {
    const path = 'src/pages/index.astro'
    const old = 'https://static.elfsight.com/platform/platform.js'
    const { site, result } = widgets({ [path]: `<script src="${old}" async is:inline></script>\n${div(1)}\n` })
    expect(after(result, site, path)).toBe(`---\n${IMPORT}\n---\n${open(old)}\n${div(1)}\n</ConsentWidget>\n`)
  })

  test('a multi-line div keeps its lines; the tags take its indent; the comment before the script stays', () => {
    const path = 'src/components/Feed.astro'
    const multi = `<div\n        class="elfsight-app-00000000-0000-0000-0000-000000000001"\n        data-elfsight-app-lazy\n      >\n      </div>`
    const { site, result } = widgets({ [path]: `---\nimport X from './X.astro';\n---\n<section>\n    <div>\n      ${multi}\n    </div>\n</section>\n\n<!-- Elfsight -->\n${SCRIPT}\n` })
    expect(after(result, site, path)).toBe(
      `---\nimport X from './X.astro';\n${IMPORT};\n---\n<section>\n    <div>\n      ${open()}\n      ${multi}\n      </ConsentWidget>\n    </div>\n</section>\n\n<!-- Elfsight -->\n`,
    )
  })

  test('a script that shares its line with other markup: only the element goes', () => {
    const path = 'src/pages/index.astro'
    const { site, result } = widgets({ [path]: `<p>Text.</p>${SCRIPT}\n${div(1)}\n` })
    expect(after(result, site, path)).toBe(`---\n${IMPORT}\n---\n<p>Text.</p>\n${open()}\n${div(1)}\n</ConsentWidget>\n`)
  })

  test('CRLF files keep CRLF', () => {
    const path = 'src/pages/index.astro'
    const { site, result } = widgets({ [path]: `<main>\r\n  ${SCRIPT}\r\n  ${div(1)}\r\n</main>\r\n` })
    expect(after(result, site, path)).toBe(`---\r\n${IMPORT}\r\n---\r\n<main>\r\n  ${open()}\r\n  ${div(1)}\r\n  </ConsentWidget>\r\n</main>\r\n`)
  })

  test('a div that does not start its line: refused (its wrapper would have no line of its own)', () => {
    const path = 'src/pages/index.astro'
    const { result } = widgets({ [path]: `${SCRIPT}\n<p>Text.</p>${div(1)}\n` })
    expect(refusals(result)).toEqual(['widget div does not start its line'])
  })

  test('a div offset that does not match: refused', () => {
    const path = 'src/pages/index.astro'
    const { result } = widgets({ [path]: `${SCRIPT}\n${div(1)}\n` }, (r) => ({ widgets: r.widgets.map((w) => ({ ...w, start: w.start + 1 })) }))
    const start = SCRIPT.length + 2
    expect(refusals(result)).toEqual([`widget div at offset ${start} not found`])
  })

  test('a script offset that does not match: refused', () => {
    const path = 'src/pages/index.astro'
    const { result } = widgets({ [path]: `${SCRIPT}\n${div(1)}\n` }, (r) => ({ widgets: r.widgets.map((w) => ({ ...w, scriptAt: { start: 1, end: w.scriptAt.end } })) }))
    expect(refusals(result)).toEqual(['widget script at offset 1 not found'])
  })

  test('a package ConsentWidget already in the file (wired by hand): nothing to plan', () => {
    const path = 'src/pages/index.astro'
    const { result } = widgets({ [path]: `---\n${IMPORT}\n---\n${open()}\n${div(1)}\n</ConsentWidget>\n` })
    expect(result).toEqual({ ok: true, edits: [], newFiles: [], skipped: [] })
  })

  test('INSTALL_SPEC is ^1.1.2 (the first version whose ConsentWidget works on Astro 6)', () => {
    expect(INSTALL_SPEC).toBe('github:visionmediahq/astro-consent#semver:^1.1.2')
  })

  test.each([
    ['elfsight-v1', 'src/components/InstagramFeed.astro'],
    ['elfsight-v2-before', 'src/components/InstagramSection.astro'],
    ['elfsight-v2-after', 'src/components/FacebookFeed.astro'],
    ['elfsight-v3', 'src/pages/prislista.astro'],
  ])('%s: the widget file comes out as expected/', (site, path) => {
    const files = fixtureSite(join(FIXTURES, site, 'before'))
    const result = plan([wireWidgets], files, detect(files, site, [`${site}.se`]))
    expect(after(result, files, path)).toBe(expectedText(site, path))
  })
})
