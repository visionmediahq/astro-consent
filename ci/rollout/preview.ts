// A built site served locally for verify (spec C3 step 3), ported from the pilot kit's pv.sh.
// The server runs detached in its own process group with its output in a log file, never a pipe:
// a pipe held by a background server keeps the parent waiting (the pilot's lesson). stop() kills the
// whole group, so `npm run preview` takes its astro child with it.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { tail } from './lib/exec'

export interface Preview {
  url: string
  stop(): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The log a preview on `port` writes to; a new preview on the same port starts it afresh. */
export const previewLog = (port: number): string => join(tmpdir(), `rollout-preview-${port}.log`)

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

export const DEFAULT_SSR_ENTRY = 'dist/server/entry.mjs'

/**
 * The file an SSR site's server runs (#60). site 1280190874 starts `node ./dist/server-entry.mjs`,
 * its own server around the Astro handler; `dist/server/entry.mjs` there only exports the handler
 * and exits. So a `start` script that is exactly `node <file>`, with the file inside `dir` and
 * present after the build, gives the entry. Anything else keeps Astro's default: no script, `astro
 * preview`, a chain of commands, a missing file, and node flags, which the preview would drop
 * (astro-starter's `node --experimental-strip-types ./server.ts` is one; its standalone build
 * starts from the default entry).
 */
export function ssrEntry(dir: string): { entry: string; from: 'start' | 'default' } {
  const fallback = { entry: DEFAULT_SSR_ENTRY, from: 'default' } as const
  let start: unknown
  try {
    start = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts?.['start']
  } catch {
    return fallback
  }
  const m = typeof start === 'string' ? /^node\s+([^\s-]\S*\.[cm]?js)$/.exec(start.trim()) : null
  if (!m) return fallback
  const entry = normalize(m[1]!)
  if (entry.startsWith('../') || isAbsolute(entry) || !existsSync(join(dir, entry))) return fallback
  return { entry, from: 'start' }
}

/**
 * Serves the built site in `dir` on `port`. SSR: `HOST=127.0.0.1 PORT=<port> node <entry>` (entry
 * `dist/server/entry.mjs` unless given). Static: `npm run preview -- --port <port>`. Refuses a port
 * that already answers, so a stale server is never checked by mistake. Throws with the log's tail
 * when the server does not come up within 60 s.
 */
export async function startPreview(dir: string, port: number, ssr: boolean, entry = DEFAULT_SSR_ENTRY): Promise<Preview> {
  const url = ssr ? `http://127.0.0.1:${port}` : `http://localhost:${port}`
  if ((await isUp(`http://127.0.0.1:${port}/`)) || (await isUp(`http://localhost:${port}/`))) {
    throw new Error(`port ${port} is already in use: stop whatever serves it first`)
  }
  const log = previewLog(port)
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
