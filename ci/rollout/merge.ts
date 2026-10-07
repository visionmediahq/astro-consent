// The merge stage (spec C4 and C5): merges a verified consent PR, then runs live post-merge.
//
//   1. The live baseline must exist (live post-merge compares console errors against it).
//   2. git fetch. If origin/main is not in HEAD (main moved since the verify), rebase onto it; if
//      HEAD is not the commit of a passing verify.json, verify again in full (verify pushes the
//      branch first). Repeated until main holds still, at most three rounds.
//   3. Record which Coolify apps follow main (Ruling 14) in .rollout/apps.json, before the merge.
//      STOP if one of them serves a host outside report.domains: it has no baseline (Ruling 36).
//   4. gh pr merge --squash --delete-branch, pinned to the verified commit; read the merge commit.
//   5. live post-merge with the merge commit: waits for the deployments, then the live checks.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type App, appsFor, type Deployment, followsMain, lastDeployed, listApps, listDeployments } from './coolify'
import { type Exec, exec as realExec, tail } from './lib/exec'
import { APPS_FILE, BASELINE_FILE, type LiveResult, live as realLive, type RecordedApps } from './live'
import { originRepo } from './pr'
import type { Report, VerifyResult } from './types'
import { verify as realVerify } from './verify'
import { BRANCH } from './wire/index'

const ROUNDS = 3

export interface MergeDeps {
  exec: Exec
  verify: (dir: string, report: Report) => Promise<VerifyResult>
  live: (dir: string, mode: 'post-merge', sha: string) => Promise<LiveResult>
  listApps: () => Promise<App[]>
  deployments: (uuid: string) => Promise<Deployment[]>
}

export interface MergeResult {
  status: 'done' | 'stop'
  reason?: string
  /** Set once the PR is merged. */
  mergeCommit?: string
  live?: LiveResult
}

const realDeps = (): MergeDeps => ({
  exec: realExec,
  verify: (dir, report) => realVerify(dir, report),
  live: (dir, mode, sha) => realLive(dir, mode, sha),
  listApps: () => listApps(),
  deployments: (uuid) => listDeployments(uuid),
})

