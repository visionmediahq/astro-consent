// Which tool code produced a rollout result: the commit of the astro-consent checkout the tool runs
// from (not the site's, not the cwd's), and whether tracked files differ from it. verify, live and
// detect record it as `tool` in their state files, so a result can be traced to an exact commit.
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ToolVersion {
  /** HEAD of the tool's checkout; null when git failed. */
  sha: string | null
  /** Tracked files changed against HEAD (untracked files ignored); null when git failed. */
  dirty: boolean | null
}

/** Runs git with `args` in `cwd` and returns its stdout; throws when git fails. */
export type GitRun = (args: string[], cwd: string) => string

/** The astro-consent checkout this file is in. */
export const TOOL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')

const realGit: GitRun = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

/** The tool's commit and whether it has uncommitted changes. Never throws. */
export function toolVersion(git: GitRun = realGit): ToolVersion {
  try {
    const sha = git(['rev-parse', 'HEAD'], TOOL_ROOT).trim()
    if (!/^[0-9a-f]{40}$/.test(sha)) return { sha: null, dirty: null }
    const status = git(['status', '--porcelain', '--untracked-files=no'], TOOL_ROOT)
    return { sha, dirty: status.trim() !== '' }
  } catch {
    return { sha: null, dirty: null }
  }
}

/** `tool: astro-consent @ 0123456`, for the console and evidence files. */
export function toolLine(tool: ToolVersion | undefined): string {
  if (!tool) return 'tool: astro-consent @ unknown (not recorded)'
  if (tool.sha === null) return 'tool: astro-consent @ unknown (git failed)'
  return `tool: astro-consent @ ${tool.sha.slice(0, 7)}${tool.dirty ? ' (uncommitted changes)' : ''}`
}

/** The same in Swedish, for the PR body. */
export function toolNote(tool: ToolVersion | undefined): string {
  if (!tool || tool.sha === null) return 'astro-consent, okänd version'
  return `astro-consent @ ${tool.sha.slice(0, 7)}${tool.dirty ? ', med ändringar som inte är incheckade' : ''}`
}
