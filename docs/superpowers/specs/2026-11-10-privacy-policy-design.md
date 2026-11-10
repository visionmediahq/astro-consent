# Privacy policy and cookie text: design

Date: 2026-11-10. Refs #89, draft PR #145. Status: design, not built. The Swedish wording of every
legal string is a draft until legal approves it; nothing here ships before that.

## Intent

210 of the 266 client sites in the rollout pool have no privacy policy page at all. A site with no
policy is a certain breach of GDPR art. 13; a site whose banner says one thing and whose policy
says another is the next worst. This package already knows most of what a site does to a
visitor's data (what the banner stores, which embedded services load, whether Umami runs) and sits
in every site's build, so it is where a text that cannot drift from the site can be generated.

Two texts, built from the same sections, so that one is a subset of the other:

- **The cookie text** (`<ConsentPolicy />`, PR #145): what LEK 9 kap. 28 § and GDPR art. 13 ask
  for about cookies, the stored choice, Umami and embedded services. For every site.
- **The privacy policy** (`<PrivacyPolicy />`, new): the full art. 13 notice for a standard
  Vision Media site: the cookie sections plus the contact form, the spam check, hosting, logs,
  error reporting, backups. Only for sites without a policy of their own.

Both state only facts the package can verify at build or request time, or facts the site owner
has written into `privacy.json`. Anything the package cannot verify is either left out with the
site refused (fail closed) or taken from the owner.

## Goals

- Every rolled-out site has a complete, true art. 13 notice reachable from the banner and footer.
- The three texts a visitor can see (banner, cookie text, policy) never contradict each other.
- A change in a fact (a hosting move, a retention period) is one change in one place.
- Legal approves wording once per version, and nothing unapproved can be released.

## Non-goals

- A general privacy-policy generator. Webshops, newsletters, bookings, user accounts, any form
  that is not the starter's contact form: those sites write their own policy and use only the
  cookie text.
- Replacing vision-privacy on the WordPress sites. Its texts are separate; see "Drift across
  platforms".
- English or other languages. Swedish only; the README says so.
- Cookie-by-cookie listing per vendor (PTS practice). Open question for legal in #145; not in
  this design.

## Anti-goals

- A generated text that is silently incomplete: the build must refuse rather than publish a
  policy that omits processing the site does.
- A per-site typed fact that can be wrong: nothing the package or the environment can tell is
  typed by a technician.
- A banner that re-asks every visitor for a wording change in the policy alone.

## Settled facts (from the owner, 2026-11-10)

| Fact | Value |
|---|---|
| Vision Media's role | Processor only. Umami exists to give each client their statistics; GlitchTip to monitor each client's site. No use of the data for Vision Media's own purposes. |
| Legal entity | VM Group AB, org.nr 559094-7841 |
| Hosting | Coolify on a Hetzner server in Helsinki (Hetzner Online GmbH, data centre in Finland). No Cloudflare. |
| Contact form | astro-starter `src/pages/api/contact.ts`: sent through Resend to the client's address (`CONTACT_TO`) from `noreply@visionmedia.io`, visitor's address as reply-to. Name, e-mail and message required; every other submitted field is forwarded. Nothing stored by the site. |
| Resend | Plus Five Five, Inc., USA; sends through AWS; Pro plan, so message content is kept 30 days; data stored in the US whichever sending region is chosen; transfers under the EU standard contractual clauses in Resend's DPA. EU–US Data Privacy Framework listing: unconfirmed. |
| Spam check | `@visionmediahq/spam-guard`: honeypot; a content check that marks mail "[misstänkt spam]"; a per-IP rate limit (in memory, 10 minutes, IPv6 by /64); a per-site blocklist (`SPAM_BLOCK`, an app variable, never a team variable; the client approves each entry, template in the ops repo); and one provider per site: Google reCAPTCHA v3 (today's default) or ALTCHA (the target for every site). Messages judged as spam by the honeypot or the blocklist are discarded with a success reply. |
| Logs | Container logs last until the next deploy. They carry a daily-salted 6-hex hash of the IP for rejected posts, never the IP. Traefik access log assumed off (Coolify default), unverified. |
| GlitchTip | Self-hosted Sentry bundle, loads on every page, `tracesSampleRate: 0.1`, sends URL, browser, breadcrumbs, and may include the IP. Retention 90 days. |
| Umami | Visitor id = hash(site, IP, user agent, salt that rotates monthly); the IP is not stored; country/region/city derived. Raw data kept until further notice but unlinkable after the month. Monthly PDF reports (totals only) kept indefinitely. |
| Backups | Period unknown. Text uses the criterion "tills nästa säkerhetskopia ersätter den" until the number is read from Coolify's database backup settings and the Hetzner console (the Coolify read token needs renewing first). |
| Client's inbox | Retention is the client's; the text uses a criterion the client confirms in their PR, default "så länge ärendet pågår och därefter som annan e-post". Never a number the package invents. |
| Processor agreement | None exists today. Legal drafts a standard PUB-avtal naming Hetzner and Resend as sub-processors. The text must not claim one exists. |
| Banner | The notice banner's "utan personuppgifter" (Umami) changes in the same release, so `CONSENT_VERSION` rises once and every visitor is asked once more. The sentence renders only when Umami is configured (the same condition as the policy's section 7). |
| Org number | Optional everywhere. Art. 13.1 a asks for the controller's identity and contact, not the registration number. Name, e-mail and address are required for the full policy and are prefilled by wire from site-factory's `business.json`; the PR asks the client to confirm them and to add the org.nr if they want it shown. |
| Release | One release: the banner change and the new components together. The policy page follows per site; until then "Läs mer" is missing on those sites exactly as today. |
| reCAPTCHA | Disclosed in the policy while a site is on it (Google receives IP, device and behaviour data, sets a `_GRECAPTCHA` cookie on google.com, transfer to the US); the paragraph disappears when the site switches to ALTCHA. |

## Where each fact comes from

Three kinds, three mechanisms. Nothing is typed that can be detected.

1. **Client facts** in `src/data/privacy.json`:
   - `controller: { name, email, address, org_number? }`. For the full policy name, e-mail and
     address are required; for the cookie text alone `address` stays optional. `org_number` is
     optional everywhere and printed when given. A page rendering `<ConsentPolicy />` or
     `<PrivacyPolicy />` without the required fields fails the build with a message naming them
     (#145's console.warn and the "NoEmail" string variants go away). Wire prefills name, e-mail
     and address from site-factory's `business.json` (which has no org.nr) and the PR asks the
     client to confirm them.
   - `inbox_retention` (string, Swedish, a criterion): optional with the default above; wire puts
     it in the PR for the client to confirm.
   - `policy: "generated" | "own"`. `own` (the default when absent) renders only the cookie text
     and keeps `policy_url`. `generated` enables `<PrivacyPolicy />` and the fail-closed scan.
   - The `processor` string from #145 is removed: Vision Media's facts are not per site.
2. **Vision Media's facts** as one constant module, `src/processor.ts`: legal name, org.nr,
   hosting provider and country, Resend (entity, country, retention, DPA URL), GlitchTip
   retention, Umami description, backups criterion, log criterion. One block, one diff per
   change. No server IPs or internal hostnames (ADR 0003 has the IP; it does not belong in a
   public package).
3. **Site facts, detected:**
   - Umami and GlitchTip: the components read `import.meta.env.UMAMI_SCRIPT_URL`,
     `UMAMI_WEBSITE_ID` and `PUBLIC_GLITCHTIP_DSN` exactly as the starter's `Base.astro` does.
     Astro inlines these at build, so the policy and the layout agree by construction. Not read
     in the integration (it would re-implement Astro's env loading and could disagree).
   - The contact form and spam provider: the contact-form section renders only when
     `@visionmediahq/spam-guard` is a dependency in the site's `package.json` **and** the route
     `src/pages/api/contact.ts` exists (both from the integration, via `package.json` and
     `astro:routes:resolved`). The provider is `process.env.SPAM_PROVIDER`, read at request time
     in the component, with spam-guard's exact default (`recaptcha` when unset) and its dev
     fallback to `import.meta.env`. The default is a literal `'recaptcha'` with a comment naming
     spam-guard's source line; the post-merge live check (below) is the proof that the sentence
     matches `/api/form-config`. astro-consent does not import spam-guard, not even as a
     devDependency: a second mandatory git dependency for every site is not acceptable, and
     CLAUDE.md's import rules apply.
   - `SPAM_BLOCK`: optional and runtime; the sentence says the site "kan" keep a list.
   - The consent log: as #145, only with `log_endpoint`.

## Fail closed

A site may render `<PrivacyPolicy />` only when it is a standard site. The integration checks
from structured sources, never from template text (the embed scan's "never fail a build on valid
code" rule in CLAUDE.md is about the embed scan, whose miss is harmless; here a miss publishes a
false legal statement, so the rule is the opposite, and the doc says so):

- `astro:routes:resolved`, routes with `origin: 'project'` only (Astro's own `internal` routes,
  the image endpoint, server islands and actions, are present on every site): every endpoint
  must be one of the starter's (`api/contact`, `api/form-config`, `api/altcha-challenge`,
  `llms.txt`). Any other project endpoint, or any page under `/api`, fails the build.
- `package.json` dependencies: a denylist of packages that mean other processing (stripe,
  klarna, swish, mailchimp, sendgrid, shopify, and the like; the list lives in one file with a
  test).
- No check on `output`: `static` with an adapter allows on-demand pages in Astro 5+, and the
  `Astro.isPrerendered` throw below covers the case that matters.
- A prerendered policy page: `<PrivacyPolicy />` throws on `Astro.isPrerendered`, which fails
  `astro build` with the file name and shows the error on the page in dev. `<ConsentPolicy />`
  keeps working prerendered (it needs no request-time facts) but drops the "warn only when
  prerendered" branch from #145.
- The failure message names the escape hatch: set `"policy": "own"` (and write a policy by
  hand), or remove the page.

Forms posting to other hosts and Google Fonts not yet self-hosted stay in the rollout tool
(detect and wire refusals), not in the build.

## Pages and links

- **Sites without a policy (210):** wire writes `src/pages/integritetspolicy.astro` rendering
  `<PrivacyPolicy />` in the site's layout. The cookie sections are inside it, under an anchor
  (`#cookies`). `policy_url` becomes the path `/integritetspolicy`.
- **Sites with their own policy (56):** wire writes `src/pages/cookies.astro` rendering
  `<ConsentPolicy />`; `policy_url` stays as it is. If the target file already exists (detect's
  `policyPage` ranking matches `cookie*` pages too), wire refuses and the site is needs-human.
- **Two links in config.** Today the banner's "Läs mer" and PrivacyLinks' "Integritetspolicy"
  share `policy_url`. Add `cookie_url`: the banner's "Läs mer" prefers it (LEK 9:28 wants the
  purpose text one click from the banner); the footer link uses `policy_url`. Both may be a site
  path, not only an absolute URL; the integration accepts a path only when
  `astro:routes:resolved` lists it, else the build says which page is missing. Consumers to
  update: `config.ts` validation, `ConsentBanner.astro`, `PrivacyLinks.astro`, rollout
  `links.ts`, the PR-body logic from #134, the `policyUrl` type.
- Headings are `h2`; the host page owns the `h1`. A visible "Senast uppdaterad" line, from the
  approval date in `policy-terms.json` (below), not the build date and not the package version.

## What the texts say

Sections, in order; (C) = in the cookie text too, (P) = policy only. Every section with a
legitimate-interest basis names the interest and has its objection sentence, with the contact
address, in that section (art. 21.4: shown separately), not only under Umami.

1. (C) **Personuppgiftsansvarig**: name, org.nr when given, address, e-mail. (P) Then VM Group
   AB (559094-7841) "driftar webbplatsen, e-postutskicket, besöksstatistiken och
   felrapporteringen på uppdrag av oss" and uses Hetzner Online GmbH (Finland) for hosting and
   Resend for e-mail. A factual description of the role; no "enligt avtal", no "vi har ingått
   PUB-avtal".
2. (P) **Kontaktformuläret**: what is sent (the fields you fill in; name, e-mail and message are
   needed to send, otherwise call or e-mail), where it goes (through Resend to our e-mail; the
   sender address is not named, it is a per-site runtime setting and art. 13 does not need
   it), that the site stores nothing, Resend 30 days in the USA under the
   EU standard contractual clauses (link to Resend's DPA, how to get a copy), our inbox: the
   client's criterion. Basis: art. 6.1 b when you ask for an offer or service, 6.1 f (answering
   your message) otherwise. Recipients: VM Group AB, Resend (Plus Five Five, Inc., via AWS), our
   e-mail provider.
3. (P) **Skydd mot skräppost**: ALTCHA (a puzzle solved in your browser, from our own server,
   nothing stored, no third party) **or** Google reCAPTCHA (as settled above, link to Google's
   policy and terms, basis 6.1 f, transfer to the USA). Then: a content check may mark a message
   as suspected spam; a limit on posts per IP address kept in memory for 10 minutes; a list of
   blocked senders the site may keep for as long as they are blocked; messages judged as spam
   are not delivered, so call or e-mail if no answer comes. Basis 6.1 f, interest: keeping the
   form usable and safe.
4. (P) **Drift och loggar**: hosting in the EU; technical logs with a hash of the IP, kept until
   the next deploy; backups, the criterion above. Basis 6.1 f, interest: running the site and
   keeping it safe. "Serverloggar kan innehålla din IP-adress" stays until the Traefik access
   log is verified off.
5. (P) **Felrapportering** (only when `PUBLIC_GLITCHTIP_DSN` is set): what a report holds (page,
   browser, the error, may include the IP), 90 days, VM Group AB's GlitchTip. Basis 6.1 f,
   interest: finding faults.
6. (C) **Vad som sparas i din webbläsare**: as #145, plus the consent log with `log_endpoint`.
   In consent mode the basis is art. 6.1 c, the duty to show consent under art. 7.1 (legal
   decides between 6.1 c and citing 7.1 alone). In notice mode no consent exists (the stored
   choice is `notice_ok`), so the sentence is a second string saying the acknowledgement is
   logged, basis 6.1 f, interest: showing the notice was given; its wording joins the legal
   questions. #145's consent-only sentence must not render in notice mode.
7. (C) **Besöksstatistik** (only when Umami is configured): the monthly id, no IP stored,
   raw data "tills vidare" and unlinkable after the month, monthly reports with totals only,
   and that VM Group AB runs the statistics on the site owner's behalf (the cookie text on the
   56 own-policy sites would otherwise never name the recipient of the Umami data; art. 13.1 e).
   Basis 6.1 f, objection sentence.
