import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { lockPorts, PORT_BASE, PortsBusy, portsLockFile, rolloutPorts } from '../../../ci/rollout/lib/ports'

describe('rolloutPorts', () => {
  afterEach(() => void vi.unstubAllEnvs())

  test('unset or empty: Docker 4397, main 4398, branch 4399', () => {
    expect(PORT_BASE).toBe(4397)
    const DEFAULT = { docker: 4397, main: 4398, branch: 4399 }
    vi.stubEnv('ROLLOUT_PORT_BASE', undefined)
    expect(rolloutPorts()).toEqual(DEFAULT)
    vi.stubEnv('ROLLOUT_PORT_BASE', '')
    expect(rolloutPorts()).toEqual(DEFAULT)
  })

  test('reads ROLLOUT_PORT_BASE when not given a value', () => {
    vi.stubEnv('ROLLOUT_PORT_BASE', '5000')
    expect(rolloutPorts().branch).toBe(5002)
  })

  test('ROLLOUT_PORT_BASE moves all three, so two verifies on one machine do not share a port', () => {
    expect(rolloutPorts('4417')).toEqual({ docker: 4417, main: 4418, branch: 4419 })
  })

  test('anything but a whole port with room for three throws, naming the variable: never a silent fall back to 4397', () => {
    for (const junk of ['abc', '4417.5', '-1', '80', '1023', '65534', ' 4417x']) {
      expect(() => rolloutPorts(junk), junk).toThrow(/ROLLOUT_PORT_BASE/)
    }
    expect(rolloutPorts('1024').docker).toBe(1024)
    expect(rolloutPorts('65533').branch).toBe(65535)
  })
})

describe('lockPorts (#87: a second verify on the same ports failed late at step 3)', () => {
  const ports = rolloutPorts('4397')
  const dirs: string[] = []
  const lockDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'ports-lock-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  test('takes the lock for the base with this process id; release removes it', () => {
    const dir = lockDir()
    const release = lockPorts(dir, ports)
    expect(readFileSync(portsLockFile(dir, ports), 'utf8').trim()).toBe(String(process.pid))
    release()
    expect(existsSync(portsLockFile(dir, ports))).toBe(false)
  })

  test('a lock held by a running process: PortsBusy naming its pid, the ports and ROLLOUT_PORT_BASE; the lock is kept', () => {
    const dir = lockDir()
    writeFileSync(portsLockFile(dir, ports), `${process.ppid}\n`)
    expect(() => lockPorts(dir, ports)).toThrow(PortsBusy)
    expect(() => lockPorts(dir, ports)).toThrow(new RegExp(`process ${process.ppid}.*4397.4399.*ROLLOUT_PORT_BASE`, 's'))
    expect(readFileSync(portsLockFile(dir, ports), 'utf8').trim()).toBe(String(process.ppid))
  })

  test('a lock left by a process that is gone (a killed run) is taken over', () => {
    const dir = lockDir()
    for (const stale of ['2147483646', '', 'junk']) {
      writeFileSync(portsLockFile(dir, ports), stale)
      const release = lockPorts(dir, ports)
      expect(readFileSync(portsLockFile(dir, ports), 'utf8').trim()).toBe(String(process.pid))
      release()
    }
  })

  test('another base has its own lock', () => {
    const dir = lockDir()
    const a = lockPorts(dir, ports)
    const b = lockPorts(dir, rolloutPorts('4417'))
    a()
    b()
  })

  test('release leaves a lock another process has taken since', () => {
    const dir = lockDir()
    const release = lockPorts(dir, ports)
    writeFileSync(portsLockFile(dir, ports), `${process.ppid}\n`)
    release()
    expect(existsSync(portsLockFile(dir, ports))).toBe(true)
  })
})
