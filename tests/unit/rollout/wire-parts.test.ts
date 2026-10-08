import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { detect } from '../../../ci/rollout/detect'
import { detectIframes } from '../../../ci/rollout/detect/iframes'
import { detectStructure } from '../../../ci/rollout/detect/structure'
import { fixtureSite, globToRegExp, type SiteFiles } from '../../../ci/rollout/lib/site-files'
import { wireEmbeds } from '../../../ci/rollout/wire/embeds'
import { applyEdits, Planner } from '../../../ci/rollout/wire/engine'
import { wireLayout } from '../../../ci/rollout/wire/layout'
import { wireLinks } from '../../../ci/rollout/wire/links'
import { wirePrivacy } from '../../../ci/rollout/wire/privacy'
import type { Report, WirePlan } from '../../../ci/rollout/types'

type Part = (p: Planner, r: Report) => void

const FIXTURES = join(import.meta.dirname, 'fixtures')
const WIRED = ['aspomad', 'domeijstapetserarverkstad', 'munkforstradgardstjanst', 'traforadling', 'vasshallakatthotell']
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
    classification: f.iframes.some((i) => i.service === 'google-maps') ? 'maps' : 'notice',
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
      "---\nimport PrivacyLinks from '@visionmediahq/astro-consent/components/PrivacyLinks.astro'\n---\n<footer class=\"bg-neutral text-neutral-content/80\">\n  <div class=\"container text-center\">\n    <p>Adress</p>\n    <p>©</p>\n    <PrivacyLinks class=\"text-neutral-content/80\" />\n  </div>\n</footer>\n",
    )
  })

  test.each([
    ['a split footer (justify-between row)', '<div class="flex justify-between">\n      <p>©</p>\n      <p>Vision Media</p>\n    </div>'],
    ['a left-aligned footer (text-left)', '<div class="text-left">\n      <p>©</p>\n    </div>'],
  ])('%s gets justify-start!', (_name, bar) => {
    const text = wire(
      [wireLinks],
      site(`<footer class="text-white">\n  <div class="container">\n    <div class="grid"><p>a</p><p>b</p></div>\n    ${bar}\n  </div>\n</footer>\n`),
      'src/components/Footer.astro',
    )
    expect(text).toContain('    <PrivacyLinks class="text-white justify-start!" />\n  </div>\n</footer>')
  })

  test('a footer aligned only by its own CSS (alignment unknown): no justify-start!', () => {
    const text = wire(
      [wireLinks],
      site(`<footer class="site-footer">\n  <div class="inner"><p>a</p></div>\n  <div class="bottom"><p>©</p></div>\n</footer>\n`),
      'src/components/Footer.astro',
    )
    expect(text).toContain('  <div class="bottom"><p>©</p></div>\n  <PrivacyLinks />\n</footer>')
  })

  test('footer with no text class: <PrivacyLinks />', () => {
    const text = wire([wireLinks], site(FOOTER.replace(' text-neutral-content', '')), 'src/components/Footer.astro')
    expect(text).toContain('    <p>© Firma</p>\n    <PrivacyLinks />\n  </div>')
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
    expect(text).toContain('  <p>© Firma <a href="/integritet">Integritet</a></p>\n  <PrivacyLinks />\n</footer>')
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
    expect(text).toContain('    <p>©</p>\n    <PrivacyLinks />\n  </div>\n</footer>')
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
  test('footerless page whose <main> has several children: the last child of <main>', () => {
    const text = wire(
      [wireLinks],
      { 'src/pages/404.astro': `<html><body>\n  <main>\n    <h1>404</h1>\n    <a href="/">Tillbaka</a>\n  </main>\n</body></html>\n` },
      'src/pages/404.astro',
    )
    expect(text).toContain('    <a href="/">Tillbaka</a>\n    <PrivacyLinks />\n  </main>')
  })

  test("footerless page whose <main> has one element child: the last child of that child (Ruling 16)", () => {
    const text = wire(
      [wireLinks],
      { 'src/pages/404.astro': `<html><body>\n  <main class="flex">\n    <div class="box">\n      <h1>404</h1>\n      <a href="/">Tillbaka</a>\n    </div>\n  </main>\n</body></html>\n` },
      'src/pages/404.astro',
    )
    expect(text).toContain('      <a href="/">Tillbaka</a>\n      <PrivacyLinks />\n    </div>\n  </main>')
  })

  test('a 404 whose <main> holds only an <h1>: the links go in <main>, not inside the heading (Ruling 29)', () => {
    const text = wire(
      [wireLinks],
      { 'src/pages/404.astro': `<html><body>\n  <main>\n    <h1>Sidan finns inte</h1>\n  </main>\n</body></html>\n` },
      'src/pages/404.astro',
    )
    expect(text).toContain('    <h1>Sidan finns inte</h1>\n    <PrivacyLinks />\n  </main>')
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
    expect(text).toContain('  <h1>Hej</h1>\n  <PrivacyLinks />\n</Base>')
  })

  test('footerless page with its own <html> and no <main>: the last child of <body>', () => {
    const text = wire([wireLinks], { 'src/pages/tack.astro': `<html>\n  <body>\n    <p>Tack!</p>\n  </body>\n</html>\n` }, 'src/pages/tack.astro')
    expect(text).toContain('    <p>Tack!</p>\n    <PrivacyLinks />\n  </body>')
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
    expect(
      embed(
        `<div class="karta">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" height="100%" title="Karta"></iframe>\n</div>\n<style>\n  .karta { min-height: 30vh; }\n</style>\n`,
      ),
    ).toContain('<div class="grid h-full"><ConsentEmbed')
  })

  test('inline style sizing (Ruling 31): height:100% fills a sized parent; height: <n>px is fixed', () => {
    expect(
      embed(`<div class="h-[400px]">\n  <iframe src="https://www.google.com/maps/embed?pb=!1" style="border:0;width:100%;HEIGHT : 100%" title="Karta"></iframe>\n</div>\n`),
    ).toContain('  <div class="grid h-full"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>\n')
    expect(
      embed(`<iframe class="w-full" src="https://www.google.com/maps/embed?pb=!1" style="height:450px" title="Karta"></iframe>\n`),
    ).toContain('<div class="grid h-[450px] w-full"><ConsentEmbed service="google-maps" src="https://www.google.com/maps/embed?pb=!1" title="Karta" aspect="auto" /></div>')
  })

  test('inline style height:100% in an unsized parent: refused (Ruling 31)', () => {
    expect(refused(`<div>\n  <iframe src="https://www.google.com/maps/embed?pb=!1" style="width:100%;height:100%" title="Karta"></iframe>\n</div>\n`)).toEqual([
      'map fills a parent of unknown height',
    ])
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
    const reasons = ['unresolved iframe src in src/pages/kalendrar.astro', 'tracker gtm: the batch wires notice and maps only']
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
