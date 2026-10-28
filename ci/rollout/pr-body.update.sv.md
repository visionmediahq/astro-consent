## Vad ändras

- `@visionmediahq/astro-consent` uppdateras från {{fromVersion}} till {{toVersion}}: bannern, platshållarna och "Cookie-inställningar" kommer från den nya versionen. Bara `package.json` och `package-lock.json` ändras.
{{#reask}}- **Alla besökare får frågan om samtycke igen efter mergen.** Versionen av samtyckestexterna (`CONSENT_VERSION`) är ny, så ett val som gjorts tidigare gäller inte längre.
{{/reask}}{{#noreask}}- Ingen besökare får frågan igen: samtyckestexterna (`CONSENT_VERSION`) är desamma.
{{/noreask}}
Ändringar sedan {{fromVersion}} (från astro-consents `CHANGELOG.md`):

{{changelog}}

Filer:

{{files}}

## Så testar du

1. Öppna https://{{domain}} i ett privat fönster: bannern visas längst ned, som förut.
2. Klicka "Cookie-inställningar" i sidfoten: bannern öppnas igen.
{{#reask}}3. Efter mergen, i en webbläsare där du redan gjort ett val på sajten: bannern visas igen.
{{/reask}}
## Kontroller

Kontrollerat lokalt med `ci/rollout` ({{tool}}):

{{steps}}

Skärmbilder (360/1280 px):

{{screenshots}}

**Mergas efter verifiering och livekontroll.**

## Relaterade ärenden

{{issues}}
