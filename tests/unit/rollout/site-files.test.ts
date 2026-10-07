import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { diskSite, fixtureSite } from '../../../ci/rollout/lib/site-files'

const dirs: string[] = []
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'site-files-'))
  dirs.push(dir)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('fixtureSite', () => {
  test('strips .txt from listed paths', () => {
    const site = fixtureSite(tree({ 'astro.config.mjs.txt': 'export default {}' }))
    expect(site.list('astro.config.*')).toEqual(['astro.config.mjs'])
  })

  test('read returns content, exists is false for a missing file', () => {
    const site = fixtureSite(
      tree({ 'astro.config.mjs.txt': 'cfg', 'src/layouts/Base.astro.txt': '<html />' }),
    )
    expect(site.read('src/layouts/Base.astro')).toBe('<html />')
    expect(site.exists('src/layouts/Base.astro')).toBe(true)
    expect(site.exists('src/pages/404.astro')).toBe(false)
    expect(site.list('src/**/*.astro')).toEqual(['src/layouts/Base.astro'])
  })
})

describe('diskSite', () => {
  test('lists, reads and checks real paths, sorted, without node_modules', () => {
    const dir = tree({
      'src/pages/index.astro': 'index',
      'src/layouts/Base.astro': 'base',
      'node_modules/x/y.astro': 'no',
    })
    const site = diskSite(dir)
    expect(site.root).toBe(dir)
    expect(site.list('**/*.astro')).toEqual(['src/layouts/Base.astro', 'src/pages/index.astro'])
    expect(site.read('src/pages/index.astro')).toBe('index')
    expect(site.exists('src/pages/nope.astro')).toBe(false)
  })
})