8. (C) **Tjänster från andra företag** (consent mode only): as #145, without the joint
   controllership sentence; transfers with the safeguard and how to get a copy. Fashion ID still
   applies; that is a risk note for legal, not a sentence.
9. (C) **Dina rättigheter**: access, rectification, erasure, restriction, objection,
   portability, withdrawal; contact; IMY with link. (P) No automated decisions (art. 13.2 f).
10. (C) **Ändra ditt val**: the button.

The banner's `notice.body` changes to match section 7 (one `CONSENT_VERSION` bump in the same
release; `notice.body` is not in the consent-terms hash today, so the test will not force the
bump: CLAUDE.md's rule does). The Umami description is one string that the banner, the cookie
text and the policy all include.

**The banner's Umami sentence is conditional** on the same two build variables as section 7.
Today it renders on every notice-mode site. A notice-mode site with no Umami and no services
has nothing to tell the visitor and renders no banner at all (nothing is stored either, so no
re-ask is needed on such a site). On such a site the same condition hides what depends on the
banner: section 6 (nothing is stored), section 10's button and PrivacyLinks' settings button
(`[data-consent-open]` does nothing without a banner). Affected: `ConsentBanner.astro`,
`PrivacyLinks.astro`, `client.ts`'s notice path, the e2e consent-path tests, the demo's notice
build (which must set the variables), and verify.

