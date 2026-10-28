// Shared shapes for the rollout tool: detect produces a Report, wire turns it into a WirePlan,
// verify returns a VerifyResult, and the pool scan and selection work on PoolRow and Selection.
import type { ServiceSlug } from '../../src/services'
import type { DaisyuiPlugin } from './lib/daisyui'
import type { SentryCdn } from './lib/sentry'
import type { ToolVersion } from './lib/tool-version'

export type Classification = 'consent' | 'notice' | 'needs-human'

export type SrcKind = 'literal' | 'expression' | 'data-file' | 'unresolved'

export interface IframeInfo {
  file: string
  /** The iframe element itself, where wire splices. */
  start: number
  end: number
  srcKind: SrcKind
  /**
   * The resolved src. Null when unresolved, and also for a resolved `srcKind: 'expression'` whose
   * value comes from a component prop (then `callSites` holds the value at each call site) or from a
   * template literal known only up to its query (then host and service come from that start).
   */
  src: string | null
  dataPath?: string
  /** When src is a component prop: where the component is used and what each use passes. */
  callSites?: { file: string; src: string | null }[]
  /**
   * For `srcKind: 'unresolved'` these two are descriptive hints only, taken from literals the
   * src could be (or none at all). They must never be used to decide wiring.
   */
  host: string | null
  service: ServiceSlug | null
  title: string | null
  classes: string | null
  height: string | null
  style: string | null
}

/** An Elfsight widget: the platform script and the `elfsight-app-<uuid>` div it fills. */
export interface WidgetInfo {
  file: string
  /** The div, where wire splices. */
  start: number
  end: number
  service: 'elfsight'
  /** The loader URL of the recognised script. */
  script: string
  /** The script element, which wire removes. */
  scriptAt: { start: number; end: number }
  /** Pages that render this widget. */
  pages: string[]
}

export interface FooterInfo {
  file: string
  start: number
  end: number
  kind: 'layout' | 'component' | 'page'
  textClass: string | null
  /**
   * How the end of the footer's last-child chain is aligned: 'left' for an explicit split or
   * start-aligned row, 'centred' for `text-center`/`justify-center`, 'unknown' when the chain has
   * no alignment utility (e.g. a footer aligned by its own CSS).
   */
  alignment: 'centred' | 'left' | 'unknown'
  /** alignment === 'centred'. */
  centred: boolean
}

/**
 * How the site loads Google Fonts. `wire` means exactly one literal css2 URL, loaded only in the
 * ways the tool recognises, so every location can be removed and the faces self-hosted.
 * `self-hosted`: no Google Fonts reference, but local font files, @font-face, @fontsource or the
 * Astro `fonts` config. `none`: neither. `needs-human`: anything else, with `reasons`.
 */
export type FontsStatus = 'none' | 'self-hosted' | 'wire' | 'needs-human'

export interface FontLocation {
  file: string
  /**
   * link: `<link rel="stylesheet">`; preload: `<link rel="preload" as="style">`; preconnect: also
   * dns-prefetch; noscript: a whole `<noscript>` holding only such links; const: the frontmatter
   * `const` statement whose string is used only as their href; import: a CSS `@import` statement.
   */
  kind: 'link' | 'preconnect' | 'preload' | 'noscript' | 'const' | 'import'
  /** The element or statement, where wire splices. */
  start: number
  end: number
}

export interface FontCsp {
  file: string
  /** meta: a `<meta http-equiv="Content-Security-Policy">` element; headers: the CSP line of a `_headers` file; module: a CSP string literal in a .ts/.js module. */
  kind: 'meta' | 'headers' | 'module'
  start: number
  end: number
}

export interface FontsInfo {
  status: FontsStatus
  /** The css2 URL to self-host (`&amp;` decoded; several joined by mergeCss2); null unless status is `wire`. */
  url: string | null
  /** Every distinct Google Fonts stylesheet URL found, in file order, whatever the status. */
  urls: string[]
  locations: FontLocation[]
  /** CSPs that mention fonts.googleapis.com or fonts.gstatic.com, whatever the status. */
  csp: FontCsp[]
  /** Why the site is `needs-human`; empty otherwise. */
  reasons: string[]
}

/**
 * How the site loads Sentry's browser bundle for GlitchTip error reporting (#93). `wire`: every
 * load from a CDN is one the tool can point at a self-hosted copy (`loaders`). `self-hosted`: no
 * CDN, and a layout loads a local copy. `none`: neither. `needs-human`: anything else, with `reasons`.
 */
export type SentryStatus = 'none' | 'self-hosted' | 'wire' | 'needs-human'

