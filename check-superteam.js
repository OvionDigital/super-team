#!/usr/bin/env node
/**
 * Checkt of Superteam de puntenstand heeft bijgewerkt, stuurt een
 * pushmelding via ntfy.sh als dat zo is, en houdt de rang/punten van
 * Simons eigen twee teams automatisch bij in data.json (dat bestand
 * wordt gepubliceerd via GitHub Pages, dus alleen niet-gevoelige data).
 *
 * Benodigde omgevingsvariabelen (als GitHub Actions secrets):
 *   SUPERTEAM_SESSION_TOKEN   - eenmalig gekopieerd uit sessionStorage
 *   SUPERTEAM_REFRESH_TOKEN   - eenmalig gekopieerd uit localStorage (blijft ~5 jaar geldig)
 *   NTFY_TOPIC                - een zelfgekozen, geheime kanaalnaam voor ntfy.sh
 *
 * BELANGRIJK over state.json (de tokens): dat bestand wordt NIET naar
 * git gecommit, alleen bewaard via actions/cache tussen runs (zie de
 * workflow-yml). Zo blijft het buiten de repo-geschiedenis en dus ook
 * buiten wat GitHub Pages ooit laat zien. data.json is wel publiek en
 * bevat alleen dingen die toch al voor iedereen in de poule zichtbaar
 * zijn: standen, geen tokens, geen inloggegevens.
 */

const EDITION_ID = 13;
const ROUND = 6; // pas dit later aan zodra Superteam een nieuwe ronde opent
const STATE_FILE = 'state.json';   // gevoelig: tokens. Nooit committen, alleen via cache.
const DATA_FILE = 'data.json';     // publiek: wordt door de site zelf ingelezen.

const MY_LINEUPS = [
  { lineupId: 5485, naam: 'FC Sportfreunden' },
  { lineupId: 5486, naam: 'Prive' }
];

async function refreshTokens(sessionToken, refreshToken) {
  const res = await fetch('https://api.super-team.nl/api/auth/refresh', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + sessionToken, 'Content-Type': 'text/plain' },
    body: refreshToken
  });
  if (!res.ok) throw new Error(`Token verversen mislukt (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.models[0]; // { sessionToken, refreshToken }
}

async function fetchStandings(sessionToken) {
  const res = await fetch(
    `https://api.super-team.nl/api/ranks/lineups/editions/${EDITION_ID}/totals/${ROUND}`,
    { headers: { 'Authorization': 'Bearer ' + sessionToken } }
  );
  if (!res.ok) throw new Error(`Standen ophalen mislukt (${res.status}): ${await res.text()}`);
  return res.json();
}

function summarize(standings) {
  const sumScore = standings.models.reduce((a, m) => a + (m.score || 0), 0);
  return `${standings.models.length}:${sumScore}`;
}

function extractMyTeams(standings) {
  return MY_LINEUPS.map(t => {
    const m = standings.models.find(x => x.lineupId === t.lineupId);
    return { lineupId: t.lineupId, naam: t.naam, rank: m ? m.rank : null, punten: m ? m.score : null };
  });
}

async function notify(topic, title, message) {
  await fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    headers: { Title: title },
    body: message
  });
}

async function main() {
  const { SUPERTEAM_SESSION_TOKEN, SUPERTEAM_REFRESH_TOKEN, NTFY_TOPIC } = process.env;
  if (!NTFY_TOPIC) throw new Error('Ontbrekende omgevingsvariabele NTFY_TOPIC.');

  const fs = await import('fs/promises');

  let prevState = {};
  try { prevState = JSON.parse(await fs.readFile(STATE_FILE, 'utf-8')); } catch { /* eerste run */ }

  const sessionTokenIn = prevState.sessionToken || SUPERTEAM_SESSION_TOKEN;
  const refreshTokenIn = prevState.refreshToken || SUPERTEAM_REFRESH_TOKEN;
  if (!sessionTokenIn || !refreshTokenIn) {
    throw new Error('Geen tokens beschikbaar: vul SUPERTEAM_SESSION_TOKEN en SUPERTEAM_REFRESH_TOKEN in als secrets voor de eerste run.');
  }

  const { sessionToken, refreshToken } = await refreshTokens(sessionTokenIn, refreshTokenIn);
  const standings = await fetchStandings(sessionToken);
  const signature = summarize(standings);

  console.log('Huidige samenvatting:', signature, '| Vorige keer:', prevState.signature || '(nog geen)');

  if (prevState.signature && prevState.signature !== signature) {
    await notify(NTFY_TOPIC, 'Superteam bijgewerkt', 'De standen zijn zojuist aangepast. Tijd om te kijken hoe je ervoor staat.');
    console.log('Melding verstuurd.');
  } else if (!prevState.signature) {
    console.log('Eerste run, alleen de huidige stand opgeslagen. Nog geen melding.');
  } else {
    console.log('Geen wijziging, geen melding.');
  }

  // --- publieke data.json bijwerken: alleen de history-lijst, verder niets aanraken ---
  let data = {};
  try { data = JSON.parse(await fs.readFile(DATA_FILE, 'utf-8')); } catch { /* bestaat nog niet */ }
  data.history = Array.isArray(data.history) ? data.history : [];
  const myTeams = extractMyTeams(standings);
  const last = data.history[data.history.length - 1];
  const teamsChanged = !last || JSON.stringify(last.teams) !== JSON.stringify(myTeams);
  if (teamsChanged) {
    data.history.push({
      date: new Date().toISOString().slice(0, 10),
      asOf: `tot en met ronde ${ROUND}`,
      totalTeams: standings.models.length,
      teams: myTeams
    });
    console.log('Nieuw punt toegevoegd aan data.json (rang/punten veranderd).');
  } else {
    console.log('Geen wijziging in eigen rang/punten, data.json history ongewijzigd.');
  }
  data.updatedAt = new Date().toISOString();
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));

  // --- state.json (tokens): alleen voor de volgende run, nooit committen ---
  await fs.writeFile(STATE_FILE, JSON.stringify({
    signature, sessionToken, refreshToken, checkedAt: new Date().toISOString()
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
