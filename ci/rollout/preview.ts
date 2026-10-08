// A built site served locally for verify (spec C3 step 3), ported from the pilot kit's pv.sh.
// The server runs detached in its own process group with its output in a log file, never a pipe:
// a pipe held by a background server keeps the parent waiting (the pilot's lesson). stop() kills the
// whole group, so `npm run preview` takes its astro child with it.
import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tail } from './lib/exec'

export interface Preview {
  url: string
  stop(): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** True when anything answers HTTP at `url`, whatever the status. */
export async function isUp(url: string): Promise<boolean> {
  try {
    await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) })
    return true
  } catch {
    return false
  }
}

/** Polls `url` every 500 ms until it answers or `ms` have passed. */
export async function waitUp(url: string, ms = 60_000, alive: () => boolean = () => true): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end && alive()) {
    if (await isUp(url)) return true
    await sleep(500)
  }
  return false
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

async function killGroup(pid: number): Promise<void> {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(-pid, signal)
    } catch {
      return
    }
    for (let i = 0; i < 30 && groupAlive(pid); i++) await sleep(100)
    if (!groupAlive(pid)) return
  }
}

/**
 * Serves the built site in `dir` on `port`. SSR: `HOST=127.0.0.1 PORT=<port> node <entry>` (entry
 * `dist/server/entry.mjs` unless given). Static: `npm run preview -- --port <port>`. Refuses a port
 * that already answers, so a stale server is never checked by mistake. Throws with the log's tail
 * when the server does not come up within 60 s.
 */
export async function startPreview(dir: string, port: number, ssr: boolean, entry = 'dist/server/entry.mjs'): Promise<Preview> {
  const url = ssr ? `http://127.0.0.1:${port}` : `http://localhost:${port}`
  if ((await isUp(`http://127.0.0.1:${port}/`)) || (await isUp(`http://localhost:${port}/`))) {
    throw new Error(`port ${port} is already in use: stop whatever serves it first`)
  }
  const log = join(tmpdir(), `rollout-preview-${port}.log`)
  const fd = openSync(log, 'w')
  const [cmd, args] = ssr ? ['node', [entry]] : ['npm', ['run', 'preview', '--', '--port', String(port)]]
  const child = spawn(cmd as string, args as string[], {
    cwd: dir,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ASTRO_TELEMETRY_DISABLED: '1' },
  })
  closeSync(fd)
  child.unref()
  let exited = false
  child.on('exit', () => (exited = true))
  child.on('error', () => (exited = true))
  const pid = child.pid
  const stop = async () => {
    if (pid !== undefined) await killGroup(pid)
  }
  if (pid === undefined || !(await waitUp(`${url}/`, 60_000, () => !exited))) {
    await stop()
    let text = ''
    try {
      text = readFileSync(log, 'utf8')
    } catch {
      // no log
    }
    throw new Error(`preview on port ${port} did not start (${cmd} ${(args as string[]).join(' ')} in ${dir}):\n${tail(text, 20)}`)
  }
  return { url, stop }
}
