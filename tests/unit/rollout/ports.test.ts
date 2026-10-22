import { describe, expect, test } from 'vitest'
import { PORT_BASE, rolloutPorts } from '../../../ci/rollout/lib/ports'

describe('rolloutPorts', () => {
  test('unset or empty: Docker 4397, main 4398, branch 4399', () => {
    expect(PORT_BASE).toBe(4397)
    for (const env of [undefined, '']) expect(rolloutPorts(env)).toEqual({ docker: 4397, main: 4398, branch: 4399 })
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
