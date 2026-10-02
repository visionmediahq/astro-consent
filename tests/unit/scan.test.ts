import { expect, test } from 'vitest'
import { findEmbedServices, isInDir, scanError } from '../../src/scan'

test('findEmbedServices returns every literal service attribute', () => {
  const source = `<ConsentEmbed service="google-maps" src={x} />\n<ConsentEmbed title="k" service='meta-pixel'>`
  expect(findEmbedServices(source)).toEqual(['google-maps', 'meta-pixel'])
})

test('findEmbedServices handles multi-line tags', () => {
  const source = `<ConsentEmbed\n  id="a"\n  service="google-ads"\n  src="https://x.test"\n/>`
  expect(findEmbedServices(source)).toEqual(['google-ads'])
})

test('findEmbedServices ignores non-literal service props', () => {
  expect(findEmbedServices('<ConsentEmbed service={slug} src="x" />')).toEqual([])
  expect(findEmbedServices(`<ConsentEmbed service={'google-maps'} src="x" />`)).toEqual([])
})

test('findEmbedServices ignores other components and plain text', () => {
  expect(findEmbedServices('<Embed service="x" /> <p>service="y"</p> <ConsentEmbedder service="z" />')).toEqual([])
})

test('scanError names the file, the service and privacy.json', () => {
  const message = scanError('src/pages/kontakt.astro', 'elfsight', ['google-maps'])
  expect(message).toMatch(/src\/pages\/kontakt\.astro/)
  expect(message).toMatch(/elfsight/)
  expect(message).toMatch(/privacy\.json/)
  expect(message).toMatch(/google-maps/)
  expect(scanError('a.astro', 'x', [])).toMatch(/services: none/)
})

const PKG_IMPORT = "import Karta from '@visionmediahq/astro-consent/components/ConsentEmbed.astro'"

test('findEmbedServices follows an embed imported under another name', () => {
  const source = `---\n${PKG_IMPORT}\n---\n<Karta service="meta-pixel" src="https://x.test" title="x" />`
  expect(findEmbedServices(source)).toEqual(['meta-pixel'])
})

test('findEmbedServices follows an aliased relative import and still finds the default name', () => {
  const source = [
    '---',
    'import Map from "../../node_modules/@visionmediahq/astro-consent/src/components/ConsentEmbed.astro"',
    '---',
    '<Map service="google-ads" src="a" title="a" />',
    '<ConsentEmbed service="google-maps" src="b" title="b" />',
  ].join('\n')
  expect(findEmbedServices(source)).toEqual(['google-ads', 'google-maps'])
})

test('findEmbedServices does not treat an unrelated component with the alias-like name as an embed', () => {
  const source = `---\nimport Map from '../components/Map.astro'\n---\n<Map service="x" />`
  expect(findEmbedServices(source)).toEqual([])
})

test('findEmbedServices is not fooled by a > inside an earlier attribute', () => {
  expect(findEmbedServices('<ConsentEmbed title="A > B" service="google-ads" src="x" />')).toEqual(['google-ads'])
  expect(findEmbedServices('<ConsentEmbed onLoad={() => go()} service="meta-pixel" src="x" />')).toEqual(['meta-pixel'])
  expect(findEmbedServices("<ConsentEmbed title={`a > ${b}`} service='google-maps' src=\"x\" />")).toEqual(['google-maps'])
})

test('findEmbedServices only reads the attribute named exactly service', () => {
  expect(findEmbedServices('<ConsentEmbed data-service="x" service={slug} src="y" />')).toEqual([])
  expect(findEmbedServices(`<ConsentEmbed title='service="y"' service="google-maps" src="z" />`)).toEqual(['google-maps'])
  expect(findEmbedServices('<ConsentEmbed data-service="x" src="y" />')).toEqual([])
})

// Vite passes module ids with forward slashes on every platform; the source directory comes from
// Node and uses backslashes on Windows.
test('isInDir matches a forward-slash id against a Windows directory path', () => {
  expect(isInDir('C:/sites/kund/src/pages/kontakt.astro', 'C:\\sites\\kund\\src\\')).toBe(true)
  expect(isInDir('C:/sites/kund/src/pages/kontakt.astro', 'C:\\sites\\kund\\src')).toBe(true)
  expect(isInDir('c:/sites/kund/src/pages/kontakt.astro', 'C:\\sites\\kund\\src\\')).toBe(true)
})

