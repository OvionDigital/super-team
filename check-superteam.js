#!/usr/bin/env node
/**
 * Draait elke paar minuten via GitHub Actions en doet drie dingen:
 *  1. Stand per ronde bijhouden (rang en punten van Simons twee teams aan
 *     het einde van elke ronde) in data.json -> history.
 *  2. Werkelijke punten per speler en populariteit (ownership) opnieuw
 *     ophalen zodra de stand verandert, in data.json -> actual / ownership.
 *  3. Een pushmelding via ntfy.sh sturen als de stand is bijgewerkt.
 *
 * Alle gebruikte API-adressen van Superteam zijn openbaar (geen inlog nodig).
 *
 * Omgevingsvariabele (GitHub Actions secret):
 *   NTFY_TOPIC  - geheime kanaalnaam voor ntfy.sh
 *
 * state.json (alleen de laatste "handtekening" van de stand) leeft via
 * actions/cache tussen runs en wordt niet gecommit.
 */

const fs = require('fs/promises');

const API = 'https://api.super-team.nl/api';
const EDITION_ID = 13;
const STATE_FILE = 'state.json';
const DATA_FILE = 'data.json';
const POOL_FILE = 'index.html'; // spelerslijst staat in <script id="pooldata">

const MY_LINEUPS = [
  { lineupId: 5485, naam: 'FC Sportfreunden' },
  { lineupId: 5486, naam: 'Prive' }
];

