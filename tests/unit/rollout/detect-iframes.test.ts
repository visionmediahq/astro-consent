import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { detectIframes, isInventedPb } from '../../../ci/rollout/detect/iframes'
import { diskSite, fixtureSite } from '../../../ci/rollout/lib/site-files'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const pilot = (site: string) => fixtureSite(join(FIXTURES, site, 'before'))
const fixtureText = (site: string, path: string) => readFileSync(join(FIXTURES, site, 'before', `${path}.txt`), 'utf8')

const dirs: string[] = []
function inline(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'detect-iframes-'))
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

/** The span of the first `<iframe …></iframe>` (or `<iframe … />`) at or after `from`. */
function iframeSpan(text: string, from = 0): { start: number; end: number } {
  const start = text.indexOf('<iframe', from)
  const close = text.indexOf('</iframe>', start)
  return { start, end: close + '</iframe>'.length }
}

const HEX_E2_PB =
  'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2196.5!2d18.0611!3d59.3311!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x000000e2e2e2e2e3%3A0x0!2sExempelgatan+1%2C+123+45+Exempelby!5e0!3m2!1ssv!2sse!4v1700000000000!5m2!1ssv!2sse'
const HEX_00_PB =
  'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2150.8471873476244!2d18.0622!3d59.3322!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0000000000000000%3A0x0000000000000000!2sExempelgatan%2C%20123%2045%20Exempelby!5e0!3m2!1ssv!2sse!4v1234567890123!5m2!1ssv!2sse'
const SAG_PB =
  'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2116.3748!2d18.0633!3d59.3333!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0000000000000000%3A0x0000000000000000!2sExempelv%C3%A4gen+2%2C+123+46+Exempelby!5e0!3m2!1ssv!2sse!4v1700000000000!5m2!1ssv!2sse'
const TRA_PB =
  'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2127.8!2d18.1!3d59.3!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2sExempel+Tr%C3%A4+AB!5e0!3m2!1ssv!2sse!4v1700000000000!5m2!1ssv!2sse'
/** Random hex place id, non-round timestamp. */
const REAL_PB =
  'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2131.9!2d11.97!3d57.70!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x464ff36d9c1d2a8b%3A0x7a3f0e61b2c94d15!2sG%C3%B6teborg!5e0!3m2!1ssv!2sse!4v1712345678901!5m2!1ssv!2sse'

describe('isInventedPb', () => {
  test.each([
    ['repeating hex e2e2e2e2 and 4v1700000000000', HEX_E2_PB, true],
    ['repeating hex 00000000 and 4v1234567890123', HEX_00_PB, true],
    ['round timestamp only', SAG_PB, true],
    ['0x0:0x0 and round timestamp', TRA_PB, true],
    ['a real-looking place id with a non-round timestamp', REAL_PB, false],
    ['a repeating place id with an unencoded colon', REAL_PB.replace('0x464ff36d9c1d2a8b%3A', '0x46abababab12cd34:'), true],
    ['a q= map (no pb=)', 'https://maps.google.com/maps?q=57.69,13.04&hl=sv&z=15&output=embed', false],
    ['not a URL', 'Karta', false],
  ])('%s', (_name, url, expected) => {
    expect(isInventedPb(url)).toBe(expected)
  })
})

