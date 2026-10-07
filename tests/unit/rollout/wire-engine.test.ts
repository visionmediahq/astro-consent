import { describe, expect, test } from 'vitest'
import { applyEdits, eolOf, Planner } from '../../../ci/rollout/wire/engine'
import { globToRegExp, type SiteFiles } from '../../../ci/rollout/lib/site-files'
import type { Edit } from '../../../ci/rollout/types'

/** An in-memory site. */
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

/** Every occurrence of `needle` in `file`, as a hit. */
const occurrences = (files: SiteFiles, file: string, needle: string) => (): { start: number; end: number }[] => {
  const text = files.read(file)
  const out: { start: number; end: number }[] = []
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) out.push({ start: i, end: i + needle.length })
  return out
}

const edit = (start: number, end: number, text: string): Edit => ({ file: 'a.txt', start, end, text, target: 't' })

describe('Planner', () => {
  test('one hit gives one edit, placed by mode', () => {
    const files = memSite({ 'a.txt': 'one <X> two' })
    for (const [mode, expected] of [
      ['insert-before', { start: 4, end: 4, text: 'new' }],
      ['insert-after', { start: 7, end: 7, text: 'new' }],
      ['replace', { start: 4, end: 7, text: 'new' }],
    ] as const) {
      const p = new Planner(files)
      p.target('x', 'a.txt', () => false, occurrences(files, 'a.txt', '<X>'), () => 'new', mode)
      expect(p.result()).toEqual({ ok: true, edits: [{ file: 'a.txt', target: 'x', ...expected }], newFiles: [], skipped: [] })
    }
  })

  test('text() gets the hit it is placed at', () => {
    const files = memSite({ 'a.txt': 'one <X> two' })
    const p = new Planner(files)
    p.target('x', 'a.txt', () => false, occurrences(files, 'a.txt', '<X>'), (hit) => `${hit.start}-${hit.end}`, 'replace')
    const plan = p.result()
    expect(plan.ok && plan.edits[0]!.text).toBe('4-7')
  })

  test('zero hits or two hits is a refusal naming the count', () => {
    const files = memSite({ 'a.txt': '<X> and <X>' })
    const p = new Planner(files)
    p.target('missing', 'a.txt', () => false, occurrences(files, 'a.txt', '<Y>'), () => 'new', 'replace')
    p.target('twice', 'a.txt', () => false, occurrences(files, 'a.txt', '<X>'), () => 'new', 'replace')
    const plan = p.result()
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.refusals).toEqual([
      { file: 'a.txt', target: 'missing', reason: expect.stringMatching(/^found 0\b/) as string },
      { file: 'a.txt', target: 'twice', reason: expect.stringMatching(/^found 2\b/) as string },
    ])
  })

  test('any refusal makes the whole plan a refusal: no edits are returned', () => {
    const files = memSite({ 'a.txt': '<X>', 'b.txt': '<Y>' })
    const p = new Planner(files)
    p.target('fine', 'a.txt', () => false, occurrences(files, 'a.txt', '<X>'), () => 'new', 'replace')
    p.target('broken', 'b.txt', () => false, occurrences(files, 'b.txt', '<Z>'), () => 'new', 'replace')
    const plan = p.result()
    expect(plan).toEqual({ ok: false, refusals: [{ file: 'b.txt', target: 'broken', reason: expect.any(String) as string }] })
    expect(plan).not.toHaveProperty('edits')
  })

  test('refuse() records a refusal for a target that cannot be planned at all', () => {
    const p = new Planner(memSite({}))
    p.refuse('astro.config.mjs', 'config integrations', 'integrations is not an array literal')
    expect(p.result()).toEqual({
      ok: false,
      refusals: [{ file: 'astro.config.mjs', target: 'config integrations', reason: 'integrations is not an array literal' }],
    })
  })

  test('a locate that throws (missing file, parse error) is a refusal, not a crash', () => {
    const files = memSite({})
    const p = new Planner(files)
    p.target('x', 'gone.txt', () => false, occurrences(files, 'gone.txt', '<X>'), () => 'new', 'replace')
    const plan = p.result()
    expect(plan.ok).toBe(false)
    expect(!plan.ok && plan.refusals[0]!.reason).toMatch(/no such file: gone\.txt/)
  })

  test('an already wired target is skipped: no edit, and locate is not asked', () => {
    const files = memSite({ 'a.txt': '<X>' })
    const p = new Planner(files)
    let located = false
    p.target(
      'done',
      'a.txt',
      () => true,
      () => {
        located = true
        return []
      },
      () => 'new',
      'replace',
    )
    expect(p.result()).toEqual({ ok: true, edits: [], newFiles: [], skipped: ['done'] })
    expect(located).toBe(false)
  })

  test('newFile adds a file that does not exist, and skips one that does', () => {
    const p = new Planner(memSite({ 'src/data/kept.json': '{}' }))
    p.newFile('privacy.json', 'src/data/privacy.json', '{ "services": [] }\n')
    p.newFile('kept.json', 'src/data/kept.json', '{ "x": 1 }\n')
    expect(p.result()).toEqual({
      ok: true,
      edits: [],
      newFiles: [{ path: 'src/data/privacy.json', text: '{ "services": [] }\n' }],
      skipped: ['kept.json'],
    })
  })

  test('overlapping edits from two targets are a programming error', () => {
    const files = memSite({ 'a.txt': 'one <X> two' })
    const p = new Planner(files)
    p.target('a', 'a.txt', () => false, occurrences(files, 'a.txt', '<X>'), () => 'A', 'replace')
    p.target('b', 'a.txt', () => false, occurrences(files, 'a.txt', 'X>'), () => 'B', 'replace')
    expect(() => p.result()).toThrow(/overlap/)
  })

  test('idempotent: a target that is already wired after the plan is applied plans nothing the second time', () => {
    let text = '<html><body><main /></body></html>\n'
    const files: SiteFiles = { ...memSite({}), read: () => text, exists: () => true }
    const plan = (): ReturnType<Planner['result']> => {
      const p = new Planner(files)
      p.target(
        'banner',
        'a.astro',
        () => files.read('a.astro').includes('<ConsentBanner />'),
        occurrences(files, 'a.astro', '</body>'),
        () => '<ConsentBanner />',
        'insert-before',
      )
      return p.result()
    }
    const first = plan()
    expect(first.ok && first.edits.length).toBe(1)
    if (!first.ok) return
    text = applyEdits(text, first.edits)
    expect(text).toBe('<html><body><main /><ConsentBanner /></body></html>\n')
    expect(plan()).toEqual({ ok: true, edits: [], newFiles: [], skipped: ['banner'] })
  })
})