test('isInDir matches POSIX paths and rejects files outside the directory', () => {
  expect(isInDir('/sites/kund/src/pages/a.astro', '/sites/kund/src/')).toBe(true)
  expect(isInDir('/sites/kund/src/pages/a.astro', '/sites/kund/src')).toBe(true)
  expect(isInDir('/sites/kund/node_modules/pkg/src/a.astro', '/sites/kund/src/')).toBe(false)
  expect(isInDir('/sites/kund/src-old/a.astro', '/sites/kund/src')).toBe(false)
  expect(isInDir('C:/sites/annan/src/a.astro', 'C:\\sites\\kund\\src\\')).toBe(false)
})

test('findEmbedServices ignores embeds in HTML comments, frontmatter and script blocks', () => {
  const embed = '<ConsentEmbed service="google-maps" src="x" title="t" />'
  // A technician comments a map out and removes the service from privacy.json: must not fail the build.
  expect(findEmbedServices(`<!-- ${embed} -->`)).toEqual([])
  expect(findEmbedServices(`<!--\n  ${embed}\n-->\n<p>Ingen karta</p>`)).toEqual([])
  expect(findEmbedServices(`<div>{/* ${embed} */}</div>`)).toEqual([])
  expect(findEmbedServices(`---\n// usage: <ConsentEmbed service="youtube" />\n---\n<p>x</p>`)).toEqual([])
  expect(findEmbedServices(`---\nconst doc = '<ConsentEmbed service="youtube">'\n---\n<p>x</p>`)).toEqual([])
  expect(findEmbedServices(`<script>const t = '<ConsentEmbed service="bad" />'</script>`)).toEqual([])
  expect(findEmbedServices(`<style>/* <ConsentEmbed service="bad" /> */</style>`)).toEqual([])
  expect(findEmbedServices(`<Fragment set:html={'<ConsentEmbed service="bad" />'} />`)).toEqual([])
})

test('findEmbedServices still finds a live embed next to commented-out ones', () => {
  const source = [
    '---',
    "import Karta from '@visionmediahq/astro-consent/components/ConsentEmbed.astro'",
    "// old: <Karta service=\"meta-pixel\" />",
    '---',
    '<!-- <Karta service="google-ads" src="a" title="a" /> -->',
    '<Karta service="google-maps" src="b" title="b" />',
    '<script>console.log("<Karta service=\\"google-analytics\\" />")</script>',
    '<ConsentEmbed service="google-analytics" src="c" title="c"></ConsentEmbed>',
  ].join('\n')
  expect(findEmbedServices(source)).toEqual(['google-maps', 'google-analytics'])
})

test('findEmbedServices handles an empty frontmatter, CRLF line endings and no frontmatter', () => {
  expect(findEmbedServices('---\n---\n<ConsentEmbed service="google-maps" src="x" />')).toEqual(['google-maps'])
  expect(findEmbedServices('---\r\nconst a = 1\r\n---\r\n<ConsentEmbed\r\n  service="google-ads"\r\n  src="x" />')).toEqual(['google-ads'])
  expect(findEmbedServices('<ConsentEmbed service="meta-pixel" src="x" />')).toEqual(['meta-pixel'])
})

test('findEmbedServices terminates quickly on malformed input', () => {
  const broken = '<ConsentEmbed title={unterminated service="google-maps" '.repeat(20_000)
  const started = Date.now()
  expect(() => findEmbedServices(broken)).not.toThrow()
  expect(findEmbedServices('<ConsentEmbed service="google-maps')).toEqual([])
  expect(Date.now() - started).toBeLessThan(2_000)
})

test("findEmbedServices does not scan a site's own component whose file name merely ends in ConsentEmbed.astro", () => {
  const source = `---\nimport Map from '../components/MapConsentEmbed.astro'\n---\n<Map service="youtube" />`
  expect(findEmbedServices(source)).toEqual([])
})

test('findEmbedServices does not scan a ConsentEmbed imported from another file', () => {
  const source = `---\nimport ConsentEmbed from '../components/MapEmbed.astro'\n---\n<ConsentEmbed service="youtube" />`
  expect(findEmbedServices(source)).toEqual([])
})

test('findEmbedServices still scans ConsentEmbed.astro imported by any path, and the bare default name', () => {
  const tag = '<ConsentEmbed service="google-ads" src="x" />'
  expect(findEmbedServices(`---\nimport ConsentEmbed from './ConsentEmbed.astro'\n---\n${tag}`)).toEqual(['google-ads'])
  expect(findEmbedServices(`---\nimport ConsentEmbed from 'ConsentEmbed.astro'\n---\n${tag}`)).toEqual(['google-ads'])
  expect(
    findEmbedServices(`---\nimport ConsentEmbed from '@visionmediahq/astro-consent/components/ConsentEmbed.astro'\n---\n${tag}`),
  ).toEqual(['google-ads'])
  // Imported through a barrel file, or no import in sight: the default name is still checked.
  expect(findEmbedServices(`---\nimport { ConsentEmbed } from '../components'\n---\n${tag}`)).toEqual(['google-ads'])
  expect(findEmbedServices(tag)).toEqual(['google-ads'])
})

