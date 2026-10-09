// Verify step 8 (spec C3.8), ported from the pilot kit's dk.sh: the pushed branch cloned clean the
// way Coolify gets it, the site's own Dockerfile built (no git in the image) and run with PORT set,
// the checks run against the container, then the container, image, build cache and clone deleted.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Exec, exec as realExec, tail } from './lib/exec'
import { waitUp as realWaitUp } from './preview'

export const DOCKER_PORT = 4397

export interface DockerDeps {
  exec?: Exec
  waitUp?: (url: string) => Promise<boolean>
}

/** `git@github.com:org/name.git` or `https://github.com/org/name` → `name`. */
export const repoName = (url: string): string => url.replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).at(-1) ?? 'site'

/** The Dockerfile's first `EXPOSE <port>`, 80 when there is none (as dk.sh). */
export function exposedPort(dockerfile: string): number {
  const m = /^\s*EXPOSE\s+(\d+)/im.exec(dockerfile)
  return m ? Number(m[1]) : 80
}

/**
 * Clones `branch` of `repoUrl`, builds and runs its Dockerfile on port 4397 and calls `run(url)`
 * against it. Cleanup always runs, also when `run` throws: container stopped, image removed, build
 * cache pruned, clone deleted. Docker not running is a failure with a clear message, never a skip.
 * `buildArgs` are what Coolify passes as build variables (SITE_URL): a Dockerfile that turns an
 * ARG into ENV otherwise builds with an empty string.
 */
export async function dockerCheck(
  repoUrl: string,
  branch: string,
  run: (url: string) => Promise<boolean>,
  deps: DockerDeps = {},
  buildArgs: Record<string, string> = {},
): Promise<{ pass: boolean; log: string }> {
  const exec = deps.exec ?? realExec
  const waitUp = deps.waitUp ?? ((url: string) => realWaitUp(url, 120_000))
  const log: string[] = []
  const info = await exec('docker', ['info'])
  if (info.code !== 0) {
    return { pass: false, log: `Docker is not running (docker info failed): start Docker Desktop and rerun verify.\n${tail(info.out, 5)}` }
  }
  const repo = repoName(repoUrl)
  const image = `rollout-${repo}`
  const tmp = mkdtempSync(join(tmpdir(), `rollout-docker-${repo}-`))
  const clone = join(tmp, repo)
  let container: string | null = null
  let built = false
  try {
    const cloned = await exec('git', ['clone', '--depth', '1', '--branch', branch, repoUrl, clone])
    if (cloned.code !== 0) return { pass: false, log: `git clone failed:\n${tail(cloned.out)}` }
    const dockerfile = join(clone, 'Dockerfile')
    if (!existsSync(dockerfile)) return { pass: false, log: 'the branch has no Dockerfile at its root' }
    const port = exposedPort(readFileSync(dockerfile, 'utf8'))
    log.push(`cloned ${repoUrl}#${branch}; EXPOSE ${port}`)
    built = true
    const args = Object.entries(buildArgs).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`])
    if (args.length) log.push(`build args: ${Object.keys(buildArgs).join(', ')}`)
    const build = await exec('docker', ['build', ...args, '-t', image, clone])
    log.push(`docker build exit ${build.code}`)
    if (build.code !== 0) return { pass: false, log: `${log.join('\n')}\n${tail(build.out, 30)}` }
    const started = await exec('docker', ['run', '-d', '--rm', '-p', `${DOCKER_PORT}:${port}`, '-e', 'HOST=0.0.0.0', '-e', `PORT=${port}`, image])
    if (started.code !== 0) return { pass: false, log: `${log.join('\n')}\ndocker run failed:\n${tail(started.out)}` }
    container = started.out.trim().split('\n').at(-1) ?? null
    const url = `http://127.0.0.1:${DOCKER_PORT}`
    if (!(await waitUp(`${url}/`))) {
      const logs = container ? await exec('docker', ['logs', '--tail', '30', container]) : { out: '' }
      return { pass: false, log: `${log.join('\n')}\nthe container did not answer on ${url}:\n${logs.out}` }
    }
    let pass = false
    try {
      pass = await run(url)
    } catch (e) {
      log.push(`checks against the container threw: ${(e as Error).message}`)
    }
    log.push(`checks against the container: ${pass ? 'pass' : 'FAIL'}`)
    return { pass, log: log.join('\n') }
  } finally {
    if (container) await exec('docker', ['stop', container])
    if (built) {
      await exec('docker', ['rmi', '-f', image])
      await exec('docker', ['builder', 'prune', '-f'])
    }
    rmSync(tmp, { recursive: true, force: true })
  }
}
