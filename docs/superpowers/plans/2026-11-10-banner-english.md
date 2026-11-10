# English banner, embeds and links: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The banner, embed and widget placeholders and PrivacyLinks render in English on a site's English pages, the policy link follows the language, and the rollout tool wires this on multilingual sites.

**Architecture:** Strings move behind a node-free text index (`src/text/index.ts`) with one JSON file per language; every component resolves a `Lang` from an optional `lang` prop or `Astro.currentLocale`. `privacy.json` gains `policy_urls.en`. The rollout tool detects a site's languages by route, and a new `site-language` flow edits existing tags in place, modelled on the `sentry-selfhost` flow.

**Tech Stack:** Astro 6/7 components (.astro), TypeScript strict, zod 4 (`src/config.ts` only), vitest, Playwright, the rollout tool under `ci/rollout/`.

**Spec:** `docs/superpowers/specs/2026-11-10-banner-english-design.md` (approved 2026-11-10, PR #148).

**Branch:** implement on `banner-english`, created from `banner-english-design`; one PR to `main`.

## Global Constraints

- Supported languages: `['sv', 'en']`, Swedish the default. No third language ships.
- `CONSENT_VERSION` does not change. `consent-terms.json` is not edited.
- Swedish-only sites: no new config needed and identical markup (no `lang` attribute added, same strings).
- `lang` prop type is `string`; an unsupported value resolves to `'sv'` and never throws.
- `client.ts` is not changed. `vm_consent` is language-independent.
- CLAUDE.md: browser-safe imports (components never import `src/config.ts`), every visible string in `src/text/<lang>.json`, no new npm scripts, TypeScript only, DaisyUI 5, failing test first.
- Neka and Acceptera alla (Decline and Accept all) keep identical classes in every language.
- Public repo: client sites by numeric repo ID only, never names or domains, fixtures included.
- English wording: translated from the live Swedish wording at implementation time; the owner reads it in the PR. `en.json` must mirror whatever `sv.json` holds when the branch is cut (the privacy policy work may change `notice.body` later; the parity test catches drift).
- Commit attribution per the session's git rules; push after each task.

## Review Focus

- `lang` values a site really passes: `'en-GB'`, `'EN'`, `''`, `undefined`, `'de'` → English, English, Swedish, Swedish, Swedish. Pinned in Task 1.
- A choice made on an English page holds on a Swedish page and the reverse. Pinned in Task 5 (e2e).
- `policy_urls.en` set while `policy_url` is null: English pages link to the English policy, Swedish pages show no link. Pinned in Task 4 and Task 5.
- English labels at 320 px: Decline and Accept all stay on one row with the same classes and colours. Pinned in Task 5 (e2e) and by verify's clip step on `/en` pages (Task 10).
- An Astro-i18n site with `Astro.currentLocale === 'sv'` and an English page whose layout passes no prop. Pinned in Task 1 (unit) and Task 5 (demo has no i18n config, so `currentLocale` is covered by the unit test and by Task 6 on Astro 6).

---

### Task 1: Text index and English strings

**Files:**
- Create: `src/text/index.ts`, `src/text/en.json`
- Modify: `tests/unit/text.test.ts`, `CLAUDE.md` (string rule, layout table row)
- Test: `tests/unit/text.test.ts`

**Interfaces:**
- Produces: `LANGS = ['sv', 'en'] as const`; `type Lang = (typeof LANGS)[number]`; `type Text = typeof sv` (sv.json's shape); `TEXTS: Record<Lang, Text>`; `resolveLang(prop?: string | null, currentLocale?: string | null): Lang`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/text.test.ts`, keeping the existing ones and running the content tests (`no string claims there are no cookies…`, key presence) over every language in `TEXTS`:

```ts
test('every language file has exactly the keys of sv.json, none empty', () => {
  for (const lang of LANGS) expect(keysOf(TEXTS[lang]), lang).toEqual(keysOf(TEXTS.sv))
  for (const lang of LANGS) for (const s of allStrings(TEXTS[lang])) expect(s.trim(), lang).not.toBe('')
})
test('every placeholder in a Swedish value is in the other languages too', () => {
  // for each key: the set of /\{\w+\}/g matches in sv equals the set in en
})
test('resolveLang: the prop wins, normalised; unsupported is Swedish', () => {
  expect(resolveLang('en')).toBe('en')
  expect(resolveLang('en-GB')).toBe('en')
  expect(resolveLang('EN')).toBe('en')
  expect(resolveLang('de', 'en')).toBe('sv')
  expect(resolveLang('', 'en')).toBe('en')
  expect(resolveLang(undefined, 'en')).toBe('en')
  expect(resolveLang(undefined, 'sv')).toBe('sv')
  expect(resolveLang(undefined, undefined)).toBe('sv')
  expect(resolveLang(null, 'fr')).toBe('sv')
})
```

An empty-string prop counts as not given (a site's `lang = ''` default must not force Swedish over the locale).

- [ ] **Step 2: Run** `npx vitest run tests/unit/text.test.ts` → FAIL (`src/text/index` not found).
- [ ] **Step 3: Implement** `src/text/index.ts` (imports both JSON files; normalise by lower-casing and taking the subtag before `-` or `_`) and write `src/text/en.json`. Wording guidance: "Accept all" / "Decline" / "Settings" / "Save choices" / "Back" / "Read more" / "Always on"; `links.settings` "Cookie settings", `links.policy` "Privacy policy", `region` "Cookie settings". The notice and consent bodies say the same things as the Swedish ones, no more, no less.
- [ ] **Step 4: Run** `npx vitest run tests/unit/text.test.ts` → PASS. Run `npm run check` → no errors.
- [ ] **Step 5: Update CLAUDE.md**: "Every visible string lives in `src/text/<lang>.json` (one file per language, same keys; components read them through `src/text/index.ts`)". Commit `feat(text): English strings and the language resolver`.

### Task 2: English service names and descriptions

**Files:**
- Modify: `src/services.ts`, `services.json` (via `npm run gen`), `scripts/gen-services.ts` if it lists fields, `tests/unit/services.test.ts`

**Interfaces:**
- Consumes: `Lang` (Task 1).
- Produces: `Service.description_en: string`, `Service.name_en?: string`; `serviceText(slug: ServiceSlug, lang: Lang): { name: string; description: string }` in `src/services.ts`.

- [ ] **Step 1: Failing tests** in `tests/unit/services.test.ts`: every service has a non-empty `description_en`; `serviceText('google-calendar', 'en').name === 'Google Calendar'`; `serviceText('meta-pixel', 'en').name === 'Meta Pixel'`; `serviceText('google-maps', 'en').name === 'Google Maps'` (falls back to `name`); `serviceText(slug, 'sv')` returns `name` and `description_sv` for every slug.
- [ ] **Step 2: Run** `npx vitest run tests/unit/services.test.ts` → FAIL.
- [ ] **Step 3: Implement**: add the fields to every service and `serviceText`. Run `npm run gen`.
- [ ] **Step 4: Run** `npx vitest run tests/unit/services.test.ts tests/unit/package.test.ts` and the CI staleness check for `services.json` → PASS.
- [ ] **Step 5: Commit** `feat(services): English names and descriptions`.

### Task 3: English consent-terms pin

**Files:**
- Create: `tests/unit/consent-terms.en.json`
- Modify: `tests/unit/consent-terms.test.ts`

**Interfaces:**
- Consumes: `TEXTS.en` (Task 1), `description_en`, `name_en` (Task 2).
- Produces: `termsHashEn(en: Json, services): string` (test-local), covering `consent`, `categories`, `embed.remember`, `embed.info`, and per service `category`, `vendor`, `description_en`, `name_en ?? name`.

- [ ] **Step 1: Failing tests**: `consent-terms.en.json` has an entry for `CONSENT_VERSION` equal to the current English hash (message names the hash to add, like the Swedish test); changing `en.consent.decline` changes the English hash; changing `en.notice.body` does not; changing a service's `name_en` changes it; the Swedish hash is unchanged by any English edit.
- [ ] **Step 2: Run** `npx vitest run tests/unit/consent-terms.test.ts` → FAIL (file missing).
- [ ] **Step 3: Create** `consent-terms.en.json` as `{ "2": "<hash printed by the failing test>" }`. Extend the test's error text: a changed hash in either file needs a new `CONSENT_VERSION` and a new entry in both files.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Update CLAUDE.md's** `CONSENT_VERSION` paragraph to name both files. Commit `test(terms): pin the English consent wording`.

### Task 4: `policy_urls.en` in privacy.json

**Files:**
- Create: `src/policy-url.ts`
- Modify: `src/config.ts` (schema, `parsePrivacyConfig`, `toConsentConfig`), `src/types.ts`, `tests/unit/config.test.ts`, `tests/unit/config-zod-floor.test.ts`, `README.md` (privacy.json table)

**Interfaces:**
- Consumes: `Lang` (Task 1).
- Produces: `PrivacyConfig.policy_urls?: { en?: string }`; `ConsentConfig.policyUrls: { en?: string }` (always present, `{}` when unset); `policyUrlFor(config: Pick<ConsentConfig, 'policyUrl' | 'policyUrls'>, lang: Lang): string | null` in node-free `src/policy-url.ts` = `lang === 'sv' ? policyUrl : policyUrls[lang] ?? policyUrl`.

- [ ] **Step 1: Failing tests**: `policy_urls: { en: 'https://kund.example/en/privacy' }` parses and reaches `toConsentConfig(...).policyUrls.en`; `policy_urls: { en: 'https:/x' }` throws `ConfigError` naming `policy_urls`; an unknown language key (`de`) throws; `policy_urls` absent gives `policyUrls: {}`; `policyUrlFor` returns the English URL for `'en'`, falls back to `policyUrl` when `en` is missing, returns `null` for `'sv'` when only `en` is set. The zod-floor test parses the same valid and invalid inputs on 4.3.6.
- [ ] **Step 2: Run** `npx vitest run tests/unit/config.test.ts tests/unit/config-zod-floor.test.ts` → FAIL.
- [ ] **Step 3: Implement**: `policy_urls: z.strictObject({ en: <the policy_url validator, not nullable> }).optional()`; extract the URL validator into a local const so both fields share it.
- [ ] **Step 4: Run** → PASS; `npm run check` clean.
- [ ] **Step 5: README row**, commit `feat(config): policy_urls.en`.

### Task 5: Components take `lang`

**Files:**
- Modify: `src/components/ConsentBanner.astro`, `PrivacyLinks.astro`, `EmbedPlaceholder.astro`, `ConsentEmbed.astro`, `ConsentWidget.astro`
- Modify demo: `demo/src/layouts/Base.astro` (`lang?: string` prop, default `'sv'`, `<html lang={lang}>`, passes it to ConsentBanner and PrivacyLinks), create `demo/src/pages/en/index.astro` (Base with `lang="en"`, one `ConsentEmbed service="google-maps"` with `lang="en"`), `demo/privacy.consent.json` and `demo/privacy.notice.json` (`policy_urls.en`)
- Test: `tests/build/build.test.ts`, `tests/e2e/banner.spec.ts`, `tests/e2e/embed.spec.ts`

**Interfaces:**
- Consumes: `resolveLang`, `TEXTS` (Task 1), `serviceText` (Task 2), `policyUrlFor` (Task 4).
- Produces: every component's `Props` gains `lang?: string`; each resolves `const lang = resolveLang(Astro.props.lang, Astro.currentLocale)`. ConsentEmbed and ConsentWidget pass `lang` on to EmbedPlaceholder. The banner root and the PrivacyLinks root get `lang={lang}` only when `lang !== 'sv'`.

- [ ] **Step 1: Failing build tests** (both demo modes): `/en/` contains the English `consent.acceptAll`/`notice.ok`, English `links.settings`, English `embed.show` with "Google Maps", `lang="en"` on `[data-consent-banner]`, and the English policy URL in "Read more"; `/` contains no `lang=` attribute on the banner and the same Swedish strings as before; no Swedish value from `sv.json` (fragments around placeholders, at least 4 characters) appears inside the banner, placeholder or links markup of `/en/`.
- [ ] **Step 2: Failing e2e tests**: on `/en/` at 320 px, Decline and Accept all have identical classes and computed colours and the same `offsetTop` (parametrise the existing "equally prominent" test over `/` and `/en/`); Decline on `/en/` then loading `/` shows no banner and loads no map; the English placeholder's "Show Google Maps" loads only that map.
- [ ] **Step 3: Run** `npm run test:build` and, after `npm run demo:build -- consent && npm run demo:build -- notice`, `npm run test:e2e -- banner embed` → FAIL.
- [ ] **Step 4: Implement** the components. Replace every `sv.` read with `t.` where `const t = TEXTS[lang]`, and `SERVICES[slug].name` in visible text with `serviceText(slug, lang).name`; `config.policyUrl` with `policyUrlFor(config, lang)`.
- [ ] **Step 5: Run** `npm run check`, `npm test`, `npm run test:build`, rebuild both demos, `npm run test:e2e` → all PASS, including `site-typecheck.test.ts` (a site passing `lang={someString}` type-checks).
- [ ] **Step 6: Commit** `feat(components): lang prop, English text and policy link`.

### Task 6: Astro 6 parity

**Files:**
- Modify: `scripts/pack-install.ts` (the test site it generates)

- [ ] **Step 1: Failing assertion**: the generated site gets a page `src/pages/en/index.astro` rendering `<ConsentBanner lang="en" />` and a page rendering `<ConsentBanner />` with no i18n config; after build, the first contains the English `consent.acceptAll` (or `notice.ok`, per the pack site's mode) and the second the Swedish one with no `lang=` attribute (proves `Astro.currentLocale` is `undefined` without i18n on Astro 6).
- [ ] **Step 2: Run** `npm run test:pack -- 6.1.6 10.0.4` → FAIL before the pages exist, PASS after; then `npm run test:pack -- 7.3.5 11.1.6` → PASS.
- [ ] **Step 3: Commit** `test(pack): English banner on Astro 6 and 7`.

### Task 7: detect finds languages and the English policy page

**Files:**
- Modify: `ci/rollout/types.ts` (`Report.languages?: LanguagesInfo`), `ci/rollout/detect/structure.ts`, `ci/rollout/detect/config.ts` (i18n key), `ci/rollout/detect/index.ts`, `ci/rollout/run.ts` (report lines)
- Test: `tests/unit/rollout/detect-structure.test.ts`, `tests/unit/rollout/detect-config.test.ts`

**Interfaces:**
- Produces: `interface LanguagesInfo { codes: string[]; astroI18n: boolean; englishPolicy: string | null }`. `codes`: the non-Swedish language codes that have a route `/<code>` or `/<code>/…` (codes from `FOREIGN_PREFIX`'s list), sorted. `astroI18n`: the config object has an `i18n` key. `englishPolicy`: the existing policy ranking applied to routes under `/en` only. `languagesOf(routes: string[]): string[]` and `englishPolicyOf(routes: string[]): string | null` exported from `detect/structure.ts`. Reports stored before this field: treated as `codes: []`.

- [ ] **Step 1: Failing tests**: routes `['/', '/en', '/de/kontakt']` → `['de', 'en']`; `['/', '/en/about']` → `['en']`; `['/', '/engelska']` → `[]`; `['/gdpr', '/en/gdpr', '/en/privacy-policy']` → `englishPolicyOf` `/en/gdpr` (ranking: gdpr before privacy as today); a config with `i18n: {…}` → `astroI18n: true`; detect's report for a fixture site with an `en/` tree carries all three fields; `policyPage` still prefers the Swedish route.
- [ ] **Step 2: Run** `npx vitest run tests/unit/rollout/detect-structure.test.ts tests/unit/rollout/detect-config.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Fixtures use invented content and pass `ci/rollout/scan-secrets.ts`.
- [ ] **Step 4: Run** the full rollout unit suite `npx vitest run tests/unit/rollout --exclude '**/.claude/**'` → PASS, snapshots updated only for the new field.
- [ ] **Step 5: Commit** `feat(rollout): detect a site's languages and English policy page`.

### Task 8: `planLang`, the in-place language edits

**Files:**
- Create: `ci/rollout/wire/lang.ts`
- Test: `tests/unit/rollout/wire-lang.test.ts`

**Interfaces:**
- Consumes: `LanguagesInfo` (Task 7), `Report`, `SiteFiles`, `Edit`, the parse helpers in `wire/markup.ts` (`parseFile`, `usesOf`), `PRIVACY_JSON` and the domain rule from `wire/privacy.ts`.
- Produces: `type LangPlan = { ok: true; edits: Edit[]; notes: string[] } | { ok: false; reasons: string[] }`; `planLang(read: (path: string) => string, report: Report): LangPlan`. Works on the current text of each file, so the banner flow can run it on wire's output.

Rules (from the spec): no `en` in `codes` → `{ ok: true, edits: [] }`. For each file that uses `ConsentBanner` or `PrivacyLinks`: tag already has `lang` → leave it; file declares an identifier `lang` (destructured from `Astro.props` or a frontmatter `const`/`let`) → add `lang={lang}`; else `astroI18n` → no edit; else refuse naming the file. For each `ConsentEmbed`/`ConsentWidget` tag without `lang`: in a page whose route is `/en` or `/en/…` → `lang="en"`; in a page outside `/en` → no edit; in a non-page file → `lang={lang}` when it declares `lang`, else refuse. `privacy.json`: when `englishPolicy` is set and `policy_urls.en` is absent, add `"policy_urls": { "en": "https://<primary domain><englishPolicy>" }`, keeping the file's other keys and formatting; note when the site has English but no English policy page.

- [ ] **Step 1: Failing tests** (inline fixture strings, invented content): a layout with `const { lang = 'sv' } = Astro.props` and `<ConsentBanner />` gets `<ConsentBanner lang={lang} />`; same layout without `lang` and `astroI18n: false` → refused naming the file; with `astroI18n: true` → no edit; `src/pages/en/kontakt.astro` with `<ConsentEmbed service="google-maps" …>` gets `lang="en"`, `src/pages/en.astro` too, `src/pages/kontakt.astro` does not; a shared `src/components/Map.astro` without `lang` → refused; a tag that already has `lang` is untouched; `privacy.json` gains `policy_urls.en` and keeps `services` and `policy_url`; a site without English → no edits; running `planLang` twice on its own output → no edits (idempotent).
- [ ] **Step 2: Run** `npx vitest run tests/unit/rollout/wire-lang.test.ts` → FAIL.
- [ ] **Step 3: Implement** `planLang` with the existing parse helpers; edits are `insert-before` the tag's self-closing `/>` or `>`.
- [ ] **Step 4: Run** → PASS; `npm run check` clean.
- [ ] **Step 5: Commit** `feat(rollout): planLang edits existing tags in place`.

### Task 9: The `site-language` flow and the banner wire

**Files:**
- Modify: `ci/rollout/flows.ts`, `ci/rollout/run.ts`, `ci/rollout/verify.ts` (step 1), `ci/rollout/wire/update.ts` (reuse the install), `ci/rollout/pr.ts`
- Create: `ci/rollout/pr-body.lang.sv.md`
- Test: `tests/unit/rollout/flows.test.ts`, `tests/unit/rollout/run-lang.test.ts` (or the file the sentry command's tests live in), the verify step-1 tests

**Interfaces:**
- Consumes: `planLang` (Task 8), the update flow's install step.
- Produces: `LANG_BRANCH = 'site-language'`; `FLOWS['site-language']` with title `Engelsk text i samtyckesbannern`, template `pr-body.lang.sv.md`, steps `['lockfile', 'build', 'requests', 'consent-paths', 'clip', 'contrast', 'screenshots', 'language', 'docker']`, `others` = every other flow, and each other flow's `others` gains `LANG_BRANCH`; command `tsx ci/rollout/run.ts lang <site dir> [--dry-run]`: refuses a site without `en` in `codes`, installs the package like `update`, applies `planLang`, commits with `feat: engelsk text i samtyckesbannern (astro-consent)`. The `wire` command applies `planLang` to wire's planned files before commit, so a not-yet-wired multilingual site gets the language in its banner PR (refusal there makes the site needs-human).
- Verify step 1 for `site-language`: changed files must be `package.json`, `package-lock.json`, `src/data/privacy.json` or `.astro` files; the package must move up as in `update`; anything else is `UNKNOWN` and fails.

- [ ] **Step 1: Failing tests**: `flowOf('site-language', …)` returns the flow; every flow lists every other in `others`; `lang --dry-run` on a fixture site without English exits 3 with a refusal line; on a fixture site with English prints the planned diff and writes nothing; verify step 1 on a `site-language` branch passes with a layout and `privacy.json` changed, fails with `src/styles/global.css` changed; `wire` on a multilingual fixture emits `<ConsentBanner lang={lang} />`.
- [ ] **Step 2: Run** the named test files → FAIL.
- [ ] **Step 3: Implement.** The PR body says what changed (English text on the English pages, the English policy link) and lists embeds whose `title` is site text, for the reviewer.
- [ ] **Step 4: Run** `npx vitest run tests/unit/rollout --exclude '**/.claude/**'` → PASS.
- [ ] **Step 5: Commit** `feat(rollout): site-language flow`.

### Task 10: Verify checks English pages

**Files:**
- Create: `ci/rollout/checks/language.ts`
- Modify: `ci/rollout/flows.ts` (`STEPS` gains `'language'`; the `consent-banner` and `astro-consent-update` flows run it too), `ci/rollout/verify.ts`
- Test: `tests/unit/rollout/checks.test.ts` (unit part), `tests/e2e/rollout-language.spec.ts` against the demo

**Interfaces:**
- Produces: `interface LanguageResult { path: string; found: string[] }`; `checkLanguage(browser: Browser, base: string, paths: string[], opts?: { stub?: boolean }): Promise<LanguageResult[]>`; `swedishFragments(sv: Text): string[]` (each `sv.json` value split at `{placeholder}`, fragments of 4+ characters, trimmed). A path fails when the visible text or `aria-label` of `[data-consent-banner]`, `[data-consent-embed] [data-placeholder]` or `[data-privacy-links]` contains any fragment. The settings view is opened before reading, as `checkClip` does.
- verify: when the report has `en` in `languages.codes`, the `language` step runs on every built `/en` page (at most the first 5 plus every `/en` map page), and the `clip` and `consent-paths` steps add the first `/en` page to their paths. Without English the step is skipped with `skipWhy`-style text `no English pages`.

- [ ] **Step 1: Failing tests**: `swedishFragments` yields "Acceptera alla", "Visa " is dropped (under 4 characters after trim) and "Visa alltid innehåll från" is kept; e2e: the demo's `/en/` passes, a copy of `/` served at an `/en/` path fails with "Acceptera alla" in `found`; verify on a report without English lists `language` as skipped.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the rollout unit suite and `npm run test:e2e -- rollout-language` → PASS.
- [ ] **Step 5: Commit** `feat(rollout): verify checks English pages for Swedish banner text`.

### Task 11: Docs and release notes

**Files:**
- Modify: `README.md` (a "Languages" section: the `lang` prop, resolution order, `policy_urls`, what wire does on multilingual sites), `CHANGELOG.md` (1.2.0, unreleased), `CLAUDE.md` (DOM contract: `[data-consent-banner][lang]?`; Layout table rows for `src/text/index.ts`, `src/policy-url.ts`, `ci/rollout/wire/lang.ts`)

- [ ] **Step 1: Write** the sections. No client names or domains.
- [ ] **Step 2: Run** the full gate: `npm run check`, `npx vitest run tests/unit --exclude '**/.claude/**'`, `npm run test:build`, both demo builds, `npm run test:e2e`, both `test:pack` runs → all PASS; record the counts in the PR body.
- [ ] **Step 3: Commit** `docs: languages`, push, open the PR to `main` with the English wording quoted in the body for the owner to read. Tagging 1.2.0 is the owner's step after merge and the `starter-install` job.
