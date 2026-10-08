import { describe, expect, test } from 'vitest'
import { appsFor, type CoolifyEnv, coolifyEnv, followsMain, listApps, listDeployments, repoName, toApp, waitDeployed } from '../../../ci/rollout/coolify'

describe('repoName', () => {
  test('CASE repo url forms: every form Coolify writes names repo x', () => {
    for (const url of [
      'git@github.com:visionmediahq/x.git',
      'https://github.com/visionmediahq/x',
      'visionmediahq/x',
      'https://github.com/visionmediahq/x.git',
    ]) {
      expect(repoName(url), url).toBe('x')
    }
  })

  test('a trailing slash and upper-case owner still match', () => {
    expect(repoName('https://github.com/VisionMediaHQ/x/')).toBe('x')
  })

  test('another owner, an empty value or a non-repo string is null', () => {
    expect(repoName('someone-else/x')).toBeNull()
    expect(repoName('https://github.com/someone-else/x.git')).toBeNull()
    expect(repoName(null)).toBeNull()
    expect(repoName('')).toBeNull()
    expect(repoName('nginx:alpine')).toBeNull()
  })
})

describe('toApp', () => {
  test('maps the API fields and splits fqdn into lower-case hosts', () => {
    const app = toApp({
      uuid: 'u1',
      name: 'site',
      git_repository: 'visionmediahq/site',
      git_branch: 'main',
      fqdn: 'https://Site.se,https://www.site.se/',
    })
    expect(app).toEqual({ uuid: 'u1', name: 'site', repo: 'site', branch: 'main', fqdns: ['site.se', 'www.site.se'], autoDeploy: true })
  })

  test('a null fqdn is no hosts, a path is dropped, and an http fqdn still counts', () => {
    expect(toApp({ uuid: 'u', name: 'n', git_repository: null, git_branch: 'main', fqdn: null }).fqdns).toEqual([])
    expect(toApp({ uuid: 'u', name: 'n', git_repository: 'visionmediahq/a', git_branch: 'main', fqdn: 'http://a.b.se/x' }).fqdns).toEqual(['a.b.se'])
  })

  test('autoDeploy comes from is_auto_deploy_enabled when the API sends it', () => {
    const base = { uuid: 'u', name: 'n', git_repository: 'visionmediahq/a', git_branch: 'main', fqdn: null }
    expect(toApp({ ...base, is_auto_deploy_enabled: false }).autoDeploy).toBe(false)
    expect(toApp({ ...base, settings: { is_auto_deploy_enabled: false } }).autoDeploy).toBe(false)
  })
})

describe('coolifyEnv', () => {
  test('takes only COOLIFY_URL and COOLIFY_READ_TOKEN, unquoted, never the setup token', () => {
    const env = coolifyEnv(
      ['COOLIFY_TOKEN=nope', 'COOLIFY_SETUP_TOKEN=nope', 'COOLIFY_URL="https://c.example/"', "COOLIFY_READ_TOKEN='abc'", ''].join('\n'),
    )
    expect(env).toEqual({ url: 'https://c.example', token: 'abc' })
  })

  test('a missing line is an error that names the variable, not its value', () => {
    expect(() => coolifyEnv('COOLIFY_URL=https://c.example\n')).toThrow(/COOLIFY_READ_TOKEN/)
  })
})

describe('listApps', () => {
  test('one GET to /api/v1/applications with the bearer token, mapped to App', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const fetchStub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init })
      return new Response(
        JSON.stringify([{ uuid: 'u1', name: 's', git_repository: 'git@github.com:visionmediahq/s.git', git_branch: 'main', fqdn: 'https://s.se' }]),
        { status: 200 },
      )
    }
    const apps = await listApps({ env: { url: 'https://c.example', token: 't' }, fetch: fetchStub })
    expect(apps).toEqual([{ uuid: 'u1', name: 's', repo: 's', branch: 'main', fqdns: ['s.se'], autoDeploy: true }])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://c.example/api/v1/applications')
    expect(calls[0]!.init?.method ?? 'GET').toBe('GET')
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer t')
  })

  test('a non-2xx answer throws with the status and without the token', async () => {
    const fetchStub = async (): Promise<Response> => new Response('no', { status: 401 })
    await expect(listApps({ env: { url: 'https://c.example', token: 'tok-42' }, fetch: fetchStub })).rejects.toThrow(/401/)
    await expect(listApps({ env: { url: 'https://c.example', token: 'tok-42' }, fetch: fetchStub })).rejects.not.toThrow(/tok-42/)
  })
})

