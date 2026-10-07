// Runs a command without a shell and collects its output. verify and the Docker check take an
// `Exec` so tests can answer git, npm and docker themselves.
import { spawn } from 'node:child_process'

export interface ExecResult {
  code: number
  /** stdout and stderr, interleaved as they arrived. */
  out: string
}

export type Exec = (cmd: string, args: string[], cwd?: string) => Promise<ExecResult>

export const exec: Exec = (cmd, args, cwd) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' } })
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', (e) => resolve({ code: 127, out: `${out}${String(e)}\n` }))
    child.on('close', (code) => resolve({ code: code ?? 1, out }))
  })

/** The last `n` lines of a command's output, for the evidence. */
export const tail = (text: string, n = 40): string => text.trimEnd().split('\n').slice(-n).join('\n')