export interface SentryLoader {
  file: string
  /** 1-based line of the URL. */
  line: number
  cdn: SentryCdn
  /** The version in the URL as written: `8` (jsDelivr's floating major) or `8.55.0`. */
  version: string
  url: string
  /** element: `<script src="…">`; script: `x.src = '…'` in an inline script that adds the element itself. */
  kind: 'element' | 'script'
  /** The URL inside its quotes, where wire writes the local src. */
  src: { start: number; end: number }
  /**
   * What only made sense for the CDN, cut by wire: the integrity and crossorigin attributes (with
   * the whitespace before each), or the `x.integrity = …` and `x.crossOrigin = …` lines.
   */
  cuts: { start: number; end: number; what: string }[]
  /**
   * An element with `async` or `defer` whose `Sentry.init` runs in an inline script at once (not on
   * the bundle's onload, the window's load, or, for defer, DOMContentLoaded): the init runs before
   * the bundle and error reporting stays off even with a DSN. Reported, not changed (#93 follow-up).
   */
  initBeforeBundle: boolean
}

/** A `<link rel="preconnect|dns-prefetch">` to a Sentry CDN host, cut with the loads (review of #126). */
export interface SentryHint {
  file: string
  line: number
  host: string
  rel: string
  /** The element, as whole lines when it has its lines to itself. */
  start: number
  end: number
}

export interface SentryInfo {
  status: SentryStatus
  loaders: SentryLoader[]
  /** Local srcs a `<script>` loads Sentry from (`/js/sentry-8.55.0.min.js`), whatever the status. */
  selfHosted: string[]
  /** Why the site is `needs-human`; empty otherwise. */
  reasons: string[]
  /** Resource hints to the CDNs that go with the loads (status `wire`). */
  hints: SentryHint[]
}

/**
 * Self-hosting the Sentry bundle: the text edits (offsets into the files as detect read them) and
 * the bundle's bytes, or only refusals.
 */
export type SentryPlan =
  | { ok: true; edits: Edit[]; file: { path: string; bytes: Uint8Array }; notes: string[] }
  | { ok: false; refusals: Refusal[] }

export interface Report {
  site: string
  domains: string[]
  astro: { major: number; output: 'static' | 'server' }
  config: { path: string; hasIntegrations: boolean; hasTailwindVite: boolean; isDefineConfigObject: boolean }
  css: {
    entry: string | null
    tailwindMajor: number | null
    daisyuiMajor: number | null
    primaries: string[]
    /** The `@plugin "daisyui"` block (#101); absent in reports written before it was read. */
    daisyui?: DaisyuiPlugin
  }
  layouts: { file: string; pages: string[]; footerRef: { name: string; start: number } | null }[]
  footers: FooterInfo[]
  footerless: string[]
  policyPage: string | null
  iframes: IframeInfo[]
  trackers: string[]
  banners: string[]
  recaptcha: boolean
  inventedMaps: string[]
  alreadyWired: string[]
  /** Every service the site embeds, sorted: see `servicesOf`. */
  services: ServiceSlug[]
  widgets: WidgetInfo[]
  /**
   * Google Fonts, separate from the banner rollout: it never changes `classification` or
   * `reasons`. Missing in reports stored before fonts detection; detect always sets it.
   */
  fonts?: FontsInfo
  /**
   * Sentry's browser bundle (#93). A `needs-human` status is also a classification reason, and a
   * `wire` one keeps its CDN out of the script-host reasons. Missing in reports stored before it.
   */
  sentry?: SentryInfo
  classification: Classification
  reasons: string[]
  /** The tool commit that ran detect (runDetect sets it; detect() itself is pure). */
  tool?: ToolVersion
}

export interface Edit {
  file: string
  start: number
  end: number
  text: string
  target: string
}

export interface Refusal {
  file: string
  target: string
  reason: string
}

export type WirePlan =
  | { ok: true; edits: Edit[]; newFiles: { path: string; text: string }[]; skipped: string[] }
  | { ok: false; refusals: Refusal[] }

/**
 * Self-hosting a site's Google Fonts: text edits (offsets into the files as detect read them), new
 * text files (fonts.css, licences) and the woff2 files, or only refusals.
 */
export type FontsPlan =
  | {
      ok: true
      url: string
      edits: Edit[]
      newFiles: { path: string; text: string }[]
      fontFiles: { path: string; bytes: Uint8Array }[]
      /** One line each: subsets kept and left out, files, bytes. */
      notes: string[]
    }
  | { ok: false; refusals: Refusal[] }

export interface StepResult {
  step: number
  name: string
  pass: boolean
  /** Not run in this mode (verify --demo skips 1, 2 and 8); pass is then true. */
  skipped?: boolean
  evidence: string
}

export interface VerifyResult {
  pass: boolean
  /** The commit verified (HEAD after the push); null in demo mode. pr only trusts a run of the current HEAD. */
  sha: string | null
  steps: StepResult[]
  /** Main's preview restarted mid-step after it stopped answering (#20), one line each. */
  restarts?: string[]
  /** The tool commit that ran this verify; missing in files stored before it was recorded. */
  tool?: ToolVersion
}

export interface PoolRow {
  repo: string
  domains: string[]
  report: Report | null
  error?: string
}

export interface Selection {
  repo: string
  stratum: 'consent' | 'notice'
  how: 'random' | 'variety'
  rank?: number
  gap?: string
  replaced?: { repo: string; reason: string }[]
}
