// Verify's local ports, three in a row from ROLLOUT_PORT_BASE (default 4397): the Docker container
// on the base, main's preview on the next, the branch's on the one after. Two verifies on one
// machine at the same time need bases at least 3 apart; with the same ports the second one's previews
// refuse to start, or its checks run against the first one's server.

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
