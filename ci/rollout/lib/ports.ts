// Verify's local ports, three in a row from ROLLOUT_PORT_BASE (default 4397): the Docker container
// on the base, main's preview on the next, the branch's on the one after. Two verifies on one
// machine at the same time need bases at least 3 apart; with the same ports the second one's previews
// refuse to start, or its checks run against the first one's server. verify takes a lock per base
// (lockPorts) and checks the ports answer nothing before it starts (#87).

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PORT_BASE = 4397

export interface Ports {
  docker: number
  main: number
  branch: number
}

/**
 * The ports for `env` (ROLLOUT_PORT_BASE). Unset or empty: the default. Anything that is not a
 * whole number from 1024 to 65533 throws: falling back to 4397 would bring back the collision the
 * variable was set to avoid.
 */
export function rolloutPorts(env: string | undefined = process.env['ROLLOUT_PORT_BASE']): Ports {
  if (env === undefined || env === '') return { docker: PORT_BASE, main: PORT_BASE + 1, branch: PORT_BASE + 2 }
  const n = /^\d+$/.test(env) ? Number(env) : NaN
  if (!(n >= 1024 && n <= 65533)) throw new Error(`ROLLOUT_PORT_BASE=${env}: needs a whole number from 1024 to 65533 (three ports from there are used)`)
  return { docker: n, main: n + 1, branch: n + 2 }
}

/** The ports are taken: another verify is running on them, or a killed run left a server behind. run.ts exits 4. */
export class PortsBusy extends Error {}

/** The lock file for `ports` in `dir` (the OS temp dir): one per base, so other bases run alongside. */
export const portsLockFile = (dir: string, ports: Ports): string => join(dir, `rollout-verify-${ports.docker}.lock`)

function running(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: it runs, as another user.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Takes the lock for `ports` (#87): a second verify on the same base stops here, before it pushes or
 * builds, instead of at step 3. A lock whose process is gone (a killed run) is taken over. Throws
 * PortsBusy while a running process holds it. Returns the release, which leaves a lock that is no
 * longer this process's.
 */
export function lockPorts(dir: string, ports: Ports): () => void {
  const file = portsLockFile(dir, ports)
  for (;;) {
    try {
      writeFileSync(file, `${process.pid}\n`, { flag: 'wx' })
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    let holder = NaN
    try {
      holder = Number(readFileSync(file, 'utf8').trim() || NaN)
    } catch {
      // released in between: try again
    }
    if (running(holder)) {
      throw new PortsBusy(
        `another verify (process ${holder}) holds ports ${ports.docker}-${ports.branch} (lock ${file}): wait for it, or set ROLLOUT_PORT_BASE to a base at least 3 away`,
      )
    }
    rmSync(file, { force: true })
  }
  return () => {
    try {
      if (readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file, { force: true })
    } catch {
      // already gone
    }
  }
}
