import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { dockerCheck } from '../../../ci/rollout/docker'
import type { Exec } from '../../../ci/rollout/lib/exec'

describe('dockerCheck', () => {
  test('passes build args to docker build (SITE_URL, as Coolify does)', async () => {
    const calls: string[][] = []
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args])
      if (cmd === 'git' && args[0] === 'clone') {
        mkdirSync(args.at(-1)!, { recursive: true })
        writeFileSync(`${args.at(-1)!}/Dockerfile`, 'FROM node:22\nARG SITE_URL\nEXPOSE 3000\n')
      }
      return { code: 0, out: cmd === 'docker' && args[0] === 'run' ? 'abc123\n' : '' }
    }
    const result = await dockerCheck('https://github.com/visionmediahq/bbstad.git', 'consent-banner', async () => true, { exec, waitUp: async () => true }, { SITE_URL: 'https://bbstad.se' })
    expect(result.pass).toBe(true)
    const build = calls.find((c) => c[0] === 'docker' && c[1] === 'build')!
    expect(build.slice(0, 4)).toEqual(['docker', 'build', '--build-arg', 'SITE_URL=https://bbstad.se'])
  })
})
