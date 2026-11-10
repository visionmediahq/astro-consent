import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AstroIntegration } from 'astro'
import { findEmbedServices, isInDir, scanError } from './scan'
import { ConfigError, parsePrivacyConfig, toConsentConfig, toPolicyConfig, type ConsentConfig, type PrivacyConfig } from './config'

const VIRTUAL_ID = 'virtual:astro-consent/config'
const RESOLVED_ID = '\0' + VIRTUAL_ID
// ConsentPolicy's controller and processor, in a module of their own so client.ts never bundles them.
const POLICY_ID = 'virtual:astro-consent/policy'
const RESOLVED_POLICY_ID = '\0' + POLICY_ID

/**
 * Reads the site's src/data/privacy.json, validates it, and serves it to server components and
 * the browser runtime through one virtual module. Injects the runtime once per page.
 */
export default function consent(): AstroIntegration {
  return {
    name: 'astro-consent',
    hooks: {
      'astro:config:setup': ({ config, command, updateConfig, injectScript, addWatchFile, logger }) => {
        const file = new URL('data/privacy.json', config.srcDir)
        addWatchFile(file)

        let raw: unknown
        try {
          raw = JSON.parse(readFileSync(file, 'utf8'))
        } catch (error) {
          throw new Error(`[astro-consent] cannot read src/data/privacy.json: ${(error as Error).message}`)
        }

        let privacy: PrivacyConfig
        try {
          privacy = parsePrivacyConfig(raw)
        } catch (error) {
          if (error instanceof ConfigError) {
            throw new Error(`[astro-consent] privacy.json → ${error.field}: ${error.message}`)
          }
          throw error
        }

        const consentConfig: ConsentConfig = toConsentConfig(privacy, config.site)
        const policyConfig = toPolicyConfig(privacy)
        if (consentConfig.logEndpoint && (!consentConfig.site || consentConfig.site === 'example.com')) {
          throw new Error(
            '[astro-consent] log_endpoint is set but Astro `site` is unset or https://example.com — set SITE_URL',
          )
        }

        const rootDir = fileURLToPath(config.root)
        const srcDir = fileURLToPath(config.srcDir)
        const scanned = new Set<string>()

        updateConfig({
          vite: {
            plugins: [
              {
                // Astro compiles .astro files before plugins added here run, so `transform` sees
                // JavaScript. The hook only tells us which file is being built; the template is
                // read from disk.
                name: 'astro-consent:scan',
                enforce: 'pre',
                transform(_code: string, id: string) {
                  const file = id.split('?')[0]!
                  if (!file.endsWith('.astro') || !isInDir(file, srcDir)) return
                  if (command === 'build' && scanned.has(file)) return
                  scanned.add(file)
                  const source = readFileSync(file, 'utf8')
                  for (const slug of findEmbedServices(source)) {
                    if (!(consentConfig.services as string[]).includes(slug)) {
                      this.error(scanError(relative(rootDir, file), slug, consentConfig.services))
                    }
                  }
                },
              },
              {
                name: 'astro-consent:config',
                resolveId(id: string) {
                  if (id === VIRTUAL_ID) return RESOLVED_ID
                  return id === POLICY_ID ? RESOLVED_POLICY_ID : undefined
                },
                load(id: string) {
                  if (id === RESOLVED_ID) return `export default ${JSON.stringify(consentConfig)}`
                  return id === RESOLVED_POLICY_ID ? `export default ${JSON.stringify(policyConfig)}` : undefined
                },
              },
            ],
          },
        })
        injectScript('page', "import '@visionmediahq/astro-consent/client'")

        const mode = consentConfig.services.length > 0 ? 'consent' : 'notice'
        logger.info(
          `mode=${mode} services=${consentConfig.services.join(',') || '-'} version=${consentConfig.consentVersion}`,
        )
      },
    },
  }
}
