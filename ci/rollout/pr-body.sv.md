## Vad ändras

{{#consent}}- Samtyckesbanner (`@visionmediahq/astro-consent`). Externt innehåll ({{serviceNames}}) laddas först när besökaren klickar på knappen i platshållaren eller har godkänt externt innehåll.
- `src/data/privacy.json`: {{serviceSlugs}}.{{/consent}}{{#notice}}- Samtyckesbanner (`@visionmediahq/astro-consent`) i informationsläge: en ruta som berättar att sajten mäter besök anonymt med Umami, utan cookies. Besökaren kan klicka "OK" eller "Läs mer".
- `src/data/privacy.json`: sajtens tjänster.{{/notice}}
- "Cookie-inställningar" i sidfoten och på 404-sidan, så att besökaren kan ändra sitt val.{{#fonts}}
- Typsnitten ({{families}}) laddas från sajten själv i stället för från Google Fonts, i en egen commit: besökarens webbläsare skickar inga anrop till Google när sidan visas. Filerna ligger i `public/fonts/` med licenserna bredvid, och `src/styles/fonts.css` beskriver dem.{{/fonts}}

Filer:

{{files}}

## Så testar du

1. Öppna https://{{domain}} i ett privat fönster: bannern visas längst ned.
{{#consent}}{{consentSteps}}{{/consent}}{{#notice}}2. Klicka "OK" och ladda om sidan: bannern visas inte igen.
3. Klicka "Cookie-inställningar" i sidfoten: bannern öppnas igen.{{/notice}}{{#fonts}}
{{fontsStep}}{{/fonts}}

## Kontroller

Kontrollerat lokalt med `ci/rollout` (astro-consent):

{{steps}}

Skärmbilder (360/1280 px, banner och {{#consent}}platshållarna{{/consent}}{{#notice}}sidfoten{{/notice}}):

{{screenshots}}

**Mergas efter verifiering och livekontroll.**

## Relaterade ärenden

{{issues}}