/* ---------- API ---------- */
async function get(path, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(API + path);
      if (!res.ok) throw new Error(`${res.status} op ${path}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const standingsFor = seq => get(`/ranks/lineups/editions/${EDITION_ID}/totals/${seq}?page=0&size=1000`);
const totalScore = s => (s.models || []).reduce((a, m) => a + (m.score || 0), 0);

/**
 * Haalt de stand op voor elke ronde vanaf de eerste ronde van deze editie.
 * Superteam geeft voor rondes die nog niet begonnen zijn dezelfde (cumulatieve)
 * stand terug als de laatste gespeelde ronde; daar stoppen we.
 */
async function allRounds() {
  const ed = await get(`/editions/${EDITION_ID}`);
  const first = ed.models[0].firstRoundSequence;
  const rounds = [];
  let prevSum = -1;
  for (let seq = first; seq < first + 40; seq++) {
    let s;
    try { s = await standingsFor(seq); } catch { break; }
    const sum = totalScore(s);
    if (!s.models || !s.models.length || sum <= prevSum) break;
    rounds.push({ seq, ronde: seq - first + 1, standings: s });
    prevSum = sum;
  }
  return rounds;
}

/* ---------- spelerspool uit index.html ---------- */
const PARTS = new Set(['van', 'von', 'de', 'der', 'den', 'du', 'da', 'das', 'dos', 'do', 'del', 'di', 'el', 'le', 'la', 'ter', 'te', 'ten', "'t", 'of', 'bin', 'al']);
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
function nameKey(naam) {
  const toks = norm(naam).split(' ');
  const rest = toks.slice(1);
  while (rest.length && PARTS.has(rest[0])) rest.shift();
  return [toks[0], ...rest].join(' ');
}

async function loadPool() {
  const html = await fs.readFile(POOL_FILE, 'utf-8');
  const m = html.match(/<script[^>]*id="pooldata"[^>]*>([\s\S]*?)<\/script>/);
  const rows = m[1].trim().split('\n').slice(1).map(l => {
    const [club, pos, naam] = l.split(',');
    return { club, pos, naam, id: club + '|' + naam };
  });
  const byKey = new Map();
  for (const p of rows) {
    const k = nameKey(p.naam);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(p);
  }
  return byKey;
}

function matchPlayer(byKey, apiPlayer, apiClub) {
  const naam = [apiPlayer.firstname, apiPlayer.prefix, apiPlayer.lastname].filter(Boolean).join(' ');
  const cand = byKey.get(nameKey(naam));
  if (!cand) return null;
  if (cand.length === 1) return cand[0];
  const c = norm(apiClub);
  return cand.find(p => c.includes(norm(p.club)) || norm(p.club).includes(c)) || cand[0];
}

/* ---------- werkelijke punten + populariteit ---------- */
async function crawlPlayers(seq, lineupIds) {
  const byKey = await loadPool();
  const views = await pool(lineupIds, 8, id => get(`/lineups/${id}/view`).catch(() => null));
  const details = await pool(lineupIds, 8, id => get(`/lineups/${id}/details/totals/${seq}`).catch(() => null));

  const playerPool = new Map(); // api playerId -> pool speler
  const ownCount = {}, clubCount = {};
  let teams = 0;
  views.forEach(v => {
    const lu = v && v.models && v.models[0];
    const list = lu && (lu.players || lu.subs);
    if (!list || !list.length) return;
    teams++;
    for (const e of list) {
      const p = matchPlayer(byKey, e.player || {}, e.club && e.club.name);
      if (!p) continue;
      playerPool.set(e.playerId, p);
      ownCount[p.id] = (ownCount[p.id] || 0) + 1;
      clubCount[p.club] = (clubCount[p.club] || 0) + 1;
    }
  });

  const actual = {};
  details.forEach(d => {
    for (const s of (d && d.models) || []) {
      const p = playerPool.get(s.playerId);
      if (!p || actual[p.id]) continue;
      actual[p.id] = {
        m: s.played || 0, tp: (s.winScore || 0) + (s.tieScore || 0), cs: s.zero || 0,
        g: s.goal || 0, y: s.yellow || 0, y2: s.yellow2 || 0, r: s.red || 0,
        og: s.ownGoal || 0, ps: s.penaltyStop || 0, pm: s.penaltyMiss || 0, tpm: 1, csm: 1
      };
    }
  });
  const okViews = views.filter(Boolean).length, okDetails = details.filter(Boolean).length;
  console.log(`Gecrawld: ${okViews}/${lineupIds.length} opstellingen, ${okDetails} puntenoverzichten, ${Object.keys(actual).length} spelers met punten.`);
  if (okViews < lineupIds.length * 0.95 || okDetails < lineupIds.length * 0.95) {
    throw new Error('Te veel opstellingen niet opgehaald, data.json niet aangepast.');
  }
  return {
    ownership: {
      totalTeams: teams,
      totalSlots: Object.values(clubCount).reduce((a, b) => a + b, 0),
      players: ownCount, clubs: clubCount
    },
    actual
  };
}

/* ---------- main ---------- */
async function main() {
  const { NTFY_TOPIC } = process.env;

  let prevState = {};
  try { prevState = JSON.parse(await fs.readFile(STATE_FILE, 'utf-8')); } catch { /* eerste run */ }
  let data = {};
  try { data = JSON.parse(await fs.readFile(DATA_FILE, 'utf-8')); } catch { /* bestaat nog niet */ }

  const rounds = await allRounds();
  if (!rounds.length) throw new Error('Geen standen gevonden.');
  const cur = rounds[rounds.length - 1];
  const signature = `${cur.seq}:${cur.standings.models.length}:${totalScore(cur.standings)}`;
  console.log(`Actuele ronde: ${cur.ronde} (sequence ${cur.seq}) | handtekening ${signature} | vorige ${prevState.signature || '(nog geen)'}`);

  // 1. Stand per ronde. De laatste ronde is "lopend" tot de volgende ronde punten krijgt.
  const history = rounds.map(r => ({
    ronde: r.ronde,
    seq: r.seq,
    asOf: `ronde ${r.ronde}`,
    final: r !== cur,
    totalTeams: r.standings.models.length,
    teams: MY_LINEUPS.map(t => {
      const m = r.standings.models.find(x => x.lineupId === t.lineupId);
      return { lineupId: t.lineupId, naam: t.naam, rank: m ? m.rank : null, punten: m ? m.score : null };
    })
  }));
  const before = JSON.stringify(data);
  data.history = history;

  // 2. Spelerspunten + populariteit: bij een gewijzigde stand of als ze achterlopen.
  const asOf = `tot en met ronde ${cur.ronde}`;
  const changed = prevState.signature !== signature;
  if (changed || !data.actual || data.actual.asOf !== asOf || process.env.FORCE_CRAWL) {
    const lineupIds = cur.standings.models.map(m => m.lineupId);
    const res = await crawlPlayers(cur.seq, lineupIds);
    data.actual = { asOf, players: res.actual };
    data.ownership = { asOf, ...res.ownership };
  }

  if (JSON.stringify(data) !== before) {
    data.updatedAt = new Date().toISOString();
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
    console.log('data.json bijgewerkt.');
  } else {
    console.log('Niets veranderd in data.json.');
  }

  // 3. Melding (pas na het wegschrijven, zodat de site al klopt als je kijkt).
  if (prevState.signature && prevState.signature.split(':').length === 3 && changed && NTFY_TOPIC) {
    const me = history[history.length - 1].teams.map(t => `${t.naam}: #${t.rank} (${t.punten} pt)`).join(', ');
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { Title: `Superteam bijgewerkt, ronde ${cur.ronde}` },
      body: me
    });
    console.log('Melding verstuurd.');
  }

  await fs.writeFile(STATE_FILE, JSON.stringify({ signature, checkedAt: new Date().toISOString() }, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
