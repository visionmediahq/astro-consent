import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { classify, type Findings } from '../../../ci/rollout/detect/classify'
import { detectScripts } from '../../../ci/rollout/detect/scripts'
import { diskSite } from '../../../ci/rollout/lib/site-files'

const dirs: string[] = []
function inline(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'script-hosts-'))
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

const page = (head: string, frontmatter = '') =>
  `${frontmatter ? `---\n${frontmatter}\n---\n` : ''}<html><head>${head}</head><body><main /></body></html>\n`
const hostsOf = (files: Record<string, string>) => detectScripts(inline(files)).scriptHosts.map((h) => `${h.host} ${h.file}`)

describe('detectScripts: scripts from hosts outside the registry (#36)', () => {
  test('an absolute <script src> from an unregistered host is listed with its file', () => {
    expect(hostsOf({ 'src/layouts/Base.astro': page('<script is:inline src="https://widget.example/x.js" async></script>') })).toEqual([
      'widget.example src/layouts/Base.astro',
    ])
  })

  test('a protocol-relative src is listed too, and the host is lower-cased', () => {
    expect(hostsOf({ 'src/layouts/Base.astro': page('<script src="//Chat.Example.com/w.js"></script>') })).toEqual([
      'chat.example.com src/layouts/Base.astro',
    ])
  })

  test('a src built in a template literal keeps its literal host', () => {
    expect(
      hostsOf({ 'src/layouts/Base.astro': page('<script is:inline src={`https://widget.example/${id}.js`}></script>', "const id = 'a'") }),
    ).toEqual(['widget.example src/layouts/Base.astro'])
  })

  test('a remote import in a script body is listed', () => {
    expect(hostsOf({ 'src/components/W.astro': "<script>\nimport 'https://esm.example/w.js'\n</script>\n" })).toEqual([
      'esm.example src/components/W.astro',
    ])
  })

  test('a host is listed once per file', () => {
    const head = '<script src="https://widget.example/a.js"></script><script src="https://widget.example/b.js"></script>'
    expect(hostsOf({ 'src/layouts/Base.astro': page(head) })).toEqual(['widget.example src/layouts/Base.astro'])
  })

  test('relative and root paths are not hosts', () => {
    expect(hostsOf({ 'src/layouts/Base.astro': page('<script src="/js/a.js"></script><script src="./b.js"></script><script src="c.js"></script>') })).toEqual([])
  })

  test('a registry host is a tracker, not an unregistered host', () => {
    const r = detectScripts(inline({ 'src/layouts/Base.astro': page('<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>') }))
    expect(r.scriptHosts).toEqual([])
    expect(r.trackers).toEqual(['google-analytics'])
  })

  test('the reCAPTCHA script is not listed: detect reports it as `recaptcha` and spam-guard replaces it', () => {
    const r = detectScripts(inline({ 'src/layouts/Base.astro': page('<script src="https://www.google.com/recaptcha/api.js?render=x"></script>') }))
    expect(r.scriptHosts).toEqual([])
    expect(r.recaptcha).toBe(true)
  })

  test('the Elfsight platform script (a widget, reported by detectWidgets) is not listed', () => {
    expect(hostsOf({ 'src/components/E.astro': '<script src="https://elfsightcdn.com/platform.js" async></script>\n' })).toEqual([])
  })

  test('an <a href> or an <img src> to another host is not a script', () => {
    expect(hostsOf({ 'src/layouts/Base.astro': page('<link rel="stylesheet" href="https://x.example/a.css"><img src="https://x.example/a.png">') })).toEqual([])
  })

  test('JSON data scripts are skipped', () => {
    expect(hostsOf({ 'src/layouts/Base.astro': page('<script type="application/ld+json" src="https://schema.example/x"></script>') })).toEqual([])
  })

  test('a script in a CMS admin shell is skipped (it never reaches a visitor)', () => {
    expect(hostsOf({ 'src/pages/admin/index.astro': '<script is:inline src="https://unpkg.com/@sveltia/cms@0.1.0/dist/sveltia-cms.js"></script>\n' })).toEqual([])
    expect(hostsOf({ 'public/admin/index.html': '<script src="https://unpkg.com/@sveltia/cms@0.1.0/dist/sveltia-cms.js"></script>\n' })).toEqual([])
  })

  test('a plain HTML file under public/ outside admin is read as well', () => {
    expect(hostsOf({ 'public/promo.html': '<script src="https://widget.example/x.js"></script>\n' })).toEqual(['widget.example public/promo.html'])
  })

  test.each([
    ['a line comment', '// import "https://x.example/a.js"'],
    ['a block comment', '/* import "https://x.example/a.js" */'],
    ['a string', 'const doc = "we import from \'https://x.example/doc\'"'],
  ])('%s in a script body is not a remote import', (_, body) => {
    expect(hostsOf({ 'src/components/W.astro': `<script>\n${body}\n</script>\n` })).toEqual([])
  })

  test.each([
    ["import 'https://x.example/a.js'"],
    ["import a from 'https://x.example/a.js'"],
    ["import {\n  a,\n  b,\n} from 'https://x.example/a.js'"],
    ["export * from 'https://x.example/a.js'"],
    ["const m = await import('https://x.example/a.js')"],
    ["import(\"//x.example/a.js\")"],
  ])('a real remote import is listed: %s', (body) => {
    expect(hostsOf({ 'src/components/W.astro': `<script>\n${body}\n</script>\n` })).toEqual(['x.example src/components/W.astro'])
  })

  test.each([
    ["<script>import 'https://x.example/a.js'</script>"],
    ["<script type=\"module\">import 'https://x.example/a.js'\n</script>"],
    ["<script>await import('https://x.example/a.js')</script>"],
    ["<script>import a from 'https://x.example/a.js'; a()</script>"],
  ])('a remote import on the first line of the body, right after the tag, is listed: %s', (markup) => {
    expect(hostsOf({ 'src/components/W.astro': `${markup}\n` })).toEqual(['x.example src/components/W.astro'])
  })

  test('data-src and data-type on a script in plain HTML are not src and type', () => {
    expect(hostsOf({ 'public/a.html': '<script data-src="https://x.example/a.js"></script>\n' })).toEqual([])
    expect(hostsOf({ 'public/a.html': '<script data-type="application/json" src="https://x.example/a.js"></script>\n' })).toEqual(['x.example public/a.html'])
  })

  test('a commented-out script in a plain HTML file is not listed', () => {
    expect(hostsOf({ 'public/a.html': '<!-- <script src="https://x.example/a.js"></script> -->\n<p>hej</p>\n' })).toEqual([])
    expect(hostsOf({ 'public/a.html': '<!--\n<script src="https://x.example/a.js"></script>\n-->\n<script src="https://y.example/b.js"></script>\n' })).toEqual([
      'y.example public/a.html',
    ])
  })

  test('a JSON data script in a plain HTML file is skipped', () => {
    expect(hostsOf({ 'public/a.html': '<script type="application/ld+json" src="https://schema.example/x"></script>\n' })).toEqual([])
  })

  test('a nested admin path is a visitor path to the tool: listed, for a person to look at', () => {
    expect(hostsOf({ 'src/pages/sv/admin/x.astro': '<script src="https://widget.example/x.js"></script>\n' })).toEqual(['widget.example src/pages/sv/admin/x.astro'])
  })

  test('a trailing dot on the host is dropped, so the site-own check and the list still match', () => {
    expect(hostsOf({ 'src/layouts/Base.astro': page('<script src="https://dot.example./a.js"></script>') })).toEqual(['dot.example src/layouts/Base.astro'])
    expect(hostsOf({ 'src/layouts/Base.astro': page('<script src="https://browser.sentry-cdn.com./8/bundle.min.js"></script>') })).toEqual([
      'browser.sentry-cdn.com src/layouts/Base.astro',
    ])
  })

  test('an unterminated HTML comment hides the rest of a plain HTML file, as a browser reads it', () => {
    expect(hostsOf({ 'public/a.html': '<!-- never closed\n<script src="https://x.example/a.js"></script>\n' })).toEqual([])
  })

  // Real files never look like this, but a minified or broken file under public/ must not stall detect.
  test.each([
    ['/* without */ in a script body', (n: number) => ({ 'src/components/W.astro': `<script>${'/*\n'.repeat(n)}</script>` })],
    ['one long line of from in a script body', (n: number) => ({ 'src/components/W.astro': `<script>import ${'from '.repeat(n)}</script>` })],
    ['<script without a >', (n: number) => ({ 'public/a.html': '<script '.repeat(n) })],
    ['<!-- without -->', (n: number) => ({ 'public/a.html': '<!--'.repeat(n) })],
    ['a src that never closes', (n: number) => ({ 'public/a.html': '<script src="https://a'.repeat(n) })],
    ['import in a script body', (n: number) => ({ 'src/components/W.astro': `<script>${'import '.repeat(n)}</script>` })],
  ])('1 MB of %s is read in linear time', (_, make) => {
    const files = make(Math.ceil(1_000_000 / 8))
    const site = inline(files)
    const t = Date.now()
    detectScripts(site)
    expect(Date.now() - t).toBeLessThan(2000)
  })

  test("Sentry's plain major-8 bundle is not listed: detectSentry reports it and wire self-hosts it (#93)", () => {
    expect(
      hostsOf({
        'src/layouts/Base.astro': page(
          '<script src="https://browser.sentry-cdn.com/8.55.0/bundle.min.js"></script><script src="https://cdn.jsdelivr.net/npm/@sentry/browser@8/build/bundle.min.js"></script>',
        ),
      }),
    ).toEqual([])
  })

  test('any other script from the Sentry CDNs is listed: they are no longer agreed hosts (#93)', () => {
    expect(
      hostsOf({
        'src/layouts/Base.astro': page(
          '<script src="https://browser.sentry-cdn.com/8.55.0/bundle.tracing.min.js"></script><script src="https://js.sentry-cdn.com/abc.min.js"></script><script src="https://cdn.jsdelivr.net/npm/@sentry/browser@7/build/bundle.min.js"></script>',
        ),
      }),
    ).toEqual(['browser.sentry-cdn.com src/layouts/Base.astro', 'js.sentry-cdn.com src/layouts/Base.astro', 'cdn.jsdelivr.net src/layouts/Base.astro'])
  })

  test('the allowlist is by host and path: jsDelivr for something else is listed', () => {
    expect(hostsOf({ 'src/layouts/Base.astro': page('<script src="https://cdn.jsdelivr.net/npm/some-chat-widget@1/w.js"></script>') })).toEqual([
      'cdn.jsdelivr.net src/layouts/Base.astro',
    ])
  })
})

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

