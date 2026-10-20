// A script run through a symlinked directory (macOS /var -> /private/var, a cache under $TMPDIR, a
// symlinked checkout) has a real-path import.meta.url but a symlink argv[1]. The entry check used
// to compare them as they were, so main() never ran: exit 0, nothing written, nothing printed.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { isEntryScript } from '../../../ci/rollout/lib/is-entry'

const REPO = join(import.meta.dirname, '../../..')
const TSX = join(REPO, 'node_modules/.bin/tsx')
let link: string
let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'entry-symlink-'))
  symlinkSync(join(REPO, 'ci'), join(tmp, 'ci'))
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function run(script: string, args: string[]) {
  link = join(tmp, 'ci', script)
  const r = spawnSync(TSX, [link, ...args], { encoding: 'utf8', cwd: tmp, timeout: 60_000 })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('every entry script runs when started through a symlinked directory', () => {
  test('run.ts help prints the usage and exits 0', () => {
    const r = run('rollout/run.ts', ['help'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('usage: tsx ci/rollout/run.ts detect')
  })
  test('run.ts without a command exits 2 with the usage', () => {
    const r = run('rollout/run.ts', [])
    expect(r.code).toBe(2)
    expect(r.out).toContain('usage')
  })
  test('fonts-files.ts without arguments exits 2 with its usage', () => {
    const r = run('rollout/fonts-files.ts', [])
    expect(r.code).toBe(2)
    expect(r.out).toContain('usage: tsx ci/rollout/fonts-files.ts')
  })
  test('scan-secrets.ts without arguments exits 2 with its usage', () => {
    const r = run('rollout/scan-secrets.ts', [])
    expect(r.code).toBe(2)
    expect(r.out).toContain('usage')
  })
  test('wire-starter.ts without arguments exits 2 with its usage', () => {
    const r = run('wire-starter.ts', [])
    expect(r.code).toBe(2)
    expect(r.out).toContain('usage')
  })
  test('select.ts with a pool that does not exist fails loudly', () => {
    const r = run('rollout/select.ts', ['--pool', join(tmp, 'nope.json')])
    expect(r.out.length).toBeGreaterThan(0)
    expect(r.code).not.toBe(0)
  })
  test('pool.ts with an unknown option fails loudly', () => {
    const r = run('rollout/pool.ts', ['--definitely-not-an-option'])
    expect(r.out.length).toBeGreaterThan(0)
    expect(r.code).not.toBe(0)
  })
})

describe('isEntryScript', () => {
  const here = new URL(import.meta.url).href
  test('true for the same file, by path or through a symlink', () => {
    expect(isEntryScript(here, import.meta.filename)).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), 'entry-is-'))
    try {
      symlinkSync(import.meta.dirname, join(dir, 'd'))
      expect(isEntryScript(here, join(dir, 'd', 'entry-symlink.test.ts'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('false for another file, no argv[1] or a path that does not exist', () => {
    expect(isEntryScript(here, join(import.meta.dirname, 'run.test.ts'))).toBe(false)
    expect(isEntryScript(here, undefined)).toBe(false)
    expect(isEntryScript(here, '/definitely/not/here.ts')).toBe(false)
  })
})
