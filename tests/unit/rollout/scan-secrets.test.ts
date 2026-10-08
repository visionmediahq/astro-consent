import { describe, expect, test } from 'vitest'
import { scanSecrets } from '../../../ci/rollout/scan-secrets'

const b64 = (s: string) => Buffer.from(s).toString('base64url')
const JWT = `${b64('{"alg":"HS256","typ":"JWT"}')}.${b64('{"sub":"1234567890","name":"x"}')}.abcdefghijklmnopqrstuvwxyz012345`

describe('scanSecrets finds', () => {
  test.each([
    ['an assigned API key', 'RESEND_API_KEY=re_abc123def456ghi789'],
    ['a Google API key', "const key = 'AIzaSyD-abcdefghijklmnopqrstuvwxyz12345'"],
    ['a GitHub token', `token: ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`],
    ['a quoted secret in code', "const SECRET_TOKEN = 'abcdefgh12345678'"],
    ['a secret in YAML', 'API_KEY: abcdefgh12345678'],
    ['a Stripe live key', `sk_live_${'x9Y8z7W6'.repeat(3)}`],
    ['a private key block', '-----BEGIN PRIVATE KEY-----'],
    ['a JWT', `Authorization: Bearer ${JWT}`],
    ['a JSON-style key (quote before the colon)', '  "SMTP_PASSWORD": "hunter2hunter2",'],
    ['a JSON-style Resend key', '  "RESEND_API_KEY": "abcdefgh12345678"'],
    ['a lower-case name in code', "const config = { apiKey: 'abcdefgh12345678' }"],
    ['a camel-case name in JSON', '{ "accessToken": "abcdefgh12345678" }'],
    ['a lower-case assignment', 'const secret = "abcdefgh12345678"'],
  ])('%s', (_name, line) => {
    const hits = scanSecrets(`first line\n${line}\nlast line`)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.line).toBe(2)
    expect(hits[0]!.match.length).toBeGreaterThan(0)
  })
})

describe('scanSecrets ignores', () => {
  test.each([
    ['an empty assignment', 'PUBLIC_RECAPTCHA_SITE_KEY='],
    ['a colour token', '--color-primary: oklch(55% 0.2 250);'],
    ['a token count', 'input_tokens: 1645'],
    ['a key read from the environment', 'const RECAPTCHA_SITE_KEY = import.meta.env.PUBLIC_RECAPTCHA_SITE_KEY as string'],
    ['a key read from process.env', 'const RESEND_API_KEY = process.env.RESEND_API_KEY'],
    ['a typed parameter', 'execute: (key: string, opts: { action: string }) => Promise<string>'],
    ['a typed property', 'secretKey: Promise<string>'],
    ['a value computed in code', 'const recaptchaToken = await getRecaptchaToken();'],
    ['an empty JSON value', '"apiKey": ""'],
    ['a lower-case name read from the environment', 'apiKey: import.meta.env.PUBLIC_API_KEY'],
    [
      'an Umami website id',
      '<script defer src="https://cloud.umami.is/script.js" data-website-id="3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"></script>',
    ],
  ])('%s', (_name, line) => {
    expect(scanSecrets(line)).toEqual([])
  })
})
