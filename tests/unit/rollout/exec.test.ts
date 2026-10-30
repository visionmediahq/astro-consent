import { describe, expect, test } from 'vitest'
import { exec } from '../../../ci/rollout/lib/exec'

describe('exec', () => {
  test('keeps stdout apart from stderr: npm ls --json prints its log line on stderr after the JSON (#128)', async () => {
    const script = "process.stdout.write('{\"a\":1}\\n'); process.stderr.write('npm error A complete log\\n'); process.exitCode = 1"
    const res = await exec(process.execPath, ['-e', script])
    expect(res.code).toBe(1)
    expect(res.stdout).toBe('{"a":1}\n')
    expect(res.out).toContain('{"a":1}')
    expect(res.out).toContain('npm error A complete log')
  })
})
