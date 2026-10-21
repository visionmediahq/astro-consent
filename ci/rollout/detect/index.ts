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

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi

/**
 * Whether a file that did not parse can hold nothing detect looks for. compiler-rs rejects some
 * markup Astro's own compiler builds (`<!-- -->` inside a `{…}` conditional: anab, fonsterdekor;
 * `\"` inside an attribute: byggk), and every detector skips the file. That is only safe for a
 * component with no iframe, document or footer markup, no `.astro` import (a call site of a
 * prop-driven embed), no URL but the SVG namespace, and only inline scripts that import nothing and
 * build no iframe. Verify builds the site with Astro either way.
 */
export function inertUnparsed(file: string, text: string): boolean {
  if (/^src\/(?:pages|layouts)\//.test(file)) return false
  if (/<(?:iframe|html|head|body|footer)\b/i.test(text) || /<[\w.]*Footer\b/.test(text)) return false
  if (/from\s+['"][^'"]+\.astro['"]/.test(text)) return false
  if ((text.match(/(?:https?:)?\/\/[^\s"'<>`)\\]+/gi) ?? []).some((u) => !u.startsWith('http://www.w3.org/'))) return false
  const scripts = [...text.matchAll(SCRIPT)]
  if ((text.match(/<script\b/gi) ?? []).length !== scripts.length) return false
  return scripts.every(([, attrs, body]) => !/\bsrc\s*=/i.test(attrs!) && !/\bimport\b|iframe|createElement/i.test(body!))
}

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
    parseErrors: [...structure.parseErrors, ...frames.parseErrors, ...scripts.parseErrors, ...widgets.parseErrors].filter(
      (e) => !inertUnparsed(e.file, files.read(e.file)),
    ),
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