// Review 3: false build failures must be impossible for commented-out or quoted embeds.
test('findEmbedServices ignores an embed in a JS comment inside an expression', () => {
  const line = `{items.map((i) => (\n  // <ConsentEmbed service="google-maps" src="x" title="t" />\n  <p>{i}</p>\n))}`
  expect(findEmbedServices(line)).toEqual([])
  expect(findEmbedServices(`{x /* <ConsentEmbed service="c" /> */}`)).toEqual([])
  expect(findEmbedServices(`{cond && (\n  /* <ConsentEmbed service="c" /> */\n  <p>hej</p>\n)}`)).toEqual([])
})

test('findEmbedServices ignores embed text inside a string in an expression', () => {
  expect(findEmbedServices(`{"<ConsentEmbed service='x' />"}`)).toEqual([])
  expect(findEmbedServices("{`<ConsentEmbed service=\"x\" />`}")).toEqual([])
  expect(findEmbedServices(`<p>{'<ConsentEmbed service="x" />'}</p>`)).toEqual([])
})

test('findEmbedServices ignores a commented-out alias import', () => {
  const page = (comment: string) =>
    ['---', comment, "import Map from '../layouts/Base.astro'", '---', '<Map service="google-maps" />'].join('\n')
  expect(findEmbedServices(page("// import Map from '@visionmediahq/astro-consent/components/ConsentEmbed.astro'"))).toEqual([])
  expect(findEmbedServices(page("/* import Map from '../x/ConsentEmbed.astro' */"))).toEqual([])
})

test('findEmbedServices is not thrown off by a self-closing script before a later script block', () => {
  const source = [
    '<script type="application/ld+json" set:html={JSON.stringify(schema)} />',
    '<ConsentEmbed service="google-maps" src="x" title="t" />',
    '<script>console.log(1)</script>',
  ].join('\n')
  expect(findEmbedServices(source)).toEqual(['google-maps'])
})

test('findEmbedServices treats only lowercase script, style and textarea as raw text', () => {
  expect(findEmbedServices('<SCRIPT><ConsentEmbed service="google-ads" src="x" /></SCRIPT>')).toEqual(['google-ads'])
  expect(findEmbedServices('<textarea><ConsentEmbed service="bad" /></textarea>')).toEqual([])
  expect(findEmbedServices('<pre is:raw><ConsentEmbed service="bad" /></pre>')).toEqual([])
  expect(findEmbedServices('<scriptx><ConsentEmbed service="meta-pixel" src="x" /></scriptx>')).toEqual(['meta-pixel'])
})

test('findEmbedServices is not hidden by comment markers inside attribute values', () => {
  const source = '<p title="<!--">a</p><ConsentEmbed service="google-maps" src="x" /><p title="-->">b</p>'
  expect(findEmbedServices(source)).toEqual(['google-maps'])
})

test('findEmbedServices reads a file that starts with a byte-order mark', () => {
  const source = '\uFEFF---\nconst a = "<ConsentEmbed service=\'x\' />"\n---\n<ConsentEmbed service="google-maps" src="x" />'
  expect(findEmbedServices(source)).toEqual(['google-maps'])
})

test('findEmbedServices skips a file whose frontmatter it cannot locate', () => {
  const source = `<!-- generated -->\n---\nconst doc = '<ConsentEmbed service="x" />'\n---\n<p>ok</p>`
  expect(findEmbedServices(source)).toEqual([])
})

test('findEmbedServices still finds embeds rendered from expressions', () => {
  expect(findEmbedServices('{cond ? <ConsentEmbed service="google-maps" src="x" /> : null}')).toEqual(['google-maps'])
  expect(findEmbedServices('{items.map((i) => <ConsentEmbed service="google-ads" src={i} />)}')).toEqual(['google-ads'])
  expect(findEmbedServices('{a < b && <ConsentEmbed service="meta-pixel" src="x" />}')).toEqual(['meta-pixel'])
  expect(findEmbedServices(`<p>Don't worry</p>\n<ConsentEmbed service="google-maps" src="x" />`)).toEqual(['google-maps'])
})

test('findEmbedServices is linear on unterminated openers', () => {
  const megabyte = (opener: string) => opener.repeat(Math.ceil(1_000_000 / opener.length))
  for (const opener of ['<!-- ', '<script ', '<script>', '{/* ', '<style>', '<textarea>', '{ "', '<a ']) {
    const started = Date.now()
    expect(() => findEmbedServices(megabyte(opener)), opener).not.toThrow()
    expect(Date.now() - started, opener).toBeLessThan(1_000)
  }
}, 120_000)
