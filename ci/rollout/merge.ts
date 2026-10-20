// The merge stage (spec C4 and C5): merges a verified PR of the checkout's flow (flows.ts), then runs live post-merge.
//
//   1. The live baseline must exist (live post-merge compares console errors against it).
//   2. git fetch. If origin/main is not in HEAD (main moved since the verify), rebase onto it; if
//      HEAD is not the commit of a passing verify file of the flow, verify again in full (verify pushes the
//      branch first). Repeated until main holds still, at most three rounds.
//   3. Record which Coolify apps follow main (Ruling 14) in .rollout/apps.json (per flow), before the merge.
//      STOP if one of them serves a host live baseline did not record: it has no baseline
//      (Rulings 36, 37). Detect is never re-run on the wired branch; live baseline is.
//   4. gh pr merge --squash --delete-branch, pinned to the verified commit; read the merge commit.
//   5. live post-merge with the merge commit: waits for the deployments, then the live checks.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type App, appsFor, type Deployment, followsMain, lastDeployed, listApps, listDeployments } from './coolify'
import { type Exec, exec as realExec, tail } from './lib/exec'
import type { ToolVersion } from './lib/tool-version'
import { APPS_FILE, BASELINE_FILE, BASELINE_HOSTS_FILE, type LiveResult, live as realLive, type RecordedApps } from './live'
import { originRepo } from './pr'
import { normaliseReport } from './lib/report'
import type { Report, VerifyResult } from './types'
import { VERIFY_FILE, verify as realVerify } from './verify'
import { currentFlow, flowObstacles, stateName, statePath } from './flows'

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
  /** The tool commit of the verify merged on (stored, or rerun after main moved); null when that verify file predates it. */
  tool?: ToolVersion | null
}

const realDeps = (): MergeDeps => ({
  exec: realExec,
  verify: (dir, report) => realVerify(dir, report),
  live: (dir, mode, sha) => realLive(dir, mode, sha),
  listApps: () => listApps(),
  deployments: (uuid) => listDeployments(uuid),
})