## Versioning and sign-off

- `policy-terms.json`, modelled on `consent-terms.json`: entries `{ version: { hash, approved,
  by } }` where `hash` covers every `policy.*` string, `src/processor.ts`, and each service's
  `privacy_url`. A test fails when the current hash has no entry. "Add an entry, never edit one",
  as for consent terms.
- Separate from `CONSENT_VERSION`: a policy wording change must not re-ask every visitor. They
  move together only when a service's category, vendor or purpose changes.
- The page prints the entry's `approved` date as "Senast uppdaterad".
- CLAUDE.md gains the rule: a release that changes the policy hash needs legal's approval
  recorded in the entry.
- The `update` flow's PR body lists "policy text changed" next to "visitors are re-asked".

## Drift

- **Within a site:** facts exist once; the cookie text is the same section components the
  policy renders; a build test renders both pages and asserts the shared sections are identical;
  the hashes above catch any wording change.
- **Against reality:** a post-merge live check compares the page with the site: Umami script tag
  present ⇔ section 7 present; `/api/form-config` provider ⇔ the spam sentence; the Sentry tag ⇔
  section 5. Verify's step 2 builds with only `SITE_URL` today; it sets dummy values for
  `UMAMI_SCRIPT_URL` and `UMAMI_WEBSITE_ID` (every production build has them), so the banner and
  the policy page under verify match production. GlitchTip and the spam provider stay as the
  verify build sees them, with a note in the report that those sections are env-dependent; the
  live check is the real proof.