const ENV: CoolifyEnv = { url: 'https://c.example', token: 'tok-7' }
const SHA = 'a'.repeat(40)
const OLD = 'c'.repeat(40)
const dep = (id: number, commit: string, status: string, pull_request_id = 0) => ({ id, commit, status, pull_request_id })
const norm = (d: ReturnType<typeof dep>) => ({ id: d.id, commit: d.commit, status: d.status, pullRequestId: d.pull_request_id })

/** A fake clock: sleep advances now. */
function clock() {
  let t = 0
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    sleeps,
  }
}

/** Answers each GET with the next list of deployments (the last one repeats). */
function deploymentsApi(pages: ReturnType<typeof dep>[][]) {
  const urls: string[] = []
  const fetchStub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    urls.push(String(url))
    expect(init?.method ?? 'GET').toBe('GET')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok-7')
    const page = pages[Math.min(urls.length - 1, pages.length - 1)]!
    return new Response(JSON.stringify({ count: page.length, deployments: page }), { status: 200 })
  }
  return { fetch: fetchStub, urls }
}

describe('appsFor', () => {
  const raw = [
    { uuid: 'cms', name: 'CMS', git_repository: 'visionmediahq/nhrk', git_branch: 'main', fqdn: 'https://nhrk.vmedia.se', is_auto_deploy_enabled: false },
    { uuid: 'web', name: 'Website', git_repository: 'git@github.com:visionmediahq/nhrk.git', git_branch: 'main', fqdn: 'https://nhrk.se,https://www.nhrk.se' },
    { uuid: 'stg', name: 'Staging', git_repository: 'visionmediahq/nhrk', git_branch: 'staging', fqdn: 'https://stg.nhrk.se' },
    { uuid: 'oth', name: 'Other', git_repository: 'visionmediahq/nhrk-old', git_branch: 'main', fqdn: 'https://old.se' },
    { uuid: 'own', name: 'Owner', git_repository: 'someone/nhrk', git_branch: 'main', fqdn: 'https://x.se' },
  ]

  test('CASE appsFor filters branch main and repo; keeps both nhrk apps; marks autoDeploy from the field', () => {
    const apps = appsFor(raw.map(toApp), 'nhrk')
    expect(apps.map((a) => a.uuid)).toEqual(['cms', 'web'])
    expect(apps.find((a) => a.uuid === 'cms')!.autoDeploy).toBe(false)
    expect(apps.find((a) => a.uuid === 'web')!.autoDeploy).toBe(true)
    expect(apps.find((a) => a.uuid === 'web')!.fqdns).toEqual(['nhrk.se', 'www.nhrk.se'])
  })
})

describe('listDeployments', () => {
  test('GETs the application\'s deployments, newest first, preview deployments kept with their PR id', async () => {
    const api = deploymentsApi([[dep(1, OLD, 'finished'), dep(3, SHA, 'queued'), dep(2, SHA, 'finished', 12)]])
    const list = await listDeployments('web', { env: ENV, fetch: api.fetch })
    expect(api.urls).toEqual(['https://c.example/api/v1/deployments/applications/web?take=50'])
    expect(list.map((d) => d.id)).toEqual([3, 2, 1])
    expect(list[1]).toEqual({ id: 2, commit: SHA, status: 'finished', pullRequestId: 12 })
  })

  test('a non-2xx answer throws with the status and without the token', async () => {
    const fetchStub = async (): Promise<Response> => new Response('no', { status: 500 })
    await expect(listDeployments('web', { env: ENV, fetch: fetchStub })).rejects.toThrow(/500/)
    await expect(listDeployments('web', { env: ENV, fetch: fetchStub })).rejects.not.toThrow(/tok-7/)
  })
})

