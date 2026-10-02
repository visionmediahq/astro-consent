import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parse, type HTMLElement } from 'node-html-parser'
import { copyDemo, type DemoMode } from '../../scripts/demo-copy'

export interface BuildResult {
  code: number
  /** stdout + stderr */
  output: string
  dir: string
  /** Parsed prerendered HTML, e.g. html('index.html') or html('karta/index.html'). */
  html(path: string): HTMLElement
  has(path: string): boolean
}

const dirs: string[] = []

/** Builds a temp copy of the demo. `mutate` edits the copy before the build. */
export function buildDemo(
  mode: DemoMode,
  mutate?: (dir: string) => void,
  env: Record<string, string> = {},
): BuildResult {
  const dir = copyDemo(mode, { linkNodeModules: true })
  dirs.push(dir)
  mutate?.(dir)
  const result = spawnSync('npx', ['astro', 'build'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', FORCE_COLOR: '0', ...env },
  })
  return {
    code: result.status ?? 1,
    output: `${result.stdout}\n${result.stderr}`,
    dir,
    html: (path) => parse(readFileSync(join(dir, 'dist/client', path), 'utf8')),
    has: (path) => existsSync(join(dir, 'dist/client', path)),
  }
}

export function cleanupBuilds(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}