- **Across platforms:** vision-privacy's templates are separate and no test spans the repos. One
  legal-approved fact sheet both repos cite, and a note in each pointing to it. Out of scope to
  build here; recorded so it is not forgotten.
- **Over time:** every change to `src/processor.ts` is a release plus an `update` PR per live
  site (sites install the lockfile's pinned commit). Accepted; the banner already has this
  property. The first corrections (backup period, DPF listing, Traefik log) are planned as one
  `update` batch.

## Rollout

- A new wire part writes the page (`integritetspolicy.astro` or `cookies.astro`) using the
  site's shared layout, copying the layout invocation (title, description, canonical props) from
  the site's simplest existing page. If no single shared layout exists or the invocation cannot
  be copied, the site is needs-human, as wire/layout.ts already does.
- One release carries the banner change and the components. Live sites get it through the
  `update` flow and are re-asked once; the policy page comes afterwards.
- Sequence per site: the package release with this design must be in the lockfile first
  (`update` flow, or the banner `wire` PR for the ~96 not-yet-wired sites), then the
  `policy-page` flow with its own PR body and verify steps. The policy page is never part of
  the banner PR: the banner PR is reviewed for its own behaviour and merges under the existing
  rule, and the policy PR needs the client's facts.
- Every policy PR, the full policy and the cookie-only page alike, is merged by the owner, not
  by the "merge reviewed+verified PRs without asking" rule: both print the client's name,
  address and e-mail (the banner shows none of these today), and `controller` and, for the full
  policy, `inbox_retention` need the client's confirmation. The PR body asks for it.
- site-factory adds the page and `controller` from the brief for new sites, so the 210 stop
  growing (site-factory #238 flags a missing policy as MUST).
- Which 56 "have their own" is detect's `policyPage` ranking. Their own policies still omit
  Maps/Umami; the cookie page covers that part, the rest is a hand note in their PR.

## Constraints

- CLAUDE.md rules unchanged: browser-safe imports (the policy's facts live in
  `virtual:astro-consent/policy`, never in `client.ts`'s import graph); every visible string in
  `sv.json`; TypeScript only; no new npm scripts; fail closed.
- Public repo: tests use invented org numbers and addresses; client sites appear only as repo
  IDs; no server IPs.
- Astro 6.1.6 parity for `Astro.isPrerendered` and `astro:routes:resolved` ordering relative to
  the virtual module's `load()` are unverified: cover with `test:pack` and a build test before
  relying on them (Astro-6 rendering gaps are only caught there).
- Ports 4321/4322 may be held by another session during e2e runs.

## Prerequisites before release (not before building)

1. Legal: the standard PUB-avtal (sub-processors Hetzner, Resend), approval of every string,
   the open questions in #145 (consent-log basis, cookie listing per vendor, the stored id,
   Fashion ID risk note).
2. Facts: the backup period; Traefik access log on or off; Resend's DPF listing; GlitchTip's IP
   storage setting.
3. The ALTCHA move continues independently; the policy does not wait for it.

## Left to the builder

- The section-component structure and prop shapes.
- How the integration passes the route list and `package.json` facts to the component (a second
  export on the policy virtual module is the obvious place).
- The dependency denylist's exact contents.
- Test layout, as long as every behaviour above has a failing test first.
- The wire part's layout-copying heuristic and its refusal messages.
- A site with the contact route but without the spam-guard dependency, or the reverse: refuse
  `generated` with a message naming both, since the design cannot say what such a form does.

## Decisions after the builder check (2026-11-10)

Answered by the owner:

- Org number optional everywhere; name, e-mail and address prefilled from `business.json`.
- The banner's Umami sentence follows the two Umami build variables; verify sets dummy values.
- One release for the banner change and the components.

Answered by the owner after the second review (2026-11-10):

- Every policy PR is owner-merged, the cookie-only page included; name and e-mail are required
  for the cookie text and a missing one fails the build.

My calls, for the owner to check while reading:

- The policy page is always its own flow after the banner is live, never part of the banner PR.
- The route check applies to the site's own routes only (Astro's internal routes are on every
  site); the `output` check is dropped as redundant with the prerender throw.
- The spam provider default is a literal with a comment, not a test against spam-guard's source;
  the live check is the proof.
- On a notice site that renders no banner, the stored-choice section, the change button and the
  PrivacyLinks settings button are hidden under the same condition.
- The consent-log sentence has a notice-mode variant (acknowledgement logged, basis 6.1 f) whose
  wording goes to legal; the consent-mode sentence never renders in notice mode.
- Wire refuses the cookie page when the target file already exists.
- The cookie text names VM Group AB as running the statistics on the site owner's behalf (it was
  a policy-only sentence; the own-policy sites would otherwise never name that recipient).
- The sender address `noreply@visionmedia.io` leaves the text: it is a per-site runtime setting
  (`CONTACT_FROM`, with two historical defaults) and art. 13 does not ask for it.
- `notice.body` stays outside the consent-terms hash; the `CONSENT_VERSION` bump is made by
  hand under CLAUDE.md's rule.