describe('classify: unregistered script hosts', () => {
  test('an unregistered script host sends the site to a human, naming host and file', () => {
    expect(classify(clean({ scriptHosts: [{ host: 'widget.example', file: 'src/layouts/Base.astro' }] }))).toEqual({
      classification: 'needs-human',
      reasons: ['unregistered script host widget.example in src/layouts/Base.astro'],
    })
  })

  test("the site's own domain, www and subdomains are not reported", () => {
    const hosts = ['example.se', 'www.example.se', 'static.example.se'].map((host) => ({ host, file: 'src/layouts/Base.astro' }))
    expect(classify(clean({ scriptHosts: hosts }))).toEqual({ classification: 'notice', reasons: [] })
  })

  test('a host that only ends in the domain is not the domain', () => {
    expect(classify(clean({ scriptHosts: [{ host: 'notexample.se', file: 'a.astro' }] })).classification).toBe('needs-human')
  })

  test('own host matching ignores case and the port, and a look-alike suffix is not own', () => {
    const own = ['WWW.Example.se', 'example.se'].map((host) => ({ host: host.toLowerCase(), file: 'a.astro' }))
    expect(classify(clean({ scriptHosts: own })).reasons).toEqual([])
    expect(classify(clean({ scriptHosts: [{ host: 'evilexample.se', file: 'a.astro' }] })).reasons).toEqual(['unregistered script host evilexample.se in a.astro'])
  })

  test('one reason per host and file', () => {
    const hosts = [
      { host: 'a.example', file: 'x.astro' },
      { host: 'a.example', file: 'y.astro' },
    ]
    expect(classify(clean({ scriptHosts: hosts })).reasons).toEqual([
      'unregistered script host a.example in x.astro',
      'unregistered script host a.example in y.astro',
    ])
  })
})

