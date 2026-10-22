import { mkdirSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { dockerCheck, imageTag } from '../../../ci/rollout/docker'
import type { Exec } from '../../../ci/rollout/lib/exec'

describe('dockerCheck', () => {
  // A ROLLOUT_PORT_BASE set in the shell must not change these tests.
  beforeEach(() => void vi.stubEnv('ROLLOUT_PORT_BASE', ''))
  afterEach(() => void vi.unstubAllEnvs())

  test('publishes the container on ROLLOUT_PORT_BASE (default 4397) and checks it there', async () => {
    for (const [env, port] of [['', 4397], ['4417', 4417]] as const) {
      vi.stubEnv('ROLLOUT_PORT_BASE', env)
      const calls: string[][] = []
      const exec: Exec = async (cmd, args) => {
        calls.push([cmd, ...args])
        if (cmd === 'git' && args[0] === 'clone') {
          mkdirSync(args.at(-1)!, { recursive: true })
          writeFileSync(`${args.at(-1)!}/Dockerfile`, 'FROM node:22\nEXPOSE 3000\n')
        }
        return { code: 0, out: cmd === 'docker' && args[0] === 'run' ? 'abc123\n' : '' }
      }
      const urls: string[] = []
      const waited: string[] = []
      const result = await dockerCheck('https://github.com/visionmediahq/site-1270076313.git', 'consent-banner', async (url) => (urls.push(url), true), { exec, waitUp: async (u) => (waited.push(u), true) })
      expect(result.pass).toBe(true)
      const run = calls.find((c) => c[0] === 'docker' && c[1] === 'run')!
      expect(run[run.indexOf('-p') + 1]).toBe(`${port}:3000`)
      expect(waited).toEqual([`http://127.0.0.1:${port}/`])
      expect(urls).toEqual([`http://127.0.0.1:${port}`])
    }
  })

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
    const result = await dockerCheck('https://github.com/visionmediahq/site-1270076313.git', 'consent-banner', async () => true, { exec, waitUp: async () => true }, { SITE_URL: 'https://site-1270076313.se' })
    expect(result.pass).toBe(true)
    const build = calls.find((c) => c[0] === 'docker' && c[1] === 'build')!
    expect(build.slice(0, 4)).toEqual(['docker', 'build', '--build-arg', 'SITE_URL=https://site-1270076313.se'])
  })

  test('uses one lowercase image tag for build, run and removal (ExampleCamp)', async () => {
    const calls: string[][] = []
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args])
      if (cmd === 'git' && args[0] === 'clone') {
        mkdirSync(args.at(-1)!, { recursive: true })
        writeFileSync(`${args.at(-1)!}/Dockerfile`, 'FROM node:22\nEXPOSE 3000\n')
      }
      return { code: 0, out: cmd === 'docker' && args[0] === 'run' ? 'abc123\n' : '' }
    }
    const result = await dockerCheck('git@github.com:visionmediahq/ExampleCamp.git', 'consent-banner', async () => true, { exec, waitUp: async () => true })
    expect(result.pass).toBe(true)
    const docker = (sub: string) => calls.find((c) => c[0] === 'docker' && c[1] === sub)!
    const build = docker('build')
    expect(build[build.indexOf('-t') + 1]).toBe('rollout-examplecamp')
    expect(docker('run').at(-1)).toBe('rollout-examplecamp')
    expect(docker('rmi').at(-1)).toBe('rollout-examplecamp')
  })
})

describe('imageTag', () => {
  test('is a valid Docker reference: lowercase, [a-z0-9._-] only, rollout- prefix', () => {
    expect(imageTag('ExampleCamp')).toBe('rollout-examplecamp')
    expect(imageTag('site-1270076313')).toBe('rollout-site-1270076313')
    expect(imageTag('my.site_2-x')).toBe('rollout-my.site_2-x')
    expect(imageTag('Site Name+Ö')).toBe('rollout-site-name')
    // Docker's path-component grammar: a separator (one . or _, __, or dashes) between alphanumerics.
    const component = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/
    for (const name of ['ExampleCamp', 'Site Name+Ö', '.x', '__', 'a..b', 'x-', '']) {
      expect(imageTag(name), name).toMatch(component)
      expect(imageTag(name), name).toMatch(/^rollout-/)
    }
  })
})