/** Merges PR `pr` of the site checked out in `dir` (on a branch of FLOWS) and checks it live. */
export async function merge(dir: string, pr: number | string, opts: { deps?: Partial<MergeDeps> } = {}): Promise<MergeResult> {
  const deps: MergeDeps = { ...realDeps(), ...opts.deps }
  const root = resolve(dir)
  const git = (...args: string[]) => deps.exec('git', args, root)
  const gh = (...args: string[]) => deps.exec('gh', args, root)
  let tool: ToolVersion | null | undefined
  const withTool = (): Partial<MergeResult> => (tool === undefined ? {} : { tool })
  const stop = (reason: string, more: Partial<MergeResult> = {}): MergeResult => ({ status: 'stop', reason, ...withTool(), ...more })

  try {
    const reportPath = join(root, '.rollout/report.json')
    if (!existsSync(reportPath)) return stop(`${reportPath} not found: run detect first`)
    const report = normaliseReport(JSON.parse(readFileSync(reportPath, 'utf8')))
    const flow = await currentFlow(deps.exec, root, 'merge')
    const BRANCH = flow.branch
    const rollout = join(root, '.rollout')
    const name = (file: string) => `.rollout/${stateName(file, BRANCH)}`
    if (!existsSync(statePath(rollout, BASELINE_FILE, BRANCH))) return stop(`${name(BASELINE_FILE)} not found: run the live baseline before the merge`)
    const hostsPath = statePath(rollout, BASELINE_HOSTS_FILE, BRANCH)
    if (!existsSync(hostsPath)) return stop(`${name(BASELINE_HOSTS_FILE)} not found: rerun \`live <dir> baseline\`, which records the hosts it baselined`)
    const baselined = (JSON.parse(readFileSync(hostsPath, 'utf8')) as { hosts?: unknown }).hosts
    if (!Array.isArray(baselined)) return stop(`${name(BASELINE_HOSTS_FILE)} has no hosts list: rerun \`live <dir> baseline\``)

    const repo = originRepo((await git('remote', 'get-url', 'origin')).out.trim())

    const view = await gh('pr', 'view', String(pr), '-R', repo, '--json', 'state,headRefName')
    if (view.code !== 0) return stop(`gh pr view ${pr} failed:\n${tail(view.out)}`)
    const state = JSON.parse(view.out) as { state: string; headRefName: string }
    if (state.state !== 'OPEN') {
      const hint = state.state === 'MERGED' ? ': if this run merged it, rerun `live <dir> post-merge --sha <merge commit>`' : ''
      return stop(`PR #${pr} is ${state.state}, not OPEN${hint}`)
    }
    if (state.headRefName !== BRANCH) return stop(`PR #${pr} is from ${state.headRefName}, not ${BRANCH}`)
    // The other flow's work on GitHub would conflict with this merge (site-factory#220).
    const obstacles = await flowObstacles(deps.exec, root, repo, flow.other)
    if (obstacles.length) return stop(`${flow.other} would conflict with ${BRANCH}: ${obstacles.join('; ')}`)

    // Spec C4: if main moved, verify again in full right before the merge.
    const verifyPath = statePath(rollout, VERIFY_FILE, BRANCH)
    const stored = existsSync(verifyPath) ? (JSON.parse(readFileSync(verifyPath, 'utf8')) as Partial<VerifyResult>) : null
    let verified = stored?.pass === true && stored.sha ? stored.sha : null
    if (verified) tool = stored?.tool ?? null
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
      tool = result.tool ?? null
    }

    // Ruling 14: which apps follow main, judged on main as it is right before the merge.
    const mainHead = (await git('rev-parse', 'origin/main')).out.trim()
    const recorded: RecordedApps = { head: mainHead, apps: [] }
    for (const app of appsFor(await deps.listApps(), repo.split('/')[1]!)) {
      const list = await deps.deployments(app.uuid)
      recorded.apps.push({ ...app, autoDeploy: app.autoDeploy && followsMain(list, mainHead), lastDeployed: lastDeployed(list) })
    }
    writeFileSync(statePath(rollout, APPS_FILE, BRANCH), `${JSON.stringify(recorded, null, 2)}\n`)
    if (!recorded.apps.some((a) => a.autoDeploy)) {
      return stop(`no Coolify app of ${repo} on main deployed ${mainHead.slice(0, 7)}: nothing would deploy the merge`)
    }
    // Rulings 36, 37: live post-merge checks every host of these apps against the baseline, so each
    // must be among the hosts live baseline recorded.
    const uncovered = [...new Set(recorded.apps.filter((a) => a.autoDeploy).flatMap((a) => a.fqdns))].filter((h) => !baselined.includes(h))
    if (uncovered.length) {
      return stop(
        `the apps that follow main serve ${uncovered.join(', ')}, which the live baseline did not record (${baselined.join(', ')}): rerun \`live <dir> baseline\` (it covers every app that follows main), then merge`,
      )
    }

    const merged = await gh('pr', 'merge', String(pr), '-R', repo, '--squash', '--delete-branch', '--match-head-commit', head)
    if (merged.code !== 0) return stop(`gh pr merge ${pr} failed:\n${tail(merged.out)}`)
    const after = await gh('pr', 'view', String(pr), '-R', repo, '--json', 'mergeCommit')
    const mergeCommit = after.code === 0 ? ((JSON.parse(after.out) as { mergeCommit?: { oid?: string } | null }).mergeCommit?.oid ?? '') : ''
    if (!/^[0-9a-f]{40}$/.test(mergeCommit)) {
      return stop(`PR #${pr} merged, but its merge commit could not be read: rerun \`live <dir> post-merge --sha <merge commit>\` with the commit from GitHub\n${tail(after.out)}`)
    }

    const result = await deps.live(root, 'post-merge', mergeCommit)
    if (result.status !== 'pass') return stop(result.reason ?? `live post-merge: ${result.status}`, { mergeCommit, live: result })
    return { status: 'done', mergeCommit, live: result, ...withTool() }
  } catch (e) {
    return stop((e as Error).message)
  }
}