describe("classify: Sentry's bundle (#93)", () => {
  const loader = {
    file: 'src/layouts/Base.astro',
    line: 9,
    cdn: 'jsdelivr' as const,
    version: '8',
    url: 'https://cdn.jsdelivr.net/npm/@sentry/browser@8/build/bundle.min.js',
    kind: 'element' as const,
    src: { start: 0, end: 1 },
    cuts: [],
    initBeforeBundle: false,
  }

  test('a load wire self-hosts does not change the classification', () => {
    expect(classify(clean({ sentry: { status: 'wire', loaders: [loader], selfHosted: [], reasons: [], hints: [] } }))).toEqual({ classification: 'notice', reasons: [] })
  })

  test('a load wire cannot rewrite sends the site to a human, with its reason', () => {
    const reason = 'src/layouts/Base.astro:3 names browser.sentry-cdn.com/8.55.0/bundle.min.js…, not as a <script src> or x.src = \'…\' the tool can rewrite'
    expect(classify(clean({ sentry: { status: 'needs-human', loaders: [], selfHosted: [], reasons: [reason], hints: [] } }))).toEqual({
      classification: 'needs-human',
      reasons: [`sentry bundle: ${reason}`],
    })
  })

  test('a report stored before Sentry detection classifies as before', () => {
    expect(classify(clean()).classification).toBe('notice')
  })
})