describe('followsMain (Ruling 14)', () => {
  test('the latest main deployment is of the current main head: the app follows main', () => {
    expect(followsMain([dep(2, SHA, 'finished'), dep(1, OLD, 'finished')].map(norm), SHA)).toBe(true)
    // still deploying the head counts too: it was triggered by the push
    expect(followsMain([dep(3, SHA, 'in_progress'), dep(1, OLD, 'finished')].map(norm), SHA)).toBe(true)
  })

  test('an app whose latest finished deployment is an older commit does not follow main', () => {
    expect(followsMain([dep(2, OLD, 'finished')].map(norm), SHA)).toBe(false)
    expect(followsMain([], SHA)).toBe(false)
    // a failed deployment of the head is not proof, nor is a preview deployment of it
    expect(followsMain([dep(3, SHA, 'failed'), dep(2, OLD, 'finished')].map(norm), SHA)).toBe(false)
    expect(followsMain([dep(3, SHA, 'finished', 9), dep(2, OLD, 'finished')].map(norm), SHA)).toBe(false)
  })
})

describe('waitDeployed', () => {
  const app = toApp({ uuid: 'web', name: 'Website', git_repository: 'visionmediahq/nhrk', git_branch: 'main', fqdn: 'https://nhrk.se' })

  test('CASE finished after 3 polls → finished, 20 s apart', async () => {
    const c = clock()
    const api = deploymentsApi([
      [dep(1, OLD, 'finished')],
      [dep(2, SHA, 'queued'), dep(1, OLD, 'finished')],
      [dep(2, SHA, 'finished'), dep(1, OLD, 'finished')],
    ])
    expect(await waitDeployed(app, SHA, { env: ENV, fetch: api.fetch, now: c.now, sleep: c.sleep })).toBe('finished')
    expect(api.urls).toHaveLength(3)
    expect(c.sleeps).toEqual([20_000, 20_000])
  })

  test('CASE failed → returned at the first poll; cancelled-by-user is cancelled', async () => {
    const c = clock()
    const api = deploymentsApi([[dep(2, SHA, 'failed')]])
    expect(await waitDeployed(app, SHA, { env: ENV, fetch: api.fetch, now: c.now, sleep: c.sleep })).toBe('failed')
    expect(api.urls).toHaveLength(1)
    expect(c.sleeps).toEqual([])
    const api2 = deploymentsApi([[dep(2, SHA, 'cancelled-by-user')]])
    expect(await waitDeployed(app, SHA, { env: ENV, fetch: api2.fetch, now: c.now, sleep: c.sleep })).toBe('cancelled')
  })

  test('a preview deployment of the same commit is not the main deployment', async () => {
    const c = clock()
    const api = deploymentsApi([[dep(5, SHA, 'failed', 3)], [dep(6, SHA, 'finished'), dep(5, SHA, 'failed', 3)]])
    expect(await waitDeployed(app, SHA, { env: ENV, fetch: api.fetch, now: c.now, sleep: c.sleep })).toBe('finished')
  })

  test('CASE no match for 15 min → timeout, never waiting past 15 min', async () => {
    const c = clock()
    const api = deploymentsApi([[dep(1, OLD, 'finished')]])
    expect(await waitDeployed(app, SHA, { env: ENV, fetch: api.fetch, now: c.now, sleep: c.sleep })).toBe('timeout')
    expect(c.now()).toBe(900_000)
    expect(api.urls).toHaveLength(46)
  })

  test('an API error during the wait is retried at the next poll', async () => {
    const c = clock()
    let n = 0
    const fetchStub = async (): Promise<Response> =>
      ++n === 1 ? new Response('bad gateway', { status: 502 }) : new Response(JSON.stringify({ deployments: [dep(2, SHA, 'finished')] }), { status: 200 })
    expect(await waitDeployed(app, SHA, { env: ENV, fetch: fetchStub, now: c.now, sleep: c.sleep })).toBe('finished')
    expect(n).toBe(2)
  })
})
