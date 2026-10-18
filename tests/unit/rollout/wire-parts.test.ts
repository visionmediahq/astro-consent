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
  'aspomad',
  'calendar-literal',
  'domeijstapetserarverkstad',
  'elfsight-v1',
  'elfsight-v2-after',
  'elfsight-v2-before',
  'elfsight-v3',
  'munkforstradgardstjanst',
  'traforadling',
  'vasshallakatthotell',
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

    test('stadsbudskontoret: in the bar after ©, before "Drivs av"; white text (the footer CSS sets color: #fff)', () => {
      const text = wire([wireLinks], site(real('stadsbudskontoret')), 'src/components/Footer.astro')
      expect(text).toContain(
        'Alla rättigheter förbehållna.\n      </p>\n      <PrivacyLinks class="text-white/70" />\n      <p class="text-xs" style="color: rgba(255,255,255,0.5);">\n        Drivs av',
      )
      expect(text).toContain('    </div>\n  </div>\n</footer>')
      expect(tags(text)).toBe(1)
    })

    test('ekostrateg (DaisyUI .footer grid): between © and the logo; colours only in CSS variables, so no class', () => {
      const text = wire([wireLinks], site(real('ekostrateg')), 'src/components/Footer.astro')
      expect(text).toContain('Alla rättigheter förbehållna.</p>\n    <PrivacyLinks />\n    <Image\n')
      expect(text).toContain('    />\n  </div>\n</footer>')
      expect(tags(text)).toBe(1)
    })

    test("landqvistmekaniska: the bar's own Integritetspolicy link to policy_url is replaced (PrivacyLinks renders it)", () => {
      const text = wire([wireLinks], site(real('landqvistmekaniska'), POLICY_PAGE), 'src/components/Footer.astro')
      expect(text).toContain('Verkstad AB.\n      </p>\n      <PrivacyLinks class="text-white/70" />\n    </div>\n  </div>\n</footer>')
      expect(text).not.toContain('<p class="footer-legal">')
      // The column link above the bar stays.
      expect(text).toContain('<li><a href="/integritetspolicy/" class="footer-link">Integritetspolicy</a></li>')
      expect(tags(text)).toBe(1)
    })

    test('landqvistmekaniska with an existing privacy.json: its policy_url path decides', () => {
      const privacy = (url: string) => ({ 'src/data/privacy.json': JSON.stringify({ services: [], policy_url: url }) })
      const same = wire([wireLinks], site(real('landqvistmekaniska'), privacy('https://x.se/integritetspolicy')), 'src/components/Footer.astro')
      expect(same).not.toContain('<p class="footer-legal">')
      const other = wire([wireLinks], site(real('landqvistmekaniska'), { ...POLICY_PAGE, ...privacy('https://x.se/gdpr/') }), 'src/components/Footer.astro')
      expect(other).toContain('<p class="footer-legal">')
    })

    test.each([
      ['no policy page', {}],
      ['a policy page at another path', { 'src/pages/gdpr.astro': PAGE }],
    ])('landqvistmekaniska with %s: the link stays, the links go after ©', (_name, extra) => {
      const text = wire([wireLinks], site(real('landqvistmekaniska'), extra), 'src/components/Footer.astro')
      expect(text).toContain('Verkstad AB.\n      </p>\n      <PrivacyLinks class="text-white/70" />\n      <p class="footer-legal">')
    })

    // #61: the bar's own policy link deeper than the © row's siblings.
    test('exakthaltagning: a policy link in a neighbouring flex div of the bar is replaced in place', () => {
      const text = wire(
        [wireLinks],
        site('<footer class="text-white">\n  <div class="grid"><p>a</p><p>b</p></div>\n  <div class="flex justify-between">\n    <p>© Firma</p>\n    <div class="flex items-center gap-5">\n      <a href="/integritetspolicy/" class="text-xs">Integritetspolicy</a>\n      <span class="text-xs">Slöinge</span>\n    </div>\n  </div>\n</footer>\n', POLICY_PAGE),
        'src/components/Footer.astro',
      )
      expect(text).toContain('    <p>© Firma</p>\n    <div class="flex items-center gap-5">\n      <PrivacyLinks class="text-white" />\n      <span class="text-xs">Slöinge</span>')
      expect(text).not.toContain('Integritetspolicy</a>')
      expect(tags(text)).toBe(1)
    })

    test("schloetter: the GDPR item in the bar's link list, href from a localize() call, becomes the links (justify-start! in a block <li>)", () => {
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

    test('adarate: dark background in scoped CSS, no text colour → text-white/70 after ©', () => {
      const text = wire([wireLinks], site(real('adarate')), 'src/components/Footer.astro')
      expect(text).toContain('Adarate Systems AB</p>\n    <PrivacyLinks class="text-white/70" />\n    <p class="site-footer__address">')
      expect(tags(text)).toBe(1)
    })

    test('adarate with a light scoped background: no class', () => {
      const text = wire([wireLinks], site(real('adarate').replace('background: #0d1219;', 'background: #f4f1ea;')), 'src/components/Footer.astro')
      expect(text).toContain('Adarate Systems AB</p>\n    <PrivacyLinks />\n')
    })

    test('ostansjobilskrot: dark inline background, bar inside the single wrapper → text-white/70 after ©, no justify-start!', () => {
      const text = wire([wireLinks], site(real('ostansjobilskrot')), 'src/components/Footer.astro')
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
    test('tvafroknar: plain <footer>, © bar inside a bg-neutral block → text-neutral-content, centred bar: mt-2 only', () => {
      const text = wire([wireLinks], site(real('tvafroknar')), 'src/components/Footer.astro')
      expect(text).toContain('Två Fröknar AB</p>\n        <PrivacyLinks class="text-neutral-content mt-2" />\n      </div>\n    </div>\n  </div>\n\n</footer>')
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
      const css = real('adarate').replace('background: #0d1219;', 'background: #f4f1ea;').replace('</style>', '  @media (min-width: 768px) {\n    .site-footer { background: #0d1219; }\n  }\n</style>')
      const text = wire([wireLinks], site(css), 'src/components/Footer.astro')
      expect(text).toContain('Adarate Systems AB</p>\n    <PrivacyLinks />\n')
    })

    // #61: a background in a CSS variable is unknown; white text on the footer's own surface says it is dark.
    test.each([
      ['evabekonomi (text-white/NN classes)', '<footer style="background-color: var(--color-on-secondary);">\n  <div class="grid"><p class="text-white/50">a</p><p>b</p></div>\n  <div class="flex">\n    <p class="text-white/45">© Firma</p>\n    <p>VM</p>\n  </div>\n</footer>\n', '<p class="text-white/45">© Firma</p>'],
      ['milodahlmann (inline rgba white)', '<footer style="background: var(--color-primary);">\n  <div class="grid"><p style="color: rgba(255,255,255,0.6);">a</p><p>b</p></div>\n  <div class="flex">\n    <p style="color: rgba(255,255,255,0.4);">© Firma</p>\n    <p>VM</p>\n  </div>\n</footer>\n', '<p style="color: rgba(255,255,255,0.4);">© Firma</p>'],
      ['landhsel (text-white headings, colour in a variable)', '<footer style="background: var(--dark-surface); color: var(--dark-text-secondary);">\n  <div class="grid"><h4 class="text-white">Om oss</h4><p>b</p></div>\n  <div class="flex">\n    <p>© Firma</p>\n    <p>VM</p>\n  </div>\n</footer>\n', '<p>© Firma</p>'],
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

    // Review of #59, I2 (mibfastighetsteknik, transfix, wmtmiljo): a block bar with a left-aligned ©.
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
  // the wrapper (fbop, pdlmotor, bellevueconditori and ramsmora were wired by hand like this).
  test('fills a parent that only has a min-height → the wrapper carries it as min-h-*', () => {
    expect(
      embed(
        `<div class="karta">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="100%" title="Karta"></iframe>\n</div>\n<style>\n  .karta { min-height: 30vh; }\n</style>\n`,
      ),
    ).toContain('<div class="grid h-full min-h-[30vh]"><ConsentEmbed')
    // fbop: h-full on the parent is not a definite height; its min-h-[500px] is.
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
    // height: 0 with padding (the aspect-ratio hack) is no definite height either.
    expect(
      refused(`<div class="r">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="100%" title="Karta"></iframe>\n</div>\n<style>\n  .r { padding-bottom: 56.25%; height: 0px; }\n</style>\n`),
    ).toEqual(['map fills a parent of unknown height'])
  })

  test("the iframe's own inline min-height goes on the wrapper (pdlmotor, bellevueconditori, ramsmora)", () => {
    // pdlmotor: parent min-h-[360px], iframe style min-height: 360px: one min-h, the iframe's.
    expect(
      embed(
        `<div class="lg:col-span-3 min-h-[360px]">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" width="100%" height="100%" style="border: 0; min-height: 360px; display: block;" title="Karta"></iframe>\n</div>\n`,
      ),
    ).toContain('<div class="grid h-full min-h-[360px]"><ConsentEmbed')
    // ramsmora: the parent is h-full (unknown); the iframe's min-height makes the box definite.
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
  test('scoped CSS height on the iframe beats its height attribute (#43, lbfastigheter)', () => {
    const lb = `<div class="kontakt-map__embed">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" width="100%" height="450" style="border:0;" title="Karta"></iframe>\n</div>\n<style>\n  .kontakt-map__embed { height: 450px; overflow: hidden; }\n  .kontakt-map__embed iframe { width: 100%; height: 100%; display: block; }\n  @media (max-width: 640px) { .kontakt-map__embed { height: 300px; } }\n</style>\n`
    expect(embed(lb)).toContain('  <div class="grid h-full"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>\n')
    // A fixed value: the rule's, not the attribute's; also through `>` and for a bare `iframe`.
    expect(
      embed(`<div class="box">\n  <iframe class="h-[450px]" src="https://www.google.com/maps/embed?pb=!1" height="450" title="Karta"></iframe>\n</div>\n<style>\n  .box > iframe { height: 380px !important; }\n</style>\n`),
    ).toContain('<div class="grid h-[380px]"><ConsentEmbed')
    expect(
      embed(`<section>\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="450" title="Karta"></iframe>\n</section>\n<style>\n  iframe { height: 25rem; }\n</style>\n`),
    ).toContain('<div class="grid h-[25rem]"><ConsentEmbed')
    // Rules inside @media set the height on some screens only: the base height stays (bruksgarden:
    // height="400", 260px on phones; restaurangharnet: 460px, 260px on phones). Verify step 5
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

  test("an inline aspect-ratio on an iframe without a fixed height becomes the embed's aspect (#61, exakthaltagning)", () => {
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

  test('a parent sized by an aspect class is definite (#61, champsoflogging: aspect-video)', () => {
    for (const aspect of ['aspect-video', 'aspect-square', 'aspect-[4/3]', 'aspect-4/3']) {
      expect(
        embed(`<div class="${aspect} w-full">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" width="100%" height="100%" style="border:0;" title="Karta"></iframe>\n</div>\n`),
      ).toContain(`<div class="${aspect} w-full">\n  <div class="grid h-full"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>\n</div>`)
    }
    // Only on some screens, or turned off: not definite.
    for (const aspect of ['md:aspect-video', 'aspect-auto']) {
      expect(refused(`<div class="${aspect}">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="100%" title="Karta"></iframe>\n</div>\n`)).toEqual(['map fills a parent of unknown height'])
    }
  })

  test('a parent sized by a scoped aspect-ratio is definite (ahatrafikskola: .contact-info-map-frame)', () => {
    const map = `<iframe src="https://www.google.com/maps/embed?pb=!1" width="100%" height="100%" style="border:0;" title="Karta"></iframe>`
    const aha = `<div class="frame">\n  ${map}\n</div>\n<style>\n  .frame {\n    aspect-ratio: 4 / 5;\n    overflow: hidden;\n  }\n  @media (max-width: 900px) {\n    .frame { aspect-ratio: 4 / 3; }\n  }\n</style>\n`
    expect(embed(aha)).toContain(`<div class="frame">\n  <div class="grid h-full"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>\n</div>`)
    // Only on some screens, turned off on some, or not a ratio: not definite.
    for (const css of [
      '@media (min-width: 900px) { .frame { aspect-ratio: 4 / 5; } }',
      '.frame { aspect-ratio: 4 / 5; }\n  @media (max-width: 640px) { .frame { aspect-ratio: auto; } }',
      '.frame { aspect-ratio: auto; }',
      '.frame { aspect-ratio: var(--r); }',
    ]) {
      expect(refused(`<div class="frame">\n  ${map}\n</div>\n<style>\n  ${css}\n</style>\n`)).toEqual(['map fills a parent of unknown height'])
    }
  })

  test('inline style height:100% in an unsized parent: refused (Ruling 31)', () => {
    expect(refused(`<div>\n  <iframe src="https://www.google.com/maps/embed?pb=!1" style="width:100%;height:100%" title="Karta"></iframe>\n</div>\n`)).toEqual([
      'map fills a parent of unknown height',
    ])
  })

  test("scoped CSS for a class the wrapper keeps sets display or another height: refused (salviablommor: the map was 0px tall)", () => {
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

  test('inline style="filter: grayscale(0.2)" → a scoped div :global(iframe) rule carries the filter (as aspomad/merged)', () => {
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
  // wrapper; it goes on the wrapper as `[&_iframe]:<utility>` so it reaches only the loaded map (abacum).
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
    ['aspomad', 'src/components/ContactMap.astro'],
    ['domeijstapetserarverkstad', 'src/components/Contact.astro'],
    ['traforadling', 'src/components/ContactFormSection.astro'],
    ['vasshallakatthotell', 'src/components/ContactSection.astro'],
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
