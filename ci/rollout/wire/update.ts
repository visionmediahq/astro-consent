// The update flow: a site whose banner is live gets its lockfile moved to the latest astro-consent
// release, on branch astro-consent-update from origin/main, one commit with package.json and
// package-lock.json only. A site does not upgrade on its own: package.json allows a semver range,
// but Docker runs `npm ci`, which installs the commit the lockfile pins.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Lockfile } from '../lib/lockfile'

export const UPDATE_BRANCH = 'astro-consent-update'
const PKG = '@visionmediahq/astro-consent'
/** This checkout of astro-consent: its package.json version is the release an update installs. */
const REPO = join(import.meta.dirname, '../../..')
export const RELEASE = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version
export const CHANGELOG_PATH = join(REPO, 'CHANGELOG.md')

/** The dependency spec an update installs: the release as the new floor of the range. */
export const updateSpec = (version: string): string => `github:visionmediahq/astro-consent#semver:^${version}`
export const updateCommitMessage = (from: string, to: string): string => `chore: astro-consent ${from} → ${to}`

/** `npm install` of `spec` into the lockfile alone: no node_modules, no install scripts. */
export function npmUpdate(dir: string, spec: string): void {
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', `${PKG}@${spec}`], { cwd: dir, stdio: 'inherit' })
}

/** The version and commit (from `resolved`, `…#<sha>`) of the installed package, or null without it. */
export function installedOf(lock: string | Lockfile): { version: string; sha: string | null } | null {
  const entry = (typeof lock === 'string' ? (JSON.parse(lock) as Lockfile) : lock).packages?.[`node_modules/${PKG}`]
  const version = entry?.['version']
  if (typeof version !== 'string') return null
  const sha = /#([0-9a-f]{40})$/.exec(String(entry?.['resolved'] ?? ''))?.[1] ?? null
  return { version, sha }
}

/** Compares x.y.z versions part by part, numerically. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** The CHANGELOG.md entries (`## x.y.z`) after `from` up to and including `to`, newest first. */
export function changelogBetween(changelog: string, from: string, to: string): { version: string; text: string }[] {
  const entries = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)].map((m) => ({ version: m[1]!, text: m[2]!.trim() }))
  if (!entries.some((e) => e.version === to)) throw new Error(`CHANGELOG.md has no entry for ${to}: pull this astro-consent checkout`)
  return entries.filter((e) => compareVersions(e.version, from) > 0 && compareVersions(e.version, to) <= 0)
}

/** `CONSENT_VERSION` of a src/config.ts, or null. */
export const consentVersionOf = (configTs: string): number | null => {
  const m = /export const CONSENT_VERSION = (\d+)/.exec(configTs)
  return m ? Number(m[1]) : null
}

/** `CONSENT_VERSION` at commit `sha` of astro-consent (this checkout's history), or null when git cannot show it. */
export function consentVersionAt(sha: string): number | null {
  try {
    return consentVersionOf(execFileSync('git', ['show', `${sha}:src/config.ts`], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return null
  }
}

/**
 * From main's lockfile and the branch's: the versions, and whether every visitor is asked again
 * (CONSENT_VERSION moved between the two commits); `reasks` is null when either cannot be read.
 */
export function updateSummary(
  mainLock: string,
  branchLock: string,
  versionAt: (sha: string) => number | null = consentVersionAt,
): { from: string; to: string; reasks: boolean | null } {
  const from = installedOf(mainLock)
  const to = installedOf(branchLock)
  if (!from || !to) throw new Error(`${PKG} is missing from ${from ? "the branch's" : "main's"} package-lock.json`)
  const a = from.sha ? versionAt(from.sha) : null
  const b = to.sha ? versionAt(to.sha) : null
  return { from: from.version, to: to.version, reasks: a === null || b === null ? null : a !== b }
}

/** One line for the output: whether the update asks every visitor again. */
export function reaskLine(mainLock: string, branchLock: string, versionAt: (sha: string) => number | null): string {
  const from = installedOf(mainLock)?.sha
  const to = installedOf(branchLock)?.sha
  const a = from ? versionAt(from) : null
  const b = to ? versionAt(to) : null
  if (a === null || b === null) return 'whether visitors are asked again is unknown: CONSENT_VERSION could not be read at both commits (git fetch in this astro-consent checkout)'
  return a === b ? `visitors are not asked again (CONSENT_VERSION ${a} on both)` : `EVERY VISITOR IS ASKED AGAIN: CONSENT_VERSION ${a} → ${b}`
}
