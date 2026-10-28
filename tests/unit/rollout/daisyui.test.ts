import { describe, expect, test } from 'vitest'
import { partsMissingFromBuild, readDaisyuiPlugin } from '../../../ci/rollout/lib/daisyui'

describe('readDaisyuiPlugin (#101)', () => {
  test('a bare @plugin "daisyui" loads every part', () => {
    expect(readDaisyuiPlugin(['@import "tailwindcss";\n@plugin "daisyui";\n'])).toEqual({ plugin: true, missing: [], prefix: '', ownClasses: [] })
  })

  test('a block without include/exclude (themes only) loads every part', () => {
    expect(readDaisyuiPlugin(['@plugin "daisyui" {\n  themes: light --default;\n}']).missing).toEqual([])
  })

  test('include: button alone leaves out the rest, in the package order', () => {
    expect(readDaisyuiPlugin(['@plugin "daisyui" {\n  include: button;\n  themes: false;\n}']).missing).toEqual([
      'card',
      'toggle',
      'badge',
      'link',
      'checkbox',
    ])
  })

  test('include with every part, quoted or not, misses nothing', () => {
    const css = `@plugin "daisyui" { include: "button", card, toggle, badge, link, 'checkbox', input; }`
    expect(readDaisyuiPlugin([css]).missing).toEqual([])
  })

  test('exclude lists only what it names', () => {
    const css = '@plugin "daisyui" {\n  exclude: steps, checkbox, mask,\n    toggle;\n}'
    expect(readDaisyuiPlugin([css]).missing).toEqual(['toggle', 'checkbox'])
  })

  test('a commented-out @plugin and daisyui/theme are not the plugin', () => {
    const css = '/* @plugin "daisyui"; */\n@plugin "daisyui/theme" {\n  name: "x";\n}\n'
    expect(readDaisyuiPlugin([css]).plugin).toBe(false)
  })

  test('a comment inside the block that names parts does not count as the list', () => {
    const css = '@plugin "daisyui" {\n  /* card, toggle and badge are for the banner */\n  include: button;\n}'
    expect(readDaisyuiPlugin([css]).missing).toContain('card')
  })

  test('the plugin in a second file is found', () => {
    expect(readDaisyuiPlugin(['@import "tailwindcss";', "@plugin 'daisyui' { include: button; }"]).plugin).toBe(true)
  })

  test('prefix is reported', () => {
    expect(readDaisyuiPlugin(['@plugin "daisyui" { prefix: "d-"; }']).prefix).toBe('d-')
  })

  test("the site's own class for a missing part is reported, a longer class name is not", () => {
    const css = '@plugin "daisyui" { include: button; }\n.card, .panel { padding: 2rem; }\n.badge-row { gap: 1rem; }\n.btn { x: y; }'
    expect(readDaisyuiPlugin([css]).ownClasses).toEqual(['card'])
  })
})

describe('partsMissingFromBuild (#101)', () => {
  const all = '.btn-ghost{}.card-body{}.toggle-sm{}.badge-neutral{}.link-hover:hover{}.checkbox-sm{}'

  test('built CSS with every marker misses nothing', () => {
    expect(partsMissingFromBuild([all])).toEqual([])
  })

  test("a site's own .card and .toggle rules are not daisyUI's", () => {
    expect(partsMissingFromBuild(['.btn-ghost{}.card{}.card-surface{}.toggle{}.badge-neutral{}.link-hover{}.checkbox-sm{}'])).toEqual([
      'card',
      'toggle',
    ])
  })

  test('markers may be spread over several files', () => {
    expect(partsMissingFromBuild(['.btn-ghost{}.card-body{}', '.toggle-sm,.badge-neutral{}', '.link-hover{}.checkbox-sm{}'])).toEqual([])
  })

  test('no CSS at all misses every part', () => {
    expect(partsMissingFromBuild([])).toHaveLength(6)
  })
})
