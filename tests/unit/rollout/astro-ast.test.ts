import { describe, expect, test } from 'vitest'
import { attr, blankComments, components, elements, parseAstro } from '../../../ci/rollout/lib/astro-ast'

describe('parseAstro', () => {
  test('element offsets slice the element exactly', () => {
    const text = '---\nconst a=1\n---\n<footer class="x"><p/></footer>'
    const footer = elements(parseAstro(text).root, 'footer')[0]!
    expect(text.slice(footer.start, footer.end)).toBe('<footer class="x"><p/></footer>')
  })

  test('åäö before the footer: the slice is still exact', () => {
    const text = '---\nconst t = "Välkommen till Åre"\n---\n<p>Öppettider: måndag–fredag</p>\n<footer>x</footer>'
    const footer = elements(parseAstro(text).root, 'footer')[0]!
    expect(text.slice(footer.start, footer.end)).toBe('<footer>x</footer>')
  })

  test('frontmatter is the text between the fences', () => {
    const text = '---\nconst a=1\n---\n<p/>'
    const { frontmatter } = parseAstro(text)
    expect(frontmatter).toEqual({ text: '\nconst a=1\n', start: 3, end: 14 })
    expect(text.slice(frontmatter!.start, frontmatter!.end)).toBe(frontmatter!.text)
  })

  test('frontmatter after leading whitespace and CRLF', () => {
    const text = '\n---\r\nconst å = "ä"\r\n---\r\n<p/>'
    const { frontmatter } = parseAstro(text)
    expect(frontmatter!.text).toBe('\r\nconst å = "ä"\r\n')
    expect(text.slice(frontmatter!.start, frontmatter!.end)).toBe(frontmatter!.text)
  })

  test('no frontmatter → null', () => {
    expect(parseAstro('<p>hej</p>').frontmatter).toBeNull()
  })

  test('an HTML comment is not an element', () => {
    expect(elements(parseAstro('<!-- <iframe src="x"> -->').root, 'iframe')).toEqual([])
  })

  test('a script body is not markup', () => {
    expect(elements(parseAstro('<script>const s = "<iframe src=x>"</script>').root, 'iframe')).toEqual([])
  })

  test('textarea, style and is:raw content is not markup', () => {
    const text =
      '<textarea><iframe src="a"></iframe></textarea><div is:raw><iframe src="b"></iframe></div><style>a{}</style>'
    expect(elements(parseAstro(text).root, 'iframe')).toEqual([])
  })

  test('a JS comment inside an expression is not markup', () => {
    expect(elements(parseAstro('<p>{/* <iframe src="x"/> */}</p>').root, 'iframe')).toEqual([])
  })

  test('elements inside expressions are found, in document order', () => {
    const text = '<div>{cond && <iframe src="a"></iframe>}{items.map((i) => <iframe src={i.src}></iframe>)}</div>'
    const found = elements(parseAstro(text).root, 'iframe')
    expect(found.map((n) => attr(n, 'src'))).toEqual([
      { kind: 'quoted', value: 'a' },
      { kind: 'expression', value: 'i.src' },
    ])
  })

  test('expression attribute', () => {
    const iframe = elements(parseAstro('<iframe src={url} />').root, 'iframe')[0]!
    expect(attr(iframe, 'src')).toEqual({ kind: 'expression', value: 'url' })
  })

  test('quoted, unquoted, empty and missing attributes; &amp; kept as written', () => {
    const iframe = elements(
      parseAstro('<iframe title="Karta &amp; väg" loading=lazy allowfullscreen {...rest} />').root,
      'iframe',
    )[0]!
    expect(attr(iframe, 'title')).toEqual({ kind: 'quoted', value: 'Karta &amp; väg' })
    expect(attr(iframe, 'loading')).toEqual({ kind: 'quoted', value: 'lazy' })
    expect(attr(iframe, 'allowfullscreen')).toEqual({ kind: 'empty', value: '' })
    expect(attr(iframe, 'src')).toBeNull()
  })

  test('a template-literal attribute is an expression', () => {
    const iframe = elements(parseAstro('<iframe src=`https://x/${id}` />').root, 'iframe')[0]!
    expect(attr(iframe, 'src')).toEqual({ kind: 'expression', value: '`https://x/${id}`' })
  })

  test('component', () => {
    const { root } = parseAstro('<Foot />')
    expect(components(root, 'Foot')).toHaveLength(1)
    expect(elements(root, 'Foot')).toEqual([])
  })

  test('components nested in slots and member components', () => {
    const { root } = parseAstro('<Layout><main><Foot /></main><UI.Card /></Layout>')
    expect(components(root, 'Foot')).toHaveLength(1)
    expect(components(root, 'UI.Card')).toHaveLength(1)
    expect(elements(root, 'main')).toHaveLength(1)
  })

  test('a parse error throws with the compiler message', () => {
    expect(() => parseAstro('<div><iframe src="x"></div')).toThrow(/Expected/)
  })

  // compiler-rs rejects an HTML comment between `(` and the element in a `{…}` conditional; Astro's
  // own compiler builds it (anab, fonsterdekor, nnf).
  const CONDITIONAL = '{wide ? (\n  <!-- wide -->\n  <iframe src="https://maps.google.com/maps?q=a&output=embed" title="a"></iframe>\n) : (\n  <!-- narrow -->\n  <p>x</p>\n)}\n'

  test('an HTML comment inside a {…} conditional parses, offsets kept', () => {
    const text = `---\nconst wide = true\n---\n<section>${CONDITIONAL}</section>\n`
    const { root, frontmatter } = parseAstro(text)
    const [iframe] = elements(root, 'iframe')
    expect(iframe && text.slice(iframe.start, iframe.end)).toBe('<iframe src="https://maps.google.com/maps?q=a&output=embed" title="a"></iframe>')
    expect(frontmatter?.text).toBe('\nconst wide = true\n')
  })

  test('the retry blanks markup comments only: frontmatter, script and style keep theirs', () => {
    const script = "<script>\n  const a = '<!--'\n  load('https://www.googletagmanager.com/gtag/js')\n  const b = '-->'\n</script>\n"
    const front = "---\nconst c = '<!-- x -->'\n---\n"
    const style = '<style>/* <!-- */ .a { color: red } /* --> */</style>\n'
    const text = front + CONDITIONAL + script + style
    const blanked = blankComments(text)
    expect(blanked).toHaveLength(text.length)
    expect(blanked.startsWith(front)).toBe(true)
    expect(blanked.endsWith(script + style)).toBe(true)
    expect(blanked).not.toContain('<!-- wide -->')
    expect(elements(parseAstro(text).root, 'script')).toHaveLength(1)
  })

  test('an escaped quote inside an attribute still throws (byggk, bringekonomi)', () => {
    expect(() => parseAstro('<div style="background: url(\\"data:image/svg+xml,%3Csvg xmlns=\\"http://www.w3.org/2000/svg\\"%3E%3C/svg%3E\\")"></div>\n')).toThrow(/Astro parse error/)
  })
})
