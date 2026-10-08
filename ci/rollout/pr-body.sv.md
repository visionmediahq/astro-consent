## Vad ändras

{{#maps}}- Samtyckesbanner (`@visionmediahq/astro-consent` 1.0). Kartorna (Google Maps) laddas först när besökaren klickar "Visa Google Maps" eller har godkänt externt innehåll.
- `src/data/privacy.json`: `google-maps`.{{/maps}}{{#notice}}- Samtyckesbanner (`@visionmediahq/astro-consent` 1.0) i informationsläge: en ruta som berättar att sajten mäter besök anonymt med Umami, utan cookies. Besökaren kan klicka "OK" eller "Läs mer".
- `src/data/privacy.json`: sajtens tjänster.{{/notice}}
- "Cookie-inställningar" i sidfoten och på 404-sidan, så att besökaren kan ändra sitt val.

Filer:

{{files}}

## Så testar du

1. Öppna https://{{domain}} i ett privat fönster: bannern visas längst ned.
{{#maps}}2. Klicka "Neka" och gå till en sida med karta: kartorna visas inte, bara en ruta med "Visa Google Maps".
3. Klicka "Visa Google Maps": kartan laddas. Kryssa "Visa alltid innehåll från Google Maps" så laddas kartor direkt framöver.
4. Klicka "Cookie-inställningar" i sidfoten: bannern öppnas igen.{{/maps}}{{#notice}}2. Klicka "OK" och ladda om sidan: bannern visas inte igen.
3. Klicka "Cookie-inställningar" i sidfoten: bannern öppnas igen.{{/notice}}

## Kontroller

Kontrollerat lokalt med `ci/rollout` (astro-consent):

{{steps}}

Skärmbilder (360/1280 px, banner och {{#maps}}kartornas platshållare{{/maps}}{{#notice}}sidfoten{{/notice}}):

{{screenshots}}

**Mergas efter verifiering och livekontroll.**

## Relaterade ärenden

{{issues}}
