import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { parseDetectArgs, runDetect } from '../../../ci/rollout/run'
import type { Report } from '../../../ci/rollout/types'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function site(): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-detect-'))
  dirs.push(dir)
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ dependencies: { astro: '^6.1.0' } }),
    'astro.config.mjs': "import { defineConfig } from 'astro/config'\nexport default defineConfig({})\n",
    'src/layouts/Base.astro': '<html><body><slot /><footer class="text-sm">© Site</footer></body></html>\n',
    'src/pages/index.astro': "---\nimport Base from '../layouts/Base.astro'\n---\n<Base><h1>Hej</h1></Base>\n",
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

describe('parseDetectArgs', () => {
  test('a dir and one or more --domain', () => {
    expect(parseDetectArgs(['site', '--domain', 'a.se', '--domain', 'www.b.se'])).toEqual({ dir: 'site', domains: ['a.se', 'www.b.se'] })
    expect(parseDetectArgs(['--domain=a.se', 'site'])).toEqual({ dir: 'site', domains: ['a.se'] })
  })

  test('no dir, no domain, a bare --domain or an unknown flag is an error', () => {
    expect(() => parseDetectArgs(['--domain', 'a.se'])).toThrow(/usage/)
    expect(() => parseDetectArgs(['site'])).toThrow(/--domain/)
    expect(() => parseDetectArgs(['site', '--domain'])).toThrow(/--domain/)
    expect(() => parseDetectArgs(['site', '--domain', 'a.se', '--dry'])).toThrow(/--dry/)
  })

  test('a domain is a bare host: a scheme or path is refused', () => {
    expect(() => parseDetectArgs(['site', '--domain', 'https://a.se/'])).toThrow(/a.se/)
  })
})

describe('runDetect', () => {
  test('writes .rollout/report.json with the domains and excludes .rollout/ from git', () => {
    const dir = site()
    const report = runDetect(dir, ['a.se'])
    const written = JSON.parse(readFileSync(join(dir, '.rollout/report.json'), 'utf8')) as Report
    expect(written).toEqual(report)
    expect(written.domains).toEqual(['a.se'])
    expect(written.site).toBe(basename(dir))
    expect(readFileSync(join(dir, '.git/info/exclude'), 'utf8').split('\n')).toContain('.rollout/')
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' })).not.toContain('.rollout')
  })

  test('running twice adds the exclude line once', () => {
    const dir = site()
    runDetect(dir, ['a.se'])
    runDetect(dir, ['a.se'])
    const lines = readFileSync(join(dir, '.git/info/exclude'), 'utf8').split('\n').filter((l) => l === '.rollout/')
    expect(lines).toHaveLength(1)
  })

  test('a dir that is not a git checkout is refused before anything is written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-detect-nogit-'))
    dirs.push(dir)
    expect(() => runDetect(dir, ['a.se'])).toThrow(/git/)
    expect(existsSync(join(dir, '.rollout'))).toBe(false)
  })
})
