// Shared shapes for the rollout tool: detect produces a Report, wire turns it into a WirePlan,
// verify returns a VerifyResult, and the pool scan and selection work on PoolRow and Selection.
import type { ServiceSlug } from '../../src/services'

export type Classification = 'notice' | 'maps' | 'needs-human'

export type SrcKind = 'literal' | 'expression' | 'data-file' | 'unresolved'

export interface IframeInfo {
  file: string
  /** The iframe element itself, where wire splices. */
  start: number
  end: number
  srcKind: SrcKind
  /**
   * The resolved src. Null when unresolved, and also for a resolved `srcKind: 'expression'` whose
   * value comes from a component prop: then `callSites` holds the value at each call site.
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

export interface FooterInfo {
  file: string
  start: number
  end: number
  kind: 'layout' | 'component' | 'page'
  textClass: string | null
  centred: boolean
}

export interface Report {
  site: string
  domains: string[]
  astro: { major: number; output: 'static' | 'server' }
  config: { path: string; hasIntegrations: boolean; hasTailwindVite: boolean; isDefineConfigObject: boolean }
  css: { entry: string | null; tailwindMajor: number | null; daisyuiMajor: number | null; primaries: string[] }
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
  classification: Classification
  reasons: string[]
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

export interface StepResult {
  step: number
  name: string
  pass: boolean
  evidence: string
}

export interface VerifyResult {
  pass: boolean
  steps: StepResult[]
}

export interface PoolRow {
  repo: string
  domains: string[]
  report: Report | null
  error?: string
}

export interface Selection {
  repo: string
  stratum: 'maps' | 'notice'
  how: 'random' | 'variety'
  rank?: number
  gap?: string
  replaced?: { repo: string; reason: string }[]
}