describe('detectIframes: pilot fixtures', () => {
  test('a literal Google Maps src', () => {
    const r = detectIframes(pilot('site-1245311266'), ['site-1245311266.se'])
    const file = 'src/components/ContactSection.astro'
    const text = fixtureText('site-1245311266', file)
    expect(r.iframes).toEqual([
      {
        file,
        ...iframeSpan(text),
        srcKind: 'literal',
        src: 'https://maps.google.com/maps?q=59.329300,18.068600&hl=sv&z=15&output=embed',
        host: 'maps.google.com',
        service: 'google-maps',
        title: 'Karta till Exempel Katthotell i Exempelby',
        classes: null,
        height: '100%',
        style: 'border:0;',
      },
    ])
    expect(r.inventedMaps).toEqual([])
    expect(r.parseErrors).toEqual([])
  })

  test('src={kontakt.googleMapsEmbedUrl} from a JSON data file', () => {
    const r = detectIframes(pilot('site-1218869363'), ['site-1218869363.se'])
    const file = 'src/components/ContactMap.astro'
    expect(r.iframes).toEqual([
      {
        file,
        ...iframeSpan(fixtureText('site-1218869363', file)),
        srcKind: 'data-file',
        src: HEX_00_PB,
        dataPath: 'src/data/kontakt.json',
        host: 'www.google.com',
        service: 'google-maps',
        title: 'Karta till Exempel Café',
        classes: null,
        height: '100%',
        style: 'border:0;',
      },
    ])
    expect(r.inventedMaps).toEqual([HEX_00_PB])
  })

  test('two maps chosen by a component prop; one iframe, resolved per call site', () => {
    const r = detectIframes(pilot('site-1243335919'), ['site-1243335919.se'])
    const file = 'src/components/ContactFormSection.astro'
    expect(r.iframes).toHaveLength(1)
    const [f] = r.iframes
    expect(f).toMatchObject({
      file,
      ...iframeSpan(fixtureText('site-1243335919', file)),
      srcKind: 'expression',
      src: null,
      host: 'www.google.com',
      service: 'google-maps',
      height: '320',
    })
    expect(f!.title).toBe("{isSag ? 'Karta till Exempel Såg AB' : 'Karta till Exempel Trä AB'}")
    expect(f!.callSites).toEqual([
      { file: 'src/pages/kontakt-sag.astro', src: SAG_PB },
      { file: 'src/pages/kontakt.astro', src: TRA_PB },
    ])
    expect(r.inventedMaps).toEqual([SAG_PB, TRA_PB])
  })

  test('Google Calendar iframes in a .map() loop: unresolved, host listed, no service', () => {
    const r = detectIframes(pilot('site-1277834673'), ['site-1277834673.se'])
    const file = 'src/pages/kalendrar.astro'
    expect(r.iframes).toEqual([
      {
        file,
        ...iframeSpan(fixtureText('site-1277834673', file)),
        srcKind: 'unresolved',
        src: null,
        host: 'calendar.google.com',
        service: 'google-calendar',
        title: '{cal.title}',
        classes: null,
        height: '700',
        style: null,
      },
    ])
    expect(r.inventedMaps).toEqual([])
  })

  test('the home-made gate iframe has no src; still found, its map URL is the frontmatter const', () => {
    const r = detectIframes(pilot('site-1271984151'), ['site-1271984151.se'])
    const file = 'src/components/KontaktMap.astro'
    const text = fixtureText('site-1271984151', file)
    expect(r.iframes).toEqual([
      {
        file,
        ...iframeSpan(text, text.indexOf('<iframe\n')),
        srcKind: 'unresolved',
        src: null,
        host: 'www.google.com',
        service: 'google-maps',
        title: 'Karta – Exempel Tak AB, Exempelby',
        classes: null,
        height: '420',
        style: 'border:0; display:none; position:absolute; inset:0;',
      },
    ])
    expect(r.inventedMaps).toEqual([HEX_E2_PB])
  })

  test('a literal q= map', () => {
    const r = detectIframes(pilot('site-1243511314'), ['site-1243511314.se'])
    expect(r.iframes.map((f) => [f.file, f.srcKind, f.host, f.service])).toEqual([
      ['src/components/Contact.astro', 'literal', 'www.google.com', 'google-maps'],
    ])
    expect(r.inventedMaps).toEqual([])
  })

  test('no iframes', () => {
    const r = detectIframes(pilot('site-1286040212'), ['site-1286040212.se'])
    expect(r).toEqual({ iframes: [], inventedMaps: [], parseErrors: [] })
  })
})

const MAP = 'https://www.google.com/maps/embed?pb=!1m18!1s0x464ff36d9c1d2a8b%3A0x7a3f0e61b2c94d15!4v1712345678901'

