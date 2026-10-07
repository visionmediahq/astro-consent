import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { main, parseDetectArgs, parseLiveArgs, parseMergeArgs, parseVerifyArgs, runDetect, USAGE } from '../../../ci/rollout/run'
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

describe('parseVerifyArgs', () => {
  test('a site dir, or --demo with a dist dir', () => {
    expect(parseVerifyArgs(['site'])).toEqual({ dir: 'site', demo: false })
    expect(parseVerifyArgs(['--demo', 'demo/dist-consent'])).toEqual({ dir: 'demo/dist-consent', demo: true })
  })

  test('no dir, two dirs or an unknown flag is an error', () => {
    expect(() => parseVerifyArgs([])).toThrow(/usage/)
    expect(() => parseVerifyArgs(['--demo'])).toThrow(/usage/)
    expect(() => parseVerifyArgs(['a', 'b'])).toThrow(/one/)
    expect(() => parseVerifyArgs(['a', '--fast'])).toThrow(/--fast/)
  })
})

describe('parseLiveArgs', () => {
  test('a site dir and a mode; post-merge may take the merge commit', () => {
    expect(parseLiveArgs(['site', 'baseline'])).toEqual({ dir: 'site', mode: 'baseline' })
    expect(parseLiveArgs(['site', 'post-merge', '--sha', 'a'.repeat(40)])).toEqual({ dir: 'site', mode: 'post-merge', sha: 'a'.repeat(40) })
  })

  test('a missing or unknown mode, a bad sha or --sha with baseline is an error', () => {
    expect(() => parseLiveArgs(['site'])).toThrow(/usage/)
    expect(() => parseLiveArgs(['site', 'after'])).toThrow(/usage/)
    expect(() => parseLiveArgs(['site', 'post-merge', '--sha', 'main'])).toThrow(/sha/)
    expect(() => parseLiveArgs(['site', 'baseline', '--sha', 'a'.repeat(40)])).toThrow(/post-merge/)
  })
})

describe('parseMergeArgs', () => {
  test('a site dir and a PR number', () => {
    expect(parseMergeArgs(['site', '7'])).toEqual({ dir: 'site', pr: 7 })
    expect(() => parseMergeArgs(['site'])).toThrow(/usage/)
    expect(() => parseMergeArgs(['site', 'x'])).toThrow(/PR number/)
    expect(() => parseMergeArgs(['site', '7', '8'])).toThrow(/usage/)
  })
})

describe('the CLI (Task 23)', () => {
  /** Runs main with console output captured. */
  async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = []
    const err: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')))
    const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')))
    try {
      return { code: await main(argv), out: out.join('\n'), err: err.join('\n') }
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
  }

  test('USAGE names every subcommand, the exit codes and where state lives', () => {
    for (const cmd of ['detect', 'wire', 'verify', 'pr', 'live', 'merge']) expect(USAGE).toMatch(new RegExp(`run\\.ts ${cmd} `))
    expect(USAGE).toMatch(/exit codes?:/i)
    expect(USAGE).toMatch(/0[^\n]*ok/i)
    expect(USAGE).toMatch(/1[^\n]*error/i)
    expect(USAGE).toMatch(/2[^\n]*usage/i)
    expect(USAGE).toMatch(/3[^\n]*refused/i)
    expect(USAGE).toContain('.rollout/')
  })

  test('no command or an unknown one prints the usage and exits 2', async () => {
    for (const argv of [[], ['deploy'], ['--dry-run']]) {
      const r = await run(argv)
      expect(r.code).toBe(2)
      expect(r.err).toContain(USAGE)
    }
  })

  test('help, --help and -h print the usage to stdout and exit 0', async () => {
    for (const argv of [['help'], ['--help'], ['-h']]) {
      const r = await run(argv)
      expect(r.code).toBe(0)
      expect(r.out).toContain(USAGE)
    }
  })

  test('bad arguments to any subcommand exit 2', async () => {
    for (const argv of [['detect', 'site'], ['wire'], ['verify'], ['pr', 'site'], ['live', 'site'], ['merge', 'site', 'x']]) {
      expect((await run(argv)).code, argv.join(' ')).toBe(2)
    }
  })

  test('detect on a dir that is not a git checkout is an error (exit 1), not a crash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-main-nogit-'))
    dirs.push(dir)
    const r = await run(['detect', dir, '--domain', 'a.se'])
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/not a git checkout/)
  })
})
