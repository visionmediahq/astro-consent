# English banner, embeds and links: design

Status: draft for the owner's approval, 2026-11-10. Separate from the privacy policy design
(#147): the policy and cookie texts are bigger jobs and follow later in their own release.

## Intent

Some client sites publish in more than one language. On their English pages the banner, the
embed placeholders and the footer links are Swedish today, and "Läs mer" leads to the Swedish
policy page even where an English one exists. A visitor who reads English should get the same
choice, worded in English, one click from the English policy.

## What the sites do today (checked 2026-11-10)

- Ten repos in the org publish in more than one language. All ten serve English under
  `/en/`; one also has `/de/`. Repo IDs: 1236395964, 1229678815, 1235270707, 1273166474
  (`en` + `de`), 1280190874, 1379700164, 1392250264, 1222182440, 1369693991, 1355580610.
- One (1355580610) uses Astro's `i18n` config: Swedish at the root, `/en/` prefixed,
  `Astro.currentLocale` available. The other nine have no `i18n` config: every page passes a
  `lang` prop to the shared layout, which sets `<html lang={lang}>` (one derives it from the
  path instead).
- Some of them are live with the banner and show Swedish on their English pages. Several have
  an English policy page beside the Swedish one (`/en/gdpr`, `/en/privacy-policy`); detect
  already ranks such routes last (#61) so `policy_url` stays Swedish.

## Goals

- English for every visible string of the banner (both modes, settings view included), the
  embed and widget placeholders, and PrivacyLinks.
- The policy link follows the language, with the Swedish page as the fallback.
- No change for Swedish-only sites: no new config needed, same output byte for byte.
- The rollout tool wires the language on the multilingual sites.

## Non-goals

- German or any third language (the structure must allow it; nothing ships for it).
- The privacy policy and cookie texts (#145, #147).
- Language detection from the browser (`navigator.language`): the page's language decides.
- A language switcher.

## Anti-goals

- An English page with a banner in Swedish, or a mix of both, because a prop was missed.
- English and Swedish saying different things about what is collected.
- Visitors re-asked because a translation was added.

## Decided by the owner

- English only in the first version.
- The policy link follows the language where an English page exists; Swedish otherwise.
- The English text is translated by the builder from the live Swedish wording and read by the
  owner in the package PR; it does not wait for legal.

## How the language is chosen

- `ConsentBanner`, `ConsentEmbed`, `ConsentWidget`, `EmbedPlaceholder` and `PrivacyLinks` take
  an optional `lang?: 'sv' | 'en'` prop.
- Resolution, in order: the prop when given; else `Astro.currentLocale` when it is a supported
  language (sites with Astro's i18n need no wiring); else `'sv'`. An unsupported value (`'de'`)
  falls back to `'sv'` and is never an error: a page must always render.
- The banner's container carries `lang="en"` when it is not Swedish, so screen readers switch
  voice on a page whose `<html lang>` is wrong.
- `client.ts` has no visible text and stays unchanged. Nothing about the stored choice
  (`vm_consent`) depends on language: a choice made on an English page holds on a Swedish one.

## Strings

- `src/text/en.json` with exactly the keys of `sv.json`, and a node-free `src/text/index.ts`
  exporting both and the `Lang` type. Components import from it, never from a JSON file
  directly.
- Each service in `src/services.ts` gets `description_en` beside `description_sv`;
  `npm run gen` regenerates `services.json`.
- Tests: the key sets of all language files are identical, no value is empty, every
  placeholder (`{name}`) present in a Swedish value is present in the English one, and every
  service has both descriptions.
- CLAUDE.md's rule becomes "every visible string lives in `src/text/<lang>.json`", and Neka /
  Acceptera alla stay identical in class and colour in every language (the existing test runs
  per language).

## Consent terms (my call)

- `CONSENT_VERSION` does not rise: no visitor is asked again because a translation was added.
- English wording still has to be pinned. A new file `consent-terms.en.json` holds
  `{ version: hash }` for the English counterpart of exactly the keys the Swedish hash covers
  (`consent`, `categories`, `embed.remember`, `embed.info`, each service's category, vendor and
  `description_en`). Its first entry is version `2`, today's version; `consent-terms.json` is
  not edited.
- From then on the rule is the same for both files: a changed hash in either needs a new
  `CONSENT_VERSION` and a new entry in each file.

## Policy link

- `privacy.json` gains `policy_urls?: { en?: string }`. The banner's "Read more" and the footer's
  policy link use `policy_urls[lang] ?? policy_url`. Same validation as `policy_url`.
- When #147 adds `cookie_url`, it follows the same shape (`cookie_urls`); recorded here so the
  two designs stay consistent.

## Rollout tool

- detect: per site, the languages it publishes (top-level `src/pages/<code>/` folders, the
  `i18n` config) and, when English is among them, the English policy route, picked with the
  existing ranking restricted to `/en/` routes.
- wire, on a multilingual site:
  - the banner: when the layout that renders it has a `lang` variable or prop, pass
    `lang={lang}`; when the site uses Astro's i18n, pass nothing. When neither can be found,
    the site is needs-human, not wired in Swedish.
  - embeds: a `ConsentEmbed`/`ConsentWidget` in a file under `src/pages/en/` gets `lang="en"`.
    One in a shared component used by both trees gets the component's `lang` when it has one;
    otherwise needs-human.
  - `policy_urls.en` from detect.
- verify: on a multilingual site, step 5 (clip) and the banner checks also run on one `/en/`
  page, and a new check fails when an `/en/` page shows any Swedish banner or placeholder
  string (from `sv.json`) instead of the English one. English labels are longer, so the clip
  check at 320 px is the one that matters.
- Live multilingual sites get the release through the `update` flow plus the wiring above, in
  one PR per site, merged under the existing rule (no client facts change).

## Constraints

- CLAUDE.md rules unchanged otherwise: browser-safe imports (the text index is node-free), no
  new npm scripts, TypeScript only, DaisyUI 5, failing test first.
- Public repo: client sites by repo ID only.
- Astro 6.1.6: `Astro.currentLocale` behaviour without an i18n config must be checked with
  `test:pack` (it should be `undefined`); the demo is Astro 7 only.
- The demo gets an `/en/` page with the banner and an embed, built in both modes, and e2e runs
  against it.

## Release

A minor release, 1.2.0. Sites on `semver:^1.0.0` pick it up at their next install; Swedish-only
sites see no change.

## Left to the builder

- The English wording (owner reads it in the PR). Keep "Accept all" and "Decline" the same
  length class so the two buttons stay on one row at 320 px.
- Prop plumbing between ConsentEmbed, ConsentWidget and EmbedPlaceholder.
- detect's exact language-folder rules and the wire heuristics for finding the layout's `lang`.
- Test layout, as long as every behaviour above has a failing test first.