describe('detectIframes: synthetic cases', () => {
  test('a commented-out iframe is not found', () => {
    const r = detectIframes(inline({ 'src/pages/index.astro': `<main><!-- <iframe src="${MAP}" title="x"></iframe> --></main>\n` }), [])
    expect(r.iframes).toEqual([])
  })

  test('an iframe inside a <script> string is not found', () => {
    const r = detectIframes(
      inline({ 'src/pages/index.astro': `<main></main>\n<script>const s = '<iframe src="${MAP}"></iframe>'</script>\n` }),
      [],
    )
    expect(r.iframes).toEqual([])
  })

  test('an iframe inside <template> or a conditional is found', () => {
    const r = detectIframes(
      inline({
        'src/pages/index.astro': `---\nconst show = true\n---\n<template><iframe src="${MAP}" title="a"></iframe></template>\n{show && <iframe src="${MAP}" title="b"></iframe>}\n`,
      }),
      [],
    )
    expect(r.iframes.map((f) => [f.title, f.srcKind, f.service])).toEqual([
      ['a', 'literal', 'google-maps'],
      ['b', 'literal', 'google-maps'],
    ])
  })

  test('&amp; in a quoted src is kept as written', () => {
    const src = 'https://www.google.com/maps/embed?pb=1&amp;x=2'
    const r = detectIframes(inline({ 'src/pages/index.astro': `<iframe src="${src}" title="t"></iframe>\n` }), [])
    expect(r.iframes[0]).toMatchObject({ srcKind: 'literal', src, service: 'google-maps', host: 'www.google.com' })
  })

  test('a template literal whose substitutions all resolve is the whole src', () => {
    const r = detectIframes(
      inline({
        'src/pages/index.astro': "---\nconst q = 'Göteborg'\n---\n<iframe src={`https://www.google.com/maps?q=${q}&output=embed`} title=\"t\"></iframe>\n",
      }),
      [],
    )
    expect(r.iframes[0]).toMatchObject({ srcKind: 'expression', src: 'https://www.google.com/maps?q=Göteborg&output=embed', host: 'www.google.com', service: 'google-maps' })
  })

  // site 1217042929, site 1276746449; site 1236328899, site 1293477034, site 1262822896, site 1286022055 through a const.
  test.each([
    ['inline', "---\nconst { address } = Astro.props\n---\n<iframe src={`https://maps.google.com/maps?q=${encodeURIComponent(address)}&z=15&output=embed`} title=\"t\"></iframe>\n"],
    ['through a top-level const', "---\nconst { street } = Astro.props\nconst mapSrc = `https://www.google.com/maps?q=${encodeURIComponent(street)}&output=embed`\n---\n<iframe src={mapSrc} title=\"t\"></iframe>\n"],
  ])('a template literal with a literal host and path is resolved by host, src unknown (%s)', (_name, text) => {
    const r = detectIframes(inline({ 'src/components/Map.astro': text }), ['x.se'])
    expect(r.iframes[0]).toMatchObject({ srcKind: 'expression', src: null, service: 'google-maps' })
    expect(r.iframes[0]!.host).toMatch(/^(maps|www)\.google\.com$/)
  })

  test('a template literal without substitutions and a const identifier resolve as expressions', () => {
    const r = detectIframes(
      inline({
        'src/pages/index.astro': `---\nconst MAP = '${MAP}'\n---\n<iframe src={MAP} title="a"></iframe>\n<iframe src={\`${MAP}\`} title="b"></iframe>\n`,
      }),
      [],
    )
    expect(r.iframes.map((f) => [f.srcKind, f.src, f.service])).toEqual([
      ['expression', MAP, 'google-maps'],
      ['expression', MAP, 'google-maps'],
    ])
  })

  test('a callback parameter shadowing a top-level const is not resolved to the const', () => {
    const r = detectIframes(
      inline({
        'src/pages/index.astro': `---\nconst url = '${MAP}'\nconst urls = ['https://example.org/a']\n---\n{urls.map((url) => <iframe src={url} title="t"></iframe>)}\n`,
      }),
      [],
    )
    expect(r.iframes[0]).toMatchObject({ srcKind: 'unresolved', src: null })
  })

  test('a named import from a TS data module resolves as data-file', () => {
    const r = detectIframes(
      inline({
        'src/data/site.ts': `export const mapUrl = '${MAP}'\n`,
        'src/pages/index.astro': `---\nimport { mapUrl } from '../data/site'\n---\n<iframe src={mapUrl} title="t"></iframe>\n`,
      }),
      [],
    )
    expect(r.iframes[0]).toMatchObject({ srcKind: 'data-file', src: MAP, dataPath: 'src/data/site.ts', service: 'google-maps' })
  })

  test('an aliased import is not followed: unresolved', () => {
    const r = detectIframes(
      inline({ 'src/pages/index.astro': `---\nimport data from '@/data/site.json'\n---\n<iframe src={data.map} title="t"></iframe>\n` }),
      [],
    )
    expect(r.iframes[0]).toMatchObject({ srcKind: 'unresolved', src: null })
  })

  test('src={prop}: literal at every call site → one iframe with callSites', () => {
    const r = detectIframes(
      inline({
        'src/components/Map.astro': `---\nconst { src, title = 'Karta' } = Astro.props\n---\n<iframe src={src} title={title}></iframe>\n`,
        'src/pages/a.astro': `---\nimport Map from '../components/Map.astro'\n---\n<Map src="${MAP}" />\n`,
        'src/pages/b.astro': `---\nimport Karta from '../components/Map.astro'\nconst U = '${MAP}'\n---\n<Karta src={U} />\n`,
      }),
      [],
    )
    expect(r.iframes).toHaveLength(1)
    expect(r.iframes[0]).toMatchObject({
      file: 'src/components/Map.astro',
      srcKind: 'expression',
      src: null,
      host: 'www.google.com',
      service: 'google-maps',
      callSites: [
        { file: 'src/pages/a.astro', src: MAP },
        { file: 'src/pages/b.astro', src: MAP },
      ],
    })
  })

  test('src={prop}: one call site not a literal → unresolved', () => {
    const r = detectIframes(
      inline({
        'src/components/Map.astro': `---\nconst { src } = Astro.props\n---\n<iframe src={src} title="t"></iframe>\n`,
        'src/pages/a.astro': `---\nimport Map from '../components/Map.astro'\n---\n<Map src="${MAP}" />\n`,
        'src/pages/b.astro': `---\nimport Map from '../components/Map.astro'\nlet u = '${MAP}'\n---\n<Map src={u} />\n`,
      }),
      [],
    )
    expect(r.iframes[0]).toMatchObject({
      srcKind: 'unresolved',
      src: null,
      callSites: [
        { file: 'src/pages/a.astro', src: MAP },
        { file: 'src/pages/b.astro', src: null },
      ],
    })
  })

  test('src={prop}: a call site inside a .map() callback whose parameter shadows a const → unresolved', () => {
    const r = detectIframes(
      inline({
        'src/components/Map.astro': `---\nconst { src } = Astro.props\n---\n<iframe src={src} title="t"></iframe>\n`,
        'src/pages/a.astro': `---\nimport Map from '../components/Map.astro'\nconst U = '${MAP}'\nconst list = ['https://example.org/x']\n---\n{list.map((U) => <Map src={U} />)}\n`,
      }),
      [],
    )
    expect(r.iframes[0]).toMatchObject({ srcKind: 'unresolved', callSites: [{ file: 'src/pages/a.astro', src: null }] })
  })

  test('src={prop} of a component nobody renders → unresolved with no call sites', () => {
    const r = detectIframes(
      inline({ 'src/components/Map.astro': `---\nconst { src } = Astro.props\n---\n<iframe src={src} title="t"></iframe>\n` }),
      [],
    )
    expect(r.iframes[0]).toMatchObject({ srcKind: 'unresolved', src: null, callSites: [] })
  })

  test('own domain: a relative src or the own host is the site own, never a registry service', () => {
    const r = detectIframes(
      inline({
        'src/pages/index.astro':
          '<iframe src="/kalender.html" title="a"></iframe>\n<iframe src="https://www.site-1277834673.se/kalender" title="b"></iframe>\n<iframe src="https://site-1277834673.se/k" title="c"></iframe>\n',
      }),
      ['site-1277834673.se'],
    )
    expect(r.iframes.map((f) => [f.title, f.srcKind, f.host, f.service])).toEqual([
      ['a', 'literal', 'site-1277834673.se', null],
      ['b', 'literal', 'www.site-1277834673.se', null],
      ['c', 'literal', 'site-1277834673.se', null],
    ])
  })

  test('a third-party host outside the registry is listed with service null', () => {
    const r = detectIframes(inline({ 'src/pages/index.astro': '<iframe src="https://player.vimeo.com/video/1" title="v"></iframe>\n' }), [])
    expect(r.iframes[0]).toMatchObject({ host: 'player.vimeo.com', service: null })
  })

  test('a file that does not parse is skipped and reported', () => {
    const r = detectIframes(
      inline({
        'src/pages/bad.astro': '<div>\n{\n',
        'src/pages/good.astro': `<iframe src="${MAP}" title="t"></iframe>\n`,
      }),
      [],
    )
    expect(r.iframes.map((f) => f.file)).toEqual(['src/pages/good.astro'])
    expect(r.parseErrors.map((e) => e.file)).toEqual(['src/pages/bad.astro'])
  })
})

