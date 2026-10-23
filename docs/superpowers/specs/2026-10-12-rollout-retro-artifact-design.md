# Rollout retro artifact: design

Sites are named by GitHub repo ID (`gh api repositories/<id>`).

Date: 2026-10-12. Status: approved design, not built.

## Purpose

Input for the Task 27 retro of the astro-consent pilot expansion. Readers are the dev team. The
page answers three questions in this order: what were we trying to do, what went wrong on the way
and how was it fixed, and what is still open before the ~180-site fleet rollout.

Not a stakeholder report and not a living tracker. It is a snapshot compiled once, republished to
the same URL if the observation checks (2026-10-15, 10-19, 10-26) add findings.

## Form

- One static HTML page published as a private Artifact. Data is a JSON array inlined in the page;
  no runtime capabilities, no fetches.
- English. Client site names appear; the artifact stays private until Jörgen chooses to share it.
- Retro discussion happens in Artifact comments.
- The page shows the date it was compiled and links every row to its source.
- Build source and data live in the gitignored `.superpowers/retro-artifact/` of this repo, not in
  tracked files: this repo is public and the data quotes the private batch log and ledger.

## Time window

2026-09-12 to the compile date. Nothing consent-related happened before 2026-09-24, so the span
09-12 to 09-24 is drawn as one segment labelled "N16 backlog (issue opened 2026-05-08)", not left
blank.

## Sections, top to bottom

### 1. Goal and status

- Goal, one sentence: every Vision Media Astro site serves a fail-closed consent banner
  (`@visionmediahq/astro-consent`); this month built the package and rehearsed the rollout on 27
  sites before the ~180-site fleet.
