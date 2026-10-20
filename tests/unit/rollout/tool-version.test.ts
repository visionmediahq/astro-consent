import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { TOOL_ROOT, type GitRun, toolLine, toolNote, toolVersion } from '../../../ci/rollout/lib/tool-version'

const SHA = '0123456789abcdef0123456789abcdef01234567'

/** A git that answers by command line and records where it ran. */
const git = (answers: Record<string, string | Error>): { run: GitRun; calls: string[] } => {
  const calls: string[] = []
  const run: GitRun = (args, cwd) => {
    calls.push(`${cwd} git ${args.join(' ')}`)
    const a = answers[args.join(' ')]
    if (a === undefined || a instanceof Error) throw a ?? new Error(`unexpected git ${args.join(' ')}`)
    return a
  }
  return { run, calls }
}

describe('toolVersion', () => {
  test('a clean checkout: the HEAD sha, not dirty; git runs in the repo root, tracked files only', () => {
    const g = git({ 'rev-parse HEAD': `${SHA}\n`, 'status --porcelain --untracked-files=no': '' })
    expect(toolVersion(g.run)).toEqual({ sha: SHA, dirty: false })
    expect(g.calls).toEqual([`${TOOL_ROOT} git rev-parse HEAD`, `${TOOL_ROOT} git status --porcelain --untracked-files=no`])
  })

  test('a changed tracked file: dirty', () => {
    const g = git({ 'rev-parse HEAD': `${SHA}\n`, 'status --porcelain --untracked-files=no': ' M ci/rollout/verify.ts\n' })
    expect(toolVersion(g.run)).toEqual({ sha: SHA, dirty: true })
  })

  test('git failing: nulls, never a throw', () => {
    expect(toolVersion(git({ 'rev-parse HEAD': new Error('not a git repository') }).run)).toEqual({ sha: null, dirty: null })
    expect(toolVersion(git({ 'rev-parse HEAD': `${SHA}\n`, 'status --porcelain --untracked-files=no': new Error('index.lock') }).run)).toEqual({ sha: null, dirty: null })
    expect(toolVersion(git({ 'rev-parse HEAD': 'garbage\n', 'status --porcelain --untracked-files=no': '' }).run)).toEqual({ sha: null, dirty: null })
  })

  test('TOOL_ROOT is this repo, whatever the cwd; the real git answers', () => {
    expect(TOOL_ROOT).toBe(join(import.meta.dirname, '../../..'))
    const real = toolVersion()
    expect(real.sha).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: TOOL_ROOT, encoding: 'utf8' }).trim())
    expect(typeof real.dirty).toBe('boolean')
  })
})

describe('toolLine and toolNote', () => {
  test('the console line: short sha, and the uncommitted changes when dirty', () => {
    expect(toolLine({ sha: SHA, dirty: false })).toBe('tool: astro-consent @ 0123456')
    expect(toolLine({ sha: SHA, dirty: true })).toBe('tool: astro-consent @ 0123456 (uncommitted changes)')
    expect(toolLine({ sha: null, dirty: null })).toBe('tool: astro-consent @ unknown (git failed)')
    expect(toolLine(undefined)).toBe('tool: astro-consent @ unknown (not recorded)')
  })

  test('the PR body: Swedish', () => {
    expect(toolNote({ sha: SHA, dirty: false })).toBe('astro-consent @ 0123456')
    expect(toolNote({ sha: SHA, dirty: true })).toBe('astro-consent @ 0123456, med ändringar som inte är incheckade')
    expect(toolNote({ sha: null, dirty: null })).toBe('astro-consent, okänd version')
    expect(toolNote(undefined)).toBe('astro-consent, okänd version')
  })
})