describe('detectIframes: fails closed (review round 1)', () => {
  test('about:blank with a lazy data-src map → unresolved, the data-src is the hint', () => {
    const r = detectIframes(
      inline({ 'src/pages/index.astro': `<iframe src="about:blank" data-src="${MAP}" title="t"></iframe>\n` }),
      [],
    )
    expect(r.iframes[0]).toMatchObject({ srcKind: 'unresolved', src: null, host: 'www.google.com', service: 'google-maps' })
  })

  test('data-lazy-src with no src → unresolved, hint from data-lazy-src', () => {
    const r = detectIframes(inline({ 'src/pages/index.astro': `<iframe data-lazy-src="${MAP}" title="t"></iframe>\n` }), ['x.se'])
    expect(r.iframes[0]).toMatchObject({ srcKind: 'unresolved', host: 'www.google.com', service: 'google-maps' })
  })

  test('srcdoc overrides src → unresolved even when src is the own site', () => {
    const r = detectIframes(
      inline({
        'src/pages/index.astro': `<iframe src="/x" srcdoc="<iframe src='https://maps.google.com/maps?q=1&output=embed'></iframe>" title="t"></iframe>\n`,
      }),
      ['x.se'],
    )
    expect(r.iframes[0]).toMatchObject({ srcKind: 'unresolved', src: null, host: 'maps.google.com', service: 'google-maps' })
  })

  test.each(['javascript:void(0)', 'data:text/html,<p>x</p>', 'about:blank', ''])('a literal src %j is unresolved', (src) => {
    const r = detectIframes(inline({ 'src/pages/index.astro': `<iframe src="${src}" title="t"></iframe>\n` }), ['x.se'])
    expect(r.iframes[0]).toMatchObject({ srcKind: 'unresolved', src: null, host: null, service: null })
  })

  test('a non-http src from a const is unresolved too', () => {
    const r = detectIframes(
      inline({ 'src/pages/index.astro': "---\nconst U = 'about:blank'\n---\n<iframe src={U} title=\"t\"></iframe>\n" }),
      [],
    )
    expect(r.iframes[0]).toMatchObject({ srcKind: 'unresolved', src: null })
  })

  test('a prop-driven template literal src keeps its call sites, so verify knows the pages', () => {
    const r = detectIframes(
      inline({
        'src/components/Map.astro': "---\nconst { address } = Astro.props\n---\n<iframe src={`https://maps.google.com/maps?q=${encodeURIComponent(address)}&output=embed`} title=\"t\"></iframe>\n",
        'src/pages/kontakt.astro': "---\nimport Map from '../components/Map.astro'\n---\n<Map address=\"Storgatan 1\" />\n",
      }),
      ['x.se'],
    )
    expect(r.iframes[0]).toMatchObject({ srcKind: 'expression', src: null, service: 'google-maps', callSites: [{ file: 'src/pages/kontakt.astro', src: null }] })
  })

  test("a made-up pb= in a template literal's literal start is still reported", () => {
    const head = HEX_E2_PB.slice(0, HEX_E2_PB.indexOf('!5m2'))
    const r = detectIframes(
      inline({ 'src/components/Map.astro': `---\nconst { lang } = Astro.props\n---\n<iframe src={\`${head}!5m2!1s\${lang}\`} title="t"></iframe>\n` }),
      ['x.se'],
    )
    expect(r.iframes[0]).toMatchObject({ srcKind: 'expression', service: 'google-maps' })
    expect(r.inventedMaps).toEqual([`${head}!5m2!1s`])
  })

  test('a template literal built from a data file names the data file', () => {
    const r = detectIframes(
      inline({
        'src/data/site.json': '{ "address": "Storgatan 1" }',
        'src/pages/index.astro': "---\nimport site from '../data/site.json'\n---\n<iframe src={`https://www.google.com/maps?q=${site.address}&output=embed`} title=\"t\"></iframe>\n",
      }),
      ['x.se'],
    )
    expect(r.iframes[0]).toMatchObject({ srcKind: 'data-file', dataPath: 'src/data/site.json', src: 'https://www.google.com/maps?q=Storgatan 1&output=embed' })
  })

  test.each([
    ['the host is a substitution', 'https://${host}/maps?q=${q}'],
    ['the host can be extended', 'https://www.google.com${path}'],
    ['the path is not finished', 'https://www.google.com/${kind}?q=${q}'],
    ['the path is not finished before the first substitution', 'https://www.google.com/maps${rest}'],
    ['no scheme', 'www.google.com/maps?q=${q}'],
  ])('a template literal src stays unresolved when %s', (_name, template) => {
    const r = detectIframes(
      inline({ 'src/components/Map.astro': `---\nconst { host, q, path, kind, rest } = Astro.props\n---\n<iframe src={\`${template}\`} title="t"></iframe>\n` }),
      ['x.se'],
    )
    expect(r.iframes[0]).toMatchObject({ srcKind: 'unresolved', src: null })
  })

  test('a template literal is never truthy evidence: `a || \`…${x}\`` with an unknown a stays unresolved', () => {
    const r = detectIframes(
      inline({ 'src/components/Map.astro': "---\nconst { url, q } = Astro.props\n---\n<iframe src={url || `https://www.google.com/maps?q=${q}&output=embed`} title=\"t\"></iframe>\n" }),
      ['x.se'],
    )
    expect(r.iframes[0]).toMatchObject({ srcKind: 'unresolved', src: null })
  })

  test('an unresolved iframe never gets an own-domain host from candidates', () => {
    const r = detectIframes(
      inline({ 'src/pages/index.astro': "---\nconst home = 'https://www.x.se/'\n---\n<iframe title=\"t\"></iframe>\n" }),
      ['x.se'],
    )
    expect(r.iframes[0]).toMatchObject({ srcKind: 'unresolved', host: null, service: null })
  })

  test('iframes outside .astro (md, tsx, public html) are found by a text sweep, unresolved', () => {
    const md = `# Hitta hit\n\n<IFRAME src="${MAP}" title="k"></IFRAME>\n`
    const tsx = 'export const V = () => <iframe src={url} />\n'
    const html = '<html><body><iframe src="https://player.vimeo.com/video/1"></iframe></body></html>\n'
    const r = detectIframes(
      inline({
        'src/content/hitta.md': md,
        'src/components/Video.tsx': tsx,
        'public/x.html': html,
        'public/logo.png': '\u0000PNG<iframe',
        'node_modules/pkg/a.html': '<iframe src="https://example.org"></iframe>',
      }),
      [],
    )
    const tag = (text: string) => ({ start: text.toLowerCase().indexOf('<iframe'), end: text.indexOf('>', text.toLowerCase().indexOf('<iframe')) + 1 })
    expect(r.iframes).toEqual([
      { file: 'public/x.html', ...tag(html), srcKind: 'unresolved', src: null, host: 'player.vimeo.com', service: null, title: null, classes: null, height: null, style: null },
      { file: 'src/components/Video.tsx', ...tag(tsx), srcKind: 'unresolved', src: null, host: null, service: null, title: null, classes: null, height: null, style: null },
      { file: 'src/content/hitta.md', ...tag(md), srcKind: 'unresolved', src: null, host: 'www.google.com', service: 'google-maps', title: null, classes: null, height: null, style: null },
    ])
  })
})