/** Merges PR `pr` of the site checked out in `dir` (on consent-banner) and checks it live. */
export async function merge(dir: string, pr: number | string, opts: { deps?: Partial<MergeDeps> } = {}): Promise<MergeResult> {
  const deps: MergeDeps = { ...realDeps(), ...opts.deps }
  const root = resolve(dir)
  const git = (...args: string[]) => deps.exec('git', args, root)
  const gh = (...args: string[]) => deps.exec('gh', args, root)
  const stop = (reason: string, more: Partial<MergeResult> = {}): MergeResult => ({ status: 'stop', reason, ...more })

  try {
    const reportPath = join(root, '.rollout/report.json')
    if (!existsSync(reportPath)) return stop(`${reportPath} not found: run detect first`)
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report
    if (!existsSync(join(root, BASELINE_FILE))) return stop(`${BASELINE_FILE} not found: run the live baseline before the merge`)

    const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).out.trim()
    if (branch !== BRANCH) return stop(`merge runs on branch ${BRANCH}; ${root} is on ${branch || '(unknown)'}`)
    const repo = originRepo((await git('remote', 'get-url', 'origin')).out.trim())

    const view = await gh('pr', 'view', String(pr), '-R', repo, '--json', 'state,headRefName')
    if (view.code !== 0) return stop(`gh pr view ${pr} failed:\n${tail(view.out)}`)
    const state = JSON.parse(view.out) as { state: string; headRefName: string }
    if (state.state !== 'OPEN') {
      const hint = state.state === 'MERGED' ? ': if this run merged it, rerun `live <dir> post-merge --sha <merge commit>`' : ''
      return stop(`PR #${pr} is ${state.state}, not OPEN${hint}`)
    }
    if (state.headRefName !== BRANCH) return stop(`PR #${pr} is from ${state.headRefName}, not ${BRANCH}`)

    // Spec C4: if main moved, verify again in full right before the merge.
    const verifyPath = join(root, '.rollout/verify.json')
    const stored = existsSync(verifyPath) ? (JSON.parse(readFileSync(verifyPath, 'utf8')) as Partial<VerifyResult>) : null
    let verified = stored?.pass === true && stored.sha ? stored.sha : null
    let head = ''
    for (let round = 0; ; round++) {
      const fetched = await git('fetch', 'origin', 'main')
      if (fetched.code !== 0) return stop(`git fetch origin main failed:\n${tail(fetched.out)}`)
      head = (await git('rev-parse', 'HEAD')).out.trim()
      const ancestor = await git('merge-base', '--is-ancestor', 'origin/main', head)
      if (ancestor.code === 1) {
        const rebase = await git('rebase', 'origin/main')
        if (rebase.code !== 0) {
          await git('rebase', '--abort')
          return stop(`main moved and the rebase onto origin/main conflicts (aborted): resolve by hand\n${tail(rebase.out)}`)
        }
        head = (await git('rev-parse', 'HEAD')).out.trim()
      } else if (ancestor.code !== 0) {
        return stop(`git merge-base --is-ancestor failed:\n${tail(ancestor.out)}`)
      }
      if (ancestor.code === 0 && verified === head) break
      if (round + 1 >= ROUNDS) return stop(`main kept moving: ${ROUNDS} rounds of rebase and verify`)
      const result = await deps.verify(root, report)
      if (!result.pass) return stop('verify did not pass after main moved: fix and run verify again')
      head = (await git('rev-parse', 'HEAD')).out.trim()
      if (result.sha !== head) return stop(`verify ran for ${result.sha ?? '(no commit)'}, HEAD is ${head}`)
      verified = result.sha
    }

    // Ruling 14: which apps follow main, judged on main as it is right before the merge.
    const mainHead = (await git('rev-parse', 'origin/main')).out.trim()
    const recorded: RecordedApps = { head: mainHead, apps: [] }
    for (const app of appsFor(await deps.listApps(), repo.split('/')[1]!)) {
      const list = await deps.deployments(app.uuid)
      recorded.apps.push({ ...app, autoDeploy: app.autoDeploy && followsMain(list, mainHead), lastDeployed: lastDeployed(list) })
    }
    writeFileSync(join(root, APPS_FILE), `${JSON.stringify(recorded, null, 2)}\n`)
    if (!recorded.apps.some((a) => a.autoDeploy)) {
      return stop(`no Coolify app of ${repo} on main deployed ${mainHead.slice(0, 7)}: nothing would deploy the merge`)
    }
    // Ruling 36: live post-merge checks every host of these apps against the baseline, which was
    // taken for report.domains only.
    const uncovered = [...new Set(recorded.apps.filter((a) => a.autoDeploy).flatMap((a) => a.fqdns))].filter((h) => !report.domains.includes(h))
    if (uncovered.length) {
      return stop(
        `the apps that follow main also serve ${uncovered.join(', ')}, not in report.domains (${report.domains.join(', ')}), so there is no live baseline for it: run detect with every --domain, then live baseline`,
      )
    }

    const merged = await gh('pr', 'merge', String(pr), '-R', repo, '--squash', '--delete-branch', '--match-head-commit', head)
    if (merged.code !== 0) return stop(`gh pr merge ${pr} failed:\n${tail(merged.out)}`)
    const after = await gh('pr', 'view', String(pr), '-R', repo, '--json', 'mergeCommit')
    const mergeCommit = after.code === 0 ? ((JSON.parse(after.out) as { mergeCommit?: { oid?: string } | null }).mergeCommit?.oid ?? '') : ''
    if (!/^[0-9a-f]{40}$/.test(mergeCommit)) return stop(`PR #${pr} merged, but its merge commit could not be read:\n${tail(after.out)}`)

    const result = await deps.live(root, 'post-merge', mergeCommit)
    if (result.status !== 'pass') return stop(result.reason ?? `live post-merge: ${result.status}`, { mergeCommit, live: result })
    return { status: 'done', mergeCommit, live: result }
  } catch (e) {
    return stop((e as Error).message)
  }
}
