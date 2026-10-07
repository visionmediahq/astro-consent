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

const ATAK_PB =
  'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2196.5!2d12.2558!3d57.1058!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x465169e2e2e2e2e3%3A0x0!2sAnnebergsv%C3%A4gen+12%2C+432+48+Varberg!5e0!3m2!1ssv!2sse!4v1700000000000!5m2!1ssv!2sse'
const ASPOMAD_PB =
  'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2150.8471873476244!2d15.587845!3d56.167886!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x4657d0b4c8c8c8c8%3A0x4c8c8c8c8c8c8c8c!2sMadviksv%C3%A4gen%2C%20373%2064%20Drottningsk%C3%A4r!5e0!3m2!1ssv!2sse!4v1234567890123!5m2!1ssv!2sse'
const LEVENE_PB =
  'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2116.3748!2d12.8920!3d58.3268!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x464c19c12a7fc1f1%3A0x1b1c4e5b6a7d8e9f!2sLevene+Furubacken+1%2C+534+93+Stora+Levene!5e0!3m2!1ssv!2sse!4v1700000000000!5m2!1ssv!2sse'
const SKARABORG_PB =
  'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2127.8!2d14.1!3d58.7!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2sSkaraborgs+Tr%C3%A4f%C3%B6r%C3%A4dling+AB!5e0!3m2!1ssv!2sse!4v1700000000000!5m2!1ssv!2sse'
/** Random hex place id, non-round timestamp. */
const REAL_PB =
  'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2131.9!2d11.97!3d57.70!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x464ff36d9c1d2a8b%3A0x7a3f0e61b2c94d15!2sG%C3%B6teborg!5e0!3m2!1ssv!2sse!4v1712345678901!5m2!1ssv!2sse'

describe('isInventedPb', () => {
  test.each([
    ['a-tak: repeating hex e2e2e2e2 and 4v1700000000000', ATAK_PB, true],
    ['aspomad: repeating hex c8c8c8c8 and 4v1234567890123', ASPOMAD_PB, true],
    ['traforadling Levene: round timestamp only', LEVENE_PB, true],
    ['traforadling Skaraborg: 0x0:0x0 and round timestamp', SKARABORG_PB, true],
    ['a real-looking place id with a non-round timestamp', REAL_PB, false],
    ['a repeating place id with an unencoded colon', REAL_PB.replace('0x464ff36d9c1d2a8b%3A', '0x46abababab12cd34:'), true],
    ['a q= map (no pb=)', 'https://maps.google.com/maps?q=57.69,13.04&hl=sv&z=15&output=embed', false],
    ['not a URL', 'Karta', false],
  ])('%s', (_name, url, expected) => {
    expect(isInventedPb(url)).toBe(expected)
  })
})

