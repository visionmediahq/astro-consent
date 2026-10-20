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

  test('an agreed host is not listed: error reporting through Sentry\'s CDN', () => {
    expect(
      hostsOf({
        'src/layouts/Base.astro': page(
          '<script src="https://browser.sentry-cdn.com/8.0.0/bundle.min.js"></script><script src="https://cdn.jsdelivr.net/npm/@sentry/browser@8/build/bundle.min.js"></script>',
        ),
      }),
    ).toEqual([])
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
