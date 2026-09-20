# Superteam-melding en dashboard

Twee dingen in één repo:

1. Een achtergrondje dat elke 5 minuten checkt of Superteam de standen
   heeft bijgewerkt, je een pushmelding stuurt als dat zo is, en je eigen
   rang/punten automatisch bijhoudt.
2. `index.html`: dezelfde teambouw-tool als altijd, maar leest voortaan
   automatisch `data.json` in. Eenmaal op GitHub Pages gezet, kun je 'm
   vanaf je telefoon bekijken zonder ooit zelf iets te hoeven verversen
   voor je eigen rang door de tijd.

Let op: populariteit en werkelijke punten van alle 491 spelers worden nog
niet automatisch ververst, dat blijft voorlopig iets wat je af en toe aan
Claude vraagt. Alleen jouw eigen rang/punten (het grafiekje) houdt zichzelf
al helemaal bij.

## Eenmalig instellen (ongeveer 10 minuten)

**1. Maak een GitHub-repo aan** (mag gerust publiek zijn: het enige gevoelige,
   je tokens, komt hier expliciet nooit in terecht, zie hieronder) en zet
   alle bestanden uit dit pakket erin: `index.html`, `data.json`,
   `check-superteam.js`, `.gitignore` en de map `.github/workflows`.

**2. Haal je twee tokens op.** Log in op super-team.nl in Chrome, open de
   devtools-console (F12 → tabblad Console) en plak deze twee regels, één
   voor één. Elke regel zet de waarde direct op je klembord, je ziet hem
   nergens getoond:

   ```js
   copy(sessionStorage.getItem('ngStorage-sessionToken').replace(/^"|"$/g,''))
   ```
   Plak dit meteen (Ctrl+V) in een secret op GitHub, zie stap 3.

   ```js
   copy(localStorage.getItem('ngStorage-refreshToken').replace(/^"|"$/g,''))
   ```
   Zelfde verhaal, direct doorzetten naar de volgende secret.

**3. Zet drie secrets in je repo.** Settings → Secrets and variables →
   Actions → New repository secret:
   - `SUPERTEAM_SESSION_TOKEN` — wat je bij stap 2 kopieerde
   - `SUPERTEAM_REFRESH_TOKEN` — idem
   - `NTFY_TOPIC` — een zelfverzonnen, niet-voor-de-hand-liggende naam,
     bijvoorbeeld `simon-superteam-a8k2p`

**4. Installeer de ntfy-app** (gratis, Android en iOS) en abonneer je in de
   app op exact dezelfde topic-naam.

**5. Zet de workflow aan.** Tabblad "Actions" in je repo → workflows
   inschakelen als daarom gevraagd wordt → "Check Superteam voor updates"
   → "Run workflow" om 'm één keer met de hand te testen.

**6. Zet GitHub Pages aan.** Settings → Pages → Branch: main, map: / (root)
   → Save. Na een minuutje staat je dashboard op
   `https://<jouw-gebruikersnaam>.github.io/<repo-naam>/`.

## Waarom je tokens hier veilig zijn

`state.json`, waar je sessietoken en ververstoken in staan, wordt nooit
gecommit (staat in `.gitignore`) en leeft alleen in de eigen cache van de
GitHub Action, buiten de repo-geschiedenis en dus buiten wat Pages ooit
laat zien. `data.json`, dat wel gepubliceerd wordt, bevat alleen standen
die binnen de poule toch al voor iedereen zichtbaar zijn.

## Wat als er iets misgaat

Elke run is terug te zien onder het tabblad "Actions". Een gefaalde run
stuurt geen melding en verandert data.json niet, dus een tijdelijke hik
lost zichzelf vanzelf op bij de volgende poging.
