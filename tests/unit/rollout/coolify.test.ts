import { describe, expect, test } from 'vitest'
import { coolifyEnv, listApps, repoName, toApp } from '../../../ci/rollout/coolify'

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
