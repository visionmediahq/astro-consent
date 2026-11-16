# Rollout checks own their verdicts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each `ci/rollout/checks/*` module turns its own raw rows into a verdict (`{ pass, lines }`). verify, its docker step and live only choose which checks run against which URL, and live gains verify's PrivacyLinks rule.

**Architecture:** Each check module gets a pure `judge…` function next to its browser measurement. Comparisons against main take main's result as input. `LiveChecks` becomes a `Pick` of `Checks`, so one test fake serves verify and live.

**Tech Stack:** TypeScript (strict), Vitest, Playwright (browser side, unchanged), tsx.

**Spec:** GitHub issue #157 (decisions from the 2026-11-16 design session; PR 2 is #158 and is out of scope here).

## Global Constraints

- TypeScript only, strict. No `.js`/`.mjs`.
- **verify evidence is byte-identical.** No expected evidence string in `tests/unit/rollout/verify*.test.ts` may change. If one has to, the task is wrong.
- **live evidence changes only in the ways the spec names:**
  - consent-path lines gain `filter=… (…)`;
  - the contrast check requires banner and PrivacyLinks rows per page (CMS admin pages exempt), so the single `no banner button measured` line becomes per-page lines;
  - the no-banner registry note becomes per page.
- These markers stay as they are, because `rollout-status.py` (ops repo) reads them: a line ending in `FAIL`, `FAIL (`, `UNKNOWN`, and the machine-failure lines (`net::ERR_…`, `check threw:`).
- Client sites are named by numeric repo ID only, never by domain (public repo).
- No change to `src/`, to the browser measurement code (`MEASURE` strings, `check…` functions' row contents), or to which checks run in which flow.
- The CLAUDE.md package rules still hold: no `prepare`/`build`-style scripts.

## Review Focus

1. **CMS admin pages on live:** `/admin/…` gets no banner and no PrivacyLinks, and must pass. Pinned in Task 4.
2. **Trailing-slash paths:** a contrast row for `/om/` counts for page `/om`. Pinned in Task 4.
3. **The 404 page on live:** `/finns-inte-…` expects a banner on live, as it does in verify. With the new rule it also needs a PrivacyLinks row. This is intended (verify already requires it), but it is the most likely red on real sites. Watch it in the Task 7 re-verify.
4. **Docker step with no banner on main:** main's own registry requests must be noted, not failed, exactly as in step 3. Pinned in Task 2.
5. **Fewer consent-path results than embed pages:** must FAIL with `N results for M pages with an embed`, in live too (live had no count check). Pinned in Task 3.

## File Structure

| File | Change |
|---|---|
| `ci/rollout/checks/verdict.ts` | **Create.** `Verdict` type, `allOf`, `indent` |
| `ci/rollout/checks/pages.ts` | Gains `normPath` (moved from verify.ts `norm`) |
| `ci/rollout/checks/requests.ts` | `RequestResult.expected`, `requestOk`, `judgeRequests` |
| `ci/rollout/checks/consent-paths.ts` | `judgeConsentPaths` |
| `ci/rollout/checks/contrast.ts` | `judgeContrast` |
| `ci/rollout/checks/fonts.ts` | `judgeFontsPages` |
| `ci/rollout/checks/clip.ts`, `root-styles.ts`, `embed-size.ts` | `judgeClip`, `judgeRootStyles`, `judgeEmbedHeights` |
| `ci/rollout/verify.ts` | Steps 3, 4, 5, 7, 8 and docker call the judges; `mainsOwn`, `consentPathLines`, inline verdicts go |
| `ci/rollout/live.ts` | `LiveChecks` = `Pick<Checks,…>` & live-only; `checkDomain` and `fontsLines` call the judges |
| `tests/unit/rollout/fake-checks.ts` | **Create.** The one fake for `Checks` and `LiveChecks` |
| `tests/unit/rollout/verdicts.test.ts` | **Create.** Tests for every judge |
| `tests/unit/rollout/{verify,verify-fonts,verify-update,verify-sentry,live,live-fonts}.test.ts` | Use the shared fake |
| `GLOSSARY.md` | **Create.** Check, Verdict, Deployed site, Step, Flow |
| `CLAUDE.md` | One line pointing at GLOSSARY.md |

---

### Task 1: Verdict type, one shared fake, glossary

No behaviour change. After this task, every later task edits one fake, not four.

**Files:**
- Create: `ci/rollout/checks/verdict.ts`, `tests/unit/rollout/fake-checks.ts`, `GLOSSARY.md`
- Modify:
  - `ci/rollout/checks/pages.ts`: add `normPath`.
  - `ci/rollout/verify.ts:93-112`: `Checks`. Make `consentPaths`'s `opts` optional. Replace `norm` (line 151) with an import of `normPath`.
  - `ci/rollout/live.ts:81-92`: `LiveChecks`.
  - `CLAUDE.md`
  - the six test files above.

**Interfaces:**
- Produces:
  - `verdict.ts`:
    - `export interface Verdict { pass: boolean; lines: string[] }`
    - `export function allOf(...vs: Verdict[]): Verdict`: pass when every input passes (and when there are none); lines concatenated in order.
    - `export function indent(v: Verdict, prefix: string): Verdict`: every line prefixed.
  - `pages.ts`: `export const normPath = (path: string): string`, the same body as verify's `norm`.
  - `live.ts`: `export type LiveChecks = Pick<Checks, 'embedPages' | 'requests' | 'consentPaths' | 'contrast' | 'fonts' | 'close'> & { pages(base: string): Promise<string[]>; sentryBundle(url: string): Promise<{ status: number; body: Uint8Array }> }`
  - `fake-checks.ts`: `export function fakeChecks(over?: Partial<Checks & LiveChecks>): { checks: Checks & LiveChecks; calls: CheckCall[] }`
    - `export interface CheckCall { what: keyof Checks | 'sentryBundle'; base: string; paths: string[]; opts?: unknown }`
    - The defaults are the green answers verify.test.ts builds today (verify.test.ts:95-145).
    - Default contrast rows: both `banner` and `links` per path.
    - Default `requests` answer: every path `ok`, with no main/branch split. Tests that need a red main override `requests`.

- [ ] **Step 1: Write `tests/unit/rollout/verdicts.test.ts` with the first tests**
  - `allOf()` → `{ pass: true, lines: [] }`.
  - `allOf({pass:true,lines:['a']},{pass:false,lines:['b']})` → `{ pass: false, lines: ['a','b'] }`.
  - `indent({pass:true,lines:['x']}, '  ')` → `lines: ['  x']`.
  - `normPath('/om/')` → `'/om'`; `normPath('/')` → `'/'`.
- [ ] **Step 2:** `npx vitest run tests/unit/rollout/verdicts.test.ts`. Expected: FAIL, the module is not found.
- [ ] **Step 3:** Implement `verdict.ts` and `normPath`. Swap `norm` in verify.ts for `normPath`.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5: Replace the fakes.** Create `fake-checks.ts`. Replace the inline `Checks` fakes in verify.test.ts, verify-fonts.test.ts, verify-update.test.ts and verify-sentry.test.ts (drop the `as unknown as Checks` cast), and the `LiveChecks` fakes in live.test.ts and live-fonts.test.ts. Assertions on the old `called` set become assertions on `calls` (`calls.some((c) => c.what === 'requests' && c.base.includes(':4398'))`). The live fakes' answer queues (live.test.ts:88-100) become `over.requests`. Change the `LiveChecks` type in live.ts.
- [ ] **Step 6:** `npm run check && npm test`. Expected: all green, and no expected evidence string changed (`git diff --stat tests/` shows only fake and assertion edits).
- [ ] **Step 7: Glossary.** Write `GLOSSARY.md` with five terms, one or two sentences each:
  - **Check:** measures one property of a served site and decides it, giving a Verdict; may take main's result as input.
  - **Verdict:** a check's `{ pass, lines }`.
  - **Deployed site:** a site built and served as Coolify would, by local preview or Docker (module comes in #158).
  - **Step:** one numbered verify step; runs checks against deployed sites.
  - **Flow:** banner, fonts, sentry or update (`flows.ts`).

  Add to CLAUDE.md, under "Layout": `GLOSSARY.md` holds the domain terms; use them in code and reviews.
- [ ] **Step 8: Commit.**
  ```bash
  git add ci/rollout/checks/verdict.ts ci/rollout/checks/pages.ts ci/rollout/verify.ts ci/rollout/live.ts tests/unit/rollout GLOSSARY.md CLAUDE.md
  git commit -m "rollout: one Checks fake for verify and live, Verdict type, glossary (#157)"
  ```
  Then `git push -u origin checks-own-verdicts`.

### Task 2: Requests verdict

**Files:**
- Modify:
  - `ci/rollout/checks/requests.ts:245-311`
  - `ci/rollout/verify.ts:567-575` (`mainsOwn` goes), `:768-775`, `:915-917`
  - `ci/rollout/live.ts:218-222`
- Test: `tests/unit/rollout/verdicts.test.ts`

**Interfaces:**
- Consumes: `Verdict` (Task 1).
- Produces:
  - `RequestResult.expected: boolean`: what `expectBanner(path)` said. `checkRequests` sets it.
  - `export function requestOk(r: Omit<RequestResult, 'ok'>): boolean`: `banner === expected && banners <= 1 && blocked.length === 0 && errors.length === 0`. `checkRequests` uses it for `ok`.
  - `export interface SiteOwn { of: (path: string) => ReadonlySet<string> | 'all'; note: (path: string, count: number) => string }`
  - `export function judgeRequests(results: RequestResult[], own?: SiteOwn): Verdict & { results: RequestResult[] }`
    - With `own`: drop each row's blocked URLs that `own.of(path)` holds (all of them for `'all'`). Push `own.note(path, dropped)` for each row that lost any. Recompute `ok` with `requestOk`.
    - `lines` = those notes, then `formatRequests(results)`.
    - `pass` = `results.length > 0 && every ok`.
    - `results` = the filtered rows. Step 3's detect-miss logic keeps using the unfiltered rows, as today.

- [ ] **Step 1: Failing tests in verdicts.test.ts.**
  - `judgeRequests([ok('/')])` → `pass: true`, lines equal `formatRequests([ok('/')])`.
  - `judgeRequests([])` → `pass: false`.
  - A row with `blocked: ['https://www.google.com/maps/embed?pb=x']` and `own.of = () => new Set([that URL])`:
    - `pass: true`;
    - the first line is `own.note('/', 1)`;
    - `results[0].blocked` is `[]`.
  - The same row with `own.of = () => 'all'` → `pass: true`.
  - An own set holding a different URL → `pass: false`, last-but-one line ends in `FAIL`.
- [ ] **Step 2:** Run. Expected: FAIL, `judgeRequests` is not exported.
- [ ] **Step 3: Implement** `requestOk` and `judgeRequests`, and add `expected` to `checkRequests`' rows. In verify:
  - **Step 3 and the docker step** call `judgeRequests(results, bannerOnMain ? undefined : { of: (p) => mainBlocked.get(normPath(p)) ?? new Set(), note: (p, n) => \`${p}: ${n} registry request(s) main makes too (no banner on main): noted, not ${commitName}'s\` })`. They keep their headers (`branch:`, `step 3 against the container:`) and indentation.
  - **Live, banner flow:** `judgeRequests(results)`.
  - **Live, without the banner:** `own: { of: () => 'all', note: (p, n) => \`${p}: ${n} registry request(s) the site makes itself (no banner yet): noted, not checked\` }`. This replaces the domain-wide note and the `banners === 0` special case; `expected: false` now covers it.
- [ ] **Step 4: Pin Review Focus 4.** In verify-fonts.test.ts, next to the existing no-banner-on-main test (line ~375): the same fake with a non-demo docker run. Assert the docker evidence holds `step 3 against the container:` and the `main makes too` note, and that the step passes.
- [ ] **Step 5:** `npm run check && npm test`. Expected: green. The verify evidence assertions are unchanged; live.test.ts gets the new per-page note.
- [ ] **Step 6:** Commit `rollout checks: requests own their verdict (#157)` and push.

### Task 3: Consent-paths verdict

**Files:**
- Modify:
  - `ci/rollout/checks/consent-paths.ts`
  - `ci/rollout/verify.ts:583-597` (`consentPathLines` goes), `:791`, `:919-922`
  - `ci/rollout/live.ts:223-233`

**Interfaces:**
- Produces: `export function judgeConsentPaths(results: ConsentPathResult[], expected: string[]): Verdict`. The body is verify's `consentPathLines` moved, with `expected` as `mapPages`. The wording is unchanged, including `filter=`.

- [ ] **Step 1: Failing tests.**
  - All four flags true and `filterKept: null` → `pass: true`, and the line contains `filter=not asserted (none)` and ends `ok`.
  - `filterKept: false` → `pass: false`, and the line ends `FAIL`.
  - One result for `['/a','/b']` → `pass: false`, and the first line is `1 results for 2 pages with an embed`. This pins Review Focus 5.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** verify's step 4 and docker step call it. live calls `indent(judgeConsentPaths(results, mapPages), '  ')`.
- [ ] **Step 4:** In live.test.ts, update the consent-path line expectation to the new wording with `filter=`. Add a live test where `consentPaths` returns one result for two embed pages: status `stop`, and the evidence holds `1 results for 2 pages with an embed`.
- [ ] **Step 5:** `npm run check && npm test`. Expected: green.
- [ ] **Step 6:** Commit `rollout checks: consent paths own their verdict; live checks the count and prints filter= (#157)` and push.

### Task 4: Contrast verdict (the live PrivacyLinks fix)

**Files:**
- Modify:
  - `ci/rollout/checks/contrast.ts`
  - `ci/rollout/verify.ts:848-861`
  - `ci/rollout/live.ts:234-238`

**Interfaces:**
- Produces: `export function judgeContrast(rows: ContrastRow[], paths: string[], expectBanner: (path: string) => boolean): Verdict`.
  - `lines` = `rows.map(formatContrast)`, then one line per missing row:
    - `${p}: no banner button measured`;
    - `${p}: no PrivacyLinks text measured`, skipped for `isCmsAdminRoute(p)`.
  - Rows match pages by `normPath`.
  - `pass` = nothing missing and every row ok.

- [ ] **Step 1: Failing tests.**
  - Rows for `/` with banner and links, `paths ['/']` → `pass: true`.
  - Only a banner row for `/` → `pass: false`, last line `/: no PrivacyLinks text measured`.
  - Rows for `/om/` (both kinds) with `paths ['/om']` → `pass: true`. Pins Review Focus 2.
  - `paths ['/', '/admin/']`, rows only for `/`, and `expectBanner = (p) => !isCmsAdminRoute(p)` → `pass: true`. Pins Review Focus 1.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - verify's contrast step returns `judgeContrast(rows, paths, expectBanner)`.
  - live: `indent(judgeContrast(rows, paths, expectBanner), '  ')`, using live's `expectBanner` (live.ts:143). The global `no banner button measured` line goes.
- [ ] **Step 4: The bug test, in live.test.ts.** A domain whose `contrast` fake returns only banner rows:
  - status `stop`;
  - the evidence holds `  /kontakt: no PrivacyLinks text measured`.
- [ ] **Step 5:** `npm run check && npm test`. Expected: green. The live-fonts.test.ts default contrast rows now come from the shared fake (both kinds).
- [ ] **Step 6:** Commit `rollout live: every banner page needs PrivacyLinks, as in verify; contrast owns its verdict (#157)` and push.

### Task 5: Fonts verdict

**Files:**
- Modify:
  - `ci/rollout/checks/fonts.ts`
  - `ci/rollout/verify.ts:881-885`, `:924-929`
  - `ci/rollout/live.ts:204-208`

**Interfaces:**
- Produces: `export function judgeFontsPages(pages: FontsPage[], declared: DeclaredFace[]): Verdict`.
  - `lines` = each page's `judgeFontsPage(...).lines`.
  - `pass` = `pages.length > 0` and every page ok.
  - Callers still prepend `fontsCheckPaths(paths).lines`. The `dist/` mentions and character coverage stay in verify's step 8: they read the build, not a served page.

- [ ] **Step 1: Failing tests.**
  - `judgeFontsPages([], faces)` → `pass: false`.
  - Two clean pages → `pass: true`, lines equal the two pages' `judgeFontsPage` lines.
  - A page with a Google request → `pass: false`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** and switch the three callers: verify step 8 (b, c), the docker step and live's `fontsLines`. Each keeps its own header line and indentation.
- [ ] **Step 4:** `npm run check && npm test`. Expected: green, with no evidence change in verify-fonts or live-fonts.
- [ ] **Step 5:** Commit `rollout checks: fonts pages own their verdict (#157)` and push.

### Task 6: Step 5 compares in the check modules

**Files:**
- Modify:
  - `ci/rollout/checks/clip.ts`, `root-styles.ts`, `embed-size.ts`
  - `ci/rollout/verify.ts:794-846`

**Interfaces:**
- Produces:
  - `export const widePaths = (rows: ClipResult[]): string[]`: distinct paths that have a clipped `page` row.
  - `export function judgeClip(rows: ClipResult[], mainPageWidths?: ReadonlyMap<string, number>): Verdict`
    - Keys are `${path} ${width}`.
    - Must not mutate `rows`: today's code sets `r.clipped = false`.
    - Lines are verify's lines 820-843 exactly, plus `no banner or embed button was measured` when there is no `button` row.
  - `export function judgeRootStyles(main: RootStyles | null, branch: RootStyles | null): Verdict`
    - `main` null → `root styles: not compared (no main)`, pass.
    - Otherwise `same as main` or the `differ from main:` lines; pass when there is no difference.
  - `export function judgeEmbedHeights(boxes: { main: EmbedBox[]; branch: EmbedBox[] } | null, embedPages: string[]): Verdict`
    - `null` with embed pages → `embed heights: not compared (no main)`, pass.
    - `null` without embed pages → no lines, pass.
    - Otherwise the `compareEmbedHeights` row lines and notes; pass when every row is ok.
  - verify step 5 = `allOf(judgeClip(...), judgeRootStyles(...), judgeEmbedHeights(...))`, with main's preview lines first. Line order must match today's: the clip rows, the measured line, root styles, then heights.

- [ ] **Step 1: Failing tests.**
  - judgeClip:
    - A clipped `page` row `/ 360` with `w: 400` and main width 400 → `pass: true`, the line ends `(main 400px too: not the banner)`, and the input row's `clipped` is still `true`.
    - The same row with main width 380 → `pass: false`, `CLIPPED … (main 380px)`.
    - No `button` rows → the line `no banner or embed button was measured` and `pass: false`.
  - judgeRootStyles:
    - `(null, {...})` → pass with the `not compared` line.
    - A differing value → `pass: false`.
  - judgeEmbedHeights: `(null, ['/karta'])` → pass with the `not compared` line.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** and switch verify's step 5 to it.
- [ ] **Step 4:** `npm run check && npm test`. Expected: green, with no verify evidence change (verify.test.ts's step 5 tests unchanged).
- [ ] **Step 5:** Commit `rollout checks: clip, root styles and embed heights judge against main in their modules (#157)` and push.

### Task 7: Proof and PR

- [ ] **Step 1: Leftover-verdict scan.**
  ```bash
  grep -nE "visaLoadsOnlyClicked &&|\.ok\)|judgeFontsPage\(|\.kind === 'links'" ci/rollout/verify.ts ci/rollout/live.ts
  ```
  Expected: no hit left that decides pass or fail. A row-level `.ok` read inside a judge call's arguments is fine.
- [ ] **Step 2: Local run.**
  ```bash
  npm run check && npm test && npm run demo:build -- consent
  npx tsx ci/rollout/run.ts verify --demo demo/dist-consent
  npx tsx tests/unit/rollout/checks-fixtures.demo.ts
  npx tsx tests/unit/rollout/fonts-fixtures.demo.ts
  npx tsx tests/unit/rollout/checks.demo.ts
  ```
  Expected: verify passes, and every fixture run exits 0.
- [ ] **Step 3: Full CI on the branch.** The `rollout` job does not run on PRs, so start it by hand:
  ```bash
  gh workflow run ci.yml --ref checks-own-verdicts
  ```
  Then `gh run watch`. Expected: unit, build, e2e, rollout and pack-install all green.
- [ ] **Step 4: Re-verify two real sites.**
  - Pick two client sites whose `consent-banner` PR is merged and that have clones under `~/sites/consent-rollout`.
  - On each, run `npx tsx ci/rollout/run.ts live <site dir> post-merge` (no `--sha`: a rerun of an already deployed site) with the tool at `main`, then again at this branch. The output folders must not overwrite each other; copy `.rollout/` aside between runs.
  - Diff the evidence. Expected: only the named live differences (`filter=`, per-page PrivacyLinks lines, the per-page no-banner note).
  - Re-run verify's `--demo` from Step 2 at `main` too, and diff the step evidence. Expected: identical apart from timings.
  - Record each run in `~/sites/consent-rollout/local-ci.tsv` (site, pr, sha, result, date).
- [ ] **Step 5: Open the PR.**
  ```bash
  gh pr create --title "Rollout checks own their verdicts; live requires PrivacyLinks per page (#157)" --body-file <body>
  ```
  The body:
  - opens with `Closes #157`;
  - says what changed and the three live evidence differences;
  - links the manual CI run;
  - gives the two re-verify diffs, naming the sites by numeric repo ID only;
  - ends with the attribution line.

  Then `git status` to confirm everything is pushed.