describe('applyEdits', () => {
  test('splices from the highest offset down, so every offset refers to the original text', () => {
    expect(applyEdits('abcdef', [edit(1, 2, 'XX'), edit(4, 4, '|'), edit(0, 0, '>')])).toBe('>aXXcd|ef')
  })

  test('untouched bytes stay identical: CRLF stays CRLF, tabs stay tabs', () => {
    const text = 'a\r\n\tb\r\n\t\tc\r\n'
    const out = applyEdits(text, [edit(text.indexOf('b'), text.indexOf('b') + 1, 'B')])
    expect(out).toBe('a\r\n\tB\r\n\t\tc\r\n')
    expect(Buffer.from(out).equals(Buffer.from(text.replace('b', 'B')))).toBe(true)
  })

  test('two inserts at one offset come out in plan order', () => {
    expect(applyEdits('ab', [edit(1, 1, '1'), edit(1, 1, '2')])).toBe('a12b')
  })

  test('an insert at the edge of a replace is not an overlap', () => {
    expect(applyEdits('abcd', [edit(1, 3, 'X'), edit(1, 1, '<'), edit(3, 3, '>')])).toBe('a<X>d')
  })

  test('overlapping edits throw', () => {
    expect(() => applyEdits('abcdef', [edit(1, 3, 'X'), edit(2, 4, 'Y')])).toThrow(/overlap/)
    expect(() => applyEdits('abcdef', [edit(1, 4, 'X'), edit(2, 2, 'Y')])).toThrow(/overlap/)
  })

  test('an edit outside the text throws', () => {
    expect(() => applyEdits('abc', [edit(2, 9, 'X')])).toThrow(/outside/)
  })
})

describe('eolOf', () => {
  test('CRLF when the text uses it, else LF', () => {
    expect(eolOf('a\r\nb\r\n')).toBe('\r\n')
    expect(eolOf('a\nb\n')).toBe('\n')
    expect(eolOf('a')).toBe('\n')
  })
})
