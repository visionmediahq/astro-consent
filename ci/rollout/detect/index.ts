// detect(): reads a site's source and returns its Report. Nothing is executed and nothing is written.
import type { Report } from '../types'
import type { SiteFiles } from '../lib/site-files'
import { aliasedAstroImports } from '../lib/site-imports'
import { classify } from './classify'
import { detectConfig } from './config'
import { detectAstroMajor, detectCss } from './css'
import { detectIframes } from './iframes'
import { detectScripts } from './scripts'
import { detectStructure } from './structure'

/** `domains` are the site's own domains: stored in the report and used to tell own iframes apart. */
export function detect(files: SiteFiles, site: string, domains: string[]): Report {
  const { output, ...config } = detectConfig(files)
  const structure = detectStructure(files)
  const frames = detectIframes(files, domains)
  const scripts = detectScripts(files)

  const findings = {
    site,
    domains,
    astro: { major: detectAstroMajor(files), output },
    config,
    css: detectCss(files),
    layouts: structure.layouts,
    footers: structure.footers,
    footerless: structure.footerless,
    policyPage: structure.policyPage,
    iframes: frames.iframes,
    trackers: scripts.trackers,
    banners: scripts.banners,
    recaptcha: scripts.recaptcha,
    inventedMaps: frames.inventedMaps,
    alreadyWired: scripts.alreadyWired,
  }
  const { classification, reasons } = classify({
    ...findings,
    parseErrors: [...structure.parseErrors, ...frames.parseErrors, ...scripts.parseErrors],
    aliasImports: aliasedAstroImports(files),
    multiFooterPages: structure.multiFooterPages,
  })
  return { ...findings, classification, reasons }
}