describe('detectIframes: pilot fixtures', () => {
  test('vasshalla: literal Google Maps src', () => {
    const r = detectIframes(pilot('vasshallakatthotell'), ['vasshallakatthotell.se'])
    const file = 'src/components/ContactSection.astro'
    const text = fixtureText('vasshallakatthotell', file)
    expect(r.iframes).toEqual([
      {
        file,
        ...iframeSpan(text),
        srcKind: 'literal',
        src: 'https://maps.google.com/maps?q=57.698734,13.042359&hl=sv&z=15&output=embed',
        host: 'maps.google.com',
        service: 'google-maps',
        title: 'Karta till Vasshalla Katthotell i Gånghester',
        classes: null,
        height: '100%',
        style: 'border:0;',
      },
    ])
    expect(r.inventedMaps).toEqual([])
    expect(r.parseErrors).toEqual([])
  })

  test('aspomad: src={kontakt.googleMapsEmbedUrl} from a JSON data file', () => {
    const r = detectIframes(pilot('aspomad'), ['aspomad.se'])
    const file = 'src/components/ContactMap.astro'
    expect(r.iframes).toEqual([
      {
        file,
        ...iframeSpan(fixtureText('aspomad', file)),
        srcKind: 'data-file',
        src: ASPOMAD_PB,
        dataPath: 'src/data/kontakt.json',
        host: 'www.google.com',
        service: 'google-maps',
        title: 'Karta till Aspö Mad Vin & Café',
        classes: null,
        height: '100%',
        style: 'border:0;',
      },
    ])
    expect(r.inventedMaps).toEqual([ASPOMAD_PB])
  })

  test('traforadling: two maps chosen by a component prop; one iframe, resolved per call site', () => {
    const r = detectIframes(pilot('traforadling'), ['traforadling.se'])
    const file = 'src/components/ContactFormSection.astro'
    expect(r.iframes).toHaveLength(1)
    const [f] = r.iframes
    expect(f).toMatchObject({
      file,
      ...iframeSpan(fixtureText('traforadling', file)),
      srcKind: 'expression',
      src: null,
      host: 'www.google.com',
      service: 'google-maps',
      height: '320',
    })
    expect(f!.title).toBe("{isLevene ? 'Karta till Levene Såg AB' : 'Karta till Skaraborgs Träförädling AB'}")
    expect(f!.callSites).toEqual([
      { file: 'src/pages/kontakt-levene.astro', src: LEVENE_PB },
      { file: 'src/pages/kontakt.astro', src: SKARABORG_PB },
    ])
    expect(r.inventedMaps).toEqual([LEVENE_PB, SKARABORG_PB])
  })

  test('nhrk: Google Calendar iframes in a .map() loop: unresolved, host listed, no service', () => {
    const r = detectIframes(pilot('nhrk'), ['nhrk.se'])
    const file = 'src/pages/kalendrar.astro'
    expect(r.iframes).toEqual([
      {
        file,
        ...iframeSpan(fixtureText('nhrk', file)),
        srcKind: 'unresolved',
        src: null,
        host: 'calendar.google.com',
        service: null,
        title: '{cal.title}',
        classes: null,
        height: '700',
        style: null,
      },
    ])
    expect(r.inventedMaps).toEqual([])
  })

  test('a-tak: the home-made gate iframe has no src; still found, its map URL is the frontmatter const', () => {
    const r = detectIframes(pilot('a-tak'), ['a-tak.se'])
    const file = 'src/components/KontaktMap.astro'
    const text = fixtureText('a-tak', file)
    expect(r.iframes).toEqual([
      {
        file,
        ...iframeSpan(text, text.indexOf('<iframe\n')),
        srcKind: 'unresolved',
        src: null,
        host: 'www.google.com',
        service: 'google-maps',
        title: 'Karta – Annebergsvägens Tak AB, Varberg',
        classes: null,
        height: '420',
        style: 'border:0; display:none; position:absolute; inset:0;',
      },
    ])
    expect(r.inventedMaps).toEqual([ATAK_PB])
  })

  test('domeij: a literal q= map', () => {
    const r = detectIframes(pilot('domeijstapetserarverkstad'), ['domeijstapetserarverkstad.se'])
    expect(r.iframes.map((f) => [f.file, f.srcKind, f.host, f.service])).toEqual([
      ['src/components/Contact.astro', 'literal', 'www.google.com', 'google-maps'],
    ])
    expect(r.inventedMaps).toEqual([])
  })

  test('munkfors: no iframes', () => {
    const r = detectIframes(pilot('munkforstradgardstjanst'), ['munkforstradgardstjanst.se'])
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

  test('an interpolated template literal src is unresolved', () => {
    const r = detectIframes(
      inline({
        'src/pages/index.astro': "---\nconst q = 'Göteborg'\n---\n<iframe src={`https://www.google.com/maps?q=${q}&output=embed`} title=\"t\"></iframe>\n",
      }),
      [],
    )
    expect(r.iframes[0]).toMatchObject({ srcKind: 'unresolved', src: null })
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
          '<iframe src="/kalender.html" title="a"></iframe>\n<iframe src="https://www.nhrk.se/kalender" title="b"></iframe>\n<iframe src="https://nhrk.se/k" title="c"></iframe>\n',
      }),
      ['nhrk.se'],
    )
    expect(r.iframes.map((f) => [f.title, f.srcKind, f.host, f.service])).toEqual([
      ['a', 'literal', 'nhrk.se', null],
      ['b', 'literal', 'www.nhrk.se', null],
      ['c', 'literal', 'nhrk.se', null],
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