- Stat tiles: sites live (27 = 7 pilot + 20 expansion), releases (v1.0.0, v1.0.1, v1.0.2), rollout
  tool PRs merged (#3–#15), findings logged, open retro items. Numbers are computed from the data
  array, never typed in by hand.
- Next: observation days with dates, Task 27 retro, fleet rollout (Plan 2).

### 2. Timeline

Horizontal on desktop, vertical under 640 px. Milestones:

| Date | Milestone | Source |
|---|---|---|
| 2026-09-24 | ADR 0004 privacy and consent, draft | site-factory 47a16e9, 1f2a493 |
| 2026-10-01 | Design spec, revs 1–3 | site-factory 0076e6c, a643857, 75f4477 |
| 2026-10-02 | Package plan, revs 1–4 | site-factory d4a93f4 … d43e664 |
| 2026-10-03 | v1.0.0 | astro-consent 3c5266c |
| 2026-10-05 | 7 pilot sites merged and live-verified; v1.0.1 | site-factory 5f6fa84; astro-consent fbca91a |
| 2026-10-06 | Expansion spec and plan (20 sites + rollout tool) | site-factory e7b48f3, 4361955, a894bf4 |
| 2026-10-07 | v1.0.2 (contrast, map button) | astro-consent f26fc72 |
| 2026-10-08 | Rollout tool merged (#3); first expansion sites | astro-consent b458afa |
| 2026-10-12 | 20 of 20 merged (site 1243331215 last); tool PR #15 | astro-consent ca9b49d |
| 2026-10-15/19/26 | Observation days 3/7/14 (upcoming, dashed) | ledger |
| after 10-26 | Task 27 retro (upcoming, dashed) | ledger |

Each milestone dot shows the number of findings dated that day.

### 3. Issues and fixes log

One row per finding. Schema of each entry in the data array:

```ts
type Finding = {
  id: string;            // stable slug, e.g. "pb-map-open-link"
  date: string;          // ISO date found
  site: string | null;   // site where found; null for package/demo
  phase: 'package' | 'pilot' | 'expansion' | 'observation';
  layer: 'package' | 'rollout-tool' | 'wire-detect' | 'site' | 'infra-ops';
  symptom: string;       // what was seen, one sentence
  cause: string;         // why, one sentence
  fix: string;           // what changed, one sentence; "" when none
  fixRef: { label: string; url: string }[]; // PR, commit, release
  caughtBy: `verify-step-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}` | 'live-check' | 'screenshot'
          | 'subagent-review' | 'by-hand' | 'detect';
  status: 'fixed-package' | 'fixed-tool' | 'fixed-site-branch' | 'retro-open'
        | 'false-positive' | 'not-a-finding';
  retro: string | null;  // the retro question, if any
  source: { label: string; url?: string; path?: string; excerpt: string };
  // url when the source is on GitHub; path (repo-relative, e.g.
  // "site-factory/.superpowers/…/log.md") when it is a local-only log. At least one is set.
};
```

Display: table on desktop, cards on mobile. Filter chips for `layer` and `status` (multi-select,
counts on each chip). Rows sorted by date; a row expands to show cause, fix, retro note and the
source excerpt. The last filter selection is remembered in `localStorage` (wrapped in try/catch).

Seed inventory (the build compiles the full list from the sources; these must all be present):

- Package: `pb=` map open link went to the visitor's location (v1.0.1); banner and map buttons
  failed WCAG AA on light primaries on three pilot sites (v1.0.2); map button repeated the embed
  title (v1.0.2).
- Pilot: audit marked site 1243335919 "no services" though it has a map (pilot Finding 1); wiring by
  hand rather than by script (Finding 2); site 1277834673's CMS app on vmedia.se did not redeploy (an issue in its repo); rule
  gaps → Rulings 16–25, site 1243511314 footer links unreadable → Ruling 20 contrast check.
- Rollout tool PRs #5–#15, one finding each: stale root `engines` resync (site 1286030122, #5); SSR
  crawl hit file endpoints (#6); Cloudflare `/cdn-cgi/` links (site 1296282111, #7); load + bounded
  networkidle (#8); mobile call bar covered the banner button (site 1249159919, #9); empty dependency
  map dropped by npm (#10); sideways-scrolling page (#11); any root field npm copies may resync
  (#12); Docker build without `SITE_URL` (site 1346130035, #13); daisyUI 5 added where main had none
  (site 1243331215, #14); root scrollbar/background styles (#15).
- Site branch fixes: site 1346130035 `??` → `||` for empty `SITE_URL`; site 1249159919 banner lifted
  above the call bar; site 1270076313 banner outside the `chrome` conditional and links on 404; scoped-CSS
  footer at 1.13:1 fixed with `text-white/60`; site 1243331215 daisyUI `exclude: scrollbar` and
  reCAPTCHA loaded on focus; site 1243331215 policy section (PR #34).
- Infra/ops: Coolify had no deployment history for 7 apps → merge STOP, redeployed by hand; host
  disk full → Docker I/O errors; Docker "unable to lease content" after restart (not a finding);
  preview server dropped mid-verify (site 1223253809, site 1270076313; cause unknown); main moved mid-verify
  (security-headers rollout).
- False positives: detect's invented-map heuristic on site 1233003545 and site 1270982253.

Sources, in order of preference: `CHANGELOG.md`; `gh pr view` for astro-consent #1–#15 and the
site PRs; ledger `.superpowers/sdd/2026-10-06-astro-consent-pilot-expansion-implementation/progress.md`;
site-factory batch log `.superpowers/sdd/2026-10-06-astro-consent-pilot-expansion/log.md`;
site-factory pilot plan `docs/superpowers/plans/2026-10-04-astro-consent-live-pilot-7-sites.md`;
site-factory branch `rollout-evidence`. Links point to GitHub URLs where one exists; the ledger and
batch log are local-only (gitignored), so rows citing them show the path and the excerpt instead.

### 4. Open retro items

Every finding with a `retro` value, grouped under three headings: **package v1.1**, **rollout
tool**, **fleet process**. Each item links back to its log row. Items fixed since they were raised
(the daisyUI scrollbar, by #15) are shown struck through with the fix link.

Expected items, at least: banner bottom-offset CSS variable; reCAPTCHA not gated (registry entry or
lazy-load recipe); shared policy-section component; spam guards as registry services or a
honeypot; wire/detect blind to conditional footer rendering; wire blind to scoped-CSS footer
colours; screenshots and contrast taken during entrance animations; Docker step lacks Coolify's
build args; sample pages on large sites; detect's invented-map heuristic; pruned Coolify history
blocks the follows-main check; the site 1271984151 template's href paragraph does not fit every site; subagent
review caught what verify could not.

### 5. How it was caught

Horizontal bar chart of findings by `caughtBy`, stacked by `layer`. Built from the data array,
following the `dataviz` skill. Its caption states the retro point in one sentence, written after
the data is compiled (not assumed in advance).

## Design constraints

- Follows the `artifact-design` skill: colour tokens on `:root` with a dark mode, 16 px gutters,
  no horizontal page scroll at 360 px.
- No external scripts unless the chart needs one; inline SVG is preferred.
- Every number on the page derives from the data array.

## Checks before publishing

- Every seed-inventory item is present; every row has a `source.url` or `source.path` and, unless status is
  `retro-open`, `false-positive` or `not-a-finding`, at least one `fixRef`.
- Stat tiles match a count of the data array.
- Page checked at 360 px and 1280 px, light and dark.
- No secrets or tokens in excerpts (for example `COOLIFY_SETUP_TOKEN` is named, never valued).

## Out of scope

Shared database, live updates, stakeholder summary, Swedish translation, accept/decline rates
(they come from observation and belong in the retro itself).
