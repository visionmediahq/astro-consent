// detect(): reads a site's source and returns its Report. Nothing is executed and nothing is written.
import type { Report } from '../types'
import type { SiteFiles } from '../lib/site-files'
import { aliasedAstroImports } from '../lib/site-imports'
import { servicesOf } from '../lib/report'
import { classify } from './classify'
import { detectConfig } from './config'
import { detectAstroMajor, detectCss } from './css'
import { detectFonts } from './fonts'
import { detectIframes } from './iframes'
import { detectScripts } from './scripts'
import { detectStructure } from './structure'
import { detectWidgets } from './widgets'

/** `domains` are the site's own domains: stored in the report and used to tell own iframes apart. */
export function detect(files: SiteFiles, site: string, domains: string[]): Report {
  const { output, ...config } = detectConfig(files)
  const structure = detectStructure(files)
  const frames = detectIframes(files, domains)
  const scripts = detectScripts(files)
  const widgets = detectWidgets(files, structure.layouts)

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
    widgets: widgets.widgets,
  }
  const fonts = detectFonts(files, findings.css.entry)
  const { classification, reasons } = classify({
    ...findings,
    parseErrors: [...structure.parseErrors, ...frames.parseErrors, ...scripts.parseErrors, ...widgets.parseErrors],
    aliasImports: aliasedAstroImports(files),
    multiFooterPages: structure.multiFooterPages,
    ownHtmlPages: structure.ownHtmlPages,
    wired: widgets.wired,
    widgetReasons: widgets.reasons,
    scriptBuilt: scripts.scriptBuilt,
    scriptHosts: scripts.scriptHosts,
  })
  return { ...findings, services: servicesOf(findings, widgets.wired), fonts, classification, reasons }
}
