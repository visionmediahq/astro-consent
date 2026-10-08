import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface SecretHit {
  line: number
  match: string
}

// Shapes of credentials that must never land in this public repo. Public-by-design ids
// (Umami website ids, colour tokens, counters) do not match any of them.
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/, // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{24,}\b/, // Stripe live key
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack token
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, // OpenAI / Anthropic key
  /\bre_[A-Za-z0-9_]{16,}\b/, // Resend key
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  // An upper-case secret-ish name assigned a literal, quoted or not: RESEND_API_KEY=...,
  // SECRET: "...", "SMTP_PASSWORD": "..." (JSON: the quote comes before the colon).
  // A value read from the environment (import.meta.env.X, process.env.X) is code, not a secret.
  /\b[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*['"]?\s*[=:]\s*['"]?(?!import\.meta\.env\.|process\.env\.)[^\s'"]{8,}/,
  // Any other spelling (apiKey, accessToken, "secret") assigned a quoted literal. The value must
  // be quoted, so type annotations (`key: string`) and code (`token = await f()`) stay quiet.
  /\b\w*(?:key|secret|token|password|passwd)\w*['"]?\s*[=:]\s*['"][^\s'"]{8,}/i,
]

/** One hit per line at most: the first pattern that matches it. Lines are 1-based. */
export function scanSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = []
  text.split(/\r?\n/).forEach((content, i) => {
    for (const pattern of PATTERNS) {
      const m = pattern.exec(content)
      if (m) {
        hits.push({ line: i + 1, match: m[0] })
        break
      }
    }
  })
  return hits
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort()
}

/** Shows enough of a hit to find it, never the whole value. */
const redact = (match: string): string => (match.length > 12 ? `${match.slice(0, 8)}…` : match)

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dirs = process.argv.slice(2)
  if (dirs.length === 0) {
    console.error('usage: tsx ci/rollout/scan-secrets.ts <dir>...')
    process.exit(2)
  }
  let count = 0
  for (const dir of dirs) {
    for (const file of files(dir)) {
      for (const hit of scanSecrets(readFileSync(file, 'utf8'))) {
        count++
        console.log(`${relative(process.cwd(), file)}:${hit.line}: ${redact(hit.match)}`)
      }
    }
  }
  console.log(`${count} hit(s)`)
  process.exit(count === 0 ? 0 : 1)
}
