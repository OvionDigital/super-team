#!/usr/bin/env node
/**
 * Draait elke paar minuten via GitHub Actions en doet drie dingen:
 *  1. Stand per ronde bijhouden (rang en punten van Simons twee teams aan
 *     het einde van elke ronde) in data.json -> history.
 *  2. Werkelijke punten per speler en populariteit (ownership) opnieuw
 *     ophalen zodra de stand verandert, in data.json -> actual / ownership.
 *  3. Een pushmelding via ntfy.sh sturen als de stand is bijgewerkt.
 *  4. Een voorlopige stand berekenen voor wedstrijden die Superteam nog niet
 *     heeft verwerkt, op basis van ESPN, in data.json -> live.
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
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer/ned.1';
const EDITION_ID = 13;
const STATE_FILE = 'state.json';
const DATA_FILE = 'data.json';
const POOL_FILE = 'index.html'; // spelerslijst staat in <script id="pooldata">

const MY_LINEUPS = [
  { lineupId: 5485, naam: 'FC Sportfreunden' },
  { lineupId: 5486, naam: 'Prive' }
];

/* ---------- API ---------- */
async function getUrl(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} op ${url}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
}

const get = (path, tries) => getUrl(API + path, tries);

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const edition = { first: null, seasonId: null };
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
  edition.first = first;
  edition.seasonId = ed.models[0].seasonId;
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
  const views = await pool(lineupIds, 4, id => get(`/lineups/${id}/view`).catch(() => null));
  const details = await pool(lineupIds, 4, id => get(`/lineups/${id}/details/totals/${seq}`).catch(() => null));

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
        g: (s.goal || 0) + (s.penaltyHit || 0), y: s.yellow || 0, y2: s.yellow2 || 0, r: s.red || 0,
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
    actual,
    views: lineupIds.map((id, i) => ({ id, view: views[i] }))
  };
}

/* ---------- opstellingen bewaren voor de voorlopige stand ---------- */
async function buildSquads(viewList, previous) {
  const prevTeams = new Map(((previous && previous.teams) || []).map(t => [t.id, t]));
  const prevPlayers = (previous && previous.players) || [];

  const players = [], index = new Map(), clubs = { ...((previous && previous.clubs) || {}) };
  const addPlayer = p => {
    if (!index.has(p.pid)) { index.set(p.pid, players.length); players.push(p); }
    return index.get(p.pid);
  };
  const teams = viewList.map(({ id, view }) => {
    const lu = view && view.models && view.models[0];
    const list = lu && (lu.players || lu.subs);
    if (!list || !list.length) {
      const old = prevTeams.get(id);
      if (!old) return { id, n: `Team ${id}`, s: [] };
      return { ...old, s: old.s.map(i => addPlayer(prevPlayers[i])) };
    }
    const mine = MY_LINEUPS.find(t => t.lineupId === id);
    const s = list.map(e => {
      clubs[e.club.id] = e.club.name;
      return addPlayer({
        pid: e.playerId,
        f: e.player.firstname || '', x: e.player.prefix || '', l: e.player.lastname || '',
        c: e.club.name, p: (e.transfer && e.transfer.position) || 'A'
      });
    });
    return { id, n: mine ? mine.naam : `Team ${id}`, s };
  });
  return { teams, players, clubs };
}

/* ---------- voorlopige stand ---------- */
const CLUB_KEYS = ['ado', 'az', 'ajax', 'cambuur', 'excelsior', 'twente', 'utrecht', 'feyenoord', 'fortuna', 'go ahead', 'groningen', 'nec', 'pec', 'psv', 'heerenveen', 'sparta', 'telstar', 'willem'];
const fold = s => String(s || '').replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae').replace(/ß/g, 'ss').replace(/[þÞ]/g, 'th')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function clubKey(name) {
  const n = fold(name);
  return CLUB_KEYS.find(k => n.split(' ').includes(k) || (k.length > 3 && n.includes(k))) || n;
}
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function findRow(rows, p) {
  const ck = clubKey(p.c), fn = fold(p.f), ln = fold(p.l);
  const full = fold([p.f, p.x, p.l].filter(Boolean).join(' '));
  const c = rows.filter(r => r.ck === ck);
  const last = ln.split(' ').pop();
  const tail = r => r.nn.split(' ').pop();
  return c.find(r => r.nn === full) || c.find(r => r.nn === fold(`${p.f} ${p.l}`))
    || c.find(r => r.nn.endsWith(' ' + ln) && r.nn[0] === fn[0]) || c.find(r => r.nn.endsWith(' ' + ln))
    || c.find(r => tail(r) === last && r.nn[0] === fn[0])
    || (last.length >= 6 && c.find(r => r.nn[0] === fn[0] && distance(tail(r), last) <= 2)) || null;
}
function playerPoints(m, pos) {
  if (!m || !m.app) return 0;
  const goal = pos === 'K' || pos === 'D' ? 6 : pos === 'M' ? 4 : 3;
  const clean = m.ga === 0 ? (pos === 'K' ? 4 : pos === 'D' ? 1 : 0) : 0;
  const result = m.gf > m.ga ? 3 : m.gf === m.ga ? 1 : 0;
  return 1 + result + clean + m.g * goal - m.y - 2 * m.y2 - 4 * m.r - 2 * m.og + 3 * m.ps - 3 * m.pm;
}
function matchRows(s) {
  const comp = s.header.competitions[0];
  const score = {};
  comp.competitors.forEach(c => { score[c.homeAway] = Number(c.score) || 0; });
  const second = new Set(), missed = {}, stopped = { home: 0, away: 0 };
  const sideOf = name => {
    for (const r of s.rosters || []) if ((r.roster || []).some(p => p.athlete.displayName === name)) return r.homeAway;
    return null;
  };
  for (const k of s.keyEvents || []) {
    const type = (k.type && k.type.text) || '';
    const who = ((k.participants || [])[0] || {}).athlete;
    const name = who && who.displayName;
    if (/second yellow/i.test(k.text || '') && name) second.add(name);
    if (/^Penalty - (Missed|Saved)/i.test(type) && name) {
      missed[name] = (missed[name] || 0) + 1;
      const side = sideOf(name);
      if (side) stopped[side === 'home' ? 'away' : 'home']++;
    }
  }
  const rows = [];
  for (const r of s.rosters || []) {
    const gf = score[r.homeAway], ga = score[r.homeAway === 'home' ? 'away' : 'home'], ck = clubKey(r.team.displayName);
    let keeperDone = false;
    for (const p of r.roster || []) {
      const st = {};
      (p.stats || []).forEach(x => { st[x.name] = x.value; });
      const name = p.athlete.displayName, two = second.has(name), app = st.appearances ? 1 : 0;
      const isKeeper = !keeperDone && app && p.position && p.position.abbreviation === 'G';
      if (isKeeper) keeperDone = true;
      rows.push({
        nn: fold(name), ck, app, gf, ga, g: st.totalGoals || 0, og: st.ownGoals || 0,
        y: two ? 1 : (st.yellowCards || 0), y2: two ? 1 : 0, r: two ? 0 : (st.redCards || 0),
        pm: missed[name] || 0, ps: isKeeper ? stopped[r.homeAway] : 0
      });
    }
  }
  return rows;
}
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');

async function computeLive(seasonId, standings, cur, squads) {
  const roundList = (await get(`/seasons/${seasonId}/rounds`)).models.filter(r => r.sequence >= cur.first);
  const perRound = await pool(roundList, 4, r => get(`/rounds/${r.id}/matches`).then(m => m.models || []));

  const events = new Map();
  const days = Array.from({ length: 17 }, (_, i) => ymd(new Date(Date.now() + (1 - i) * 86400000)));
  const boards = await pool(days, 3, d => getUrl(`${ESPN}/scoreboard?dates=${d}`));
  boards.forEach(b => (b.events || []).forEach(e => {
    const c = e.competitions[0], team = side => c.competitors.find(x => x.homeAway === side);
    events.set(`${clubKey(team('home').team.displayName)}|${clubKey(team('away').team.displayName)}`, {
      id: e.id, date: e.date, state: e.status.type.state, detail: e.status.type.shortDetail,
      hs: Number(team('home').score), as: Number(team('away').score)
    });
  }));

  const rounds = roundList.map((r, i) => ({
    seq: r.sequence,
    matches: perRound[i].map(m => {
      const home = squads.clubs[m.homeClubId], away = squads.clubs[m.awayClubId];
      const ev = events.get(`${clubKey(home)}|${clubKey(away)}`);
      return { home, away, official: m.homeScore != null, hs: m.homeScore, as: m.awayScore, ev };
    })
  }));

  const open = rounds.flatMap(r => r.matches).filter(m => !m.official && m.ev && m.ev.state !== 'pre');
  const summaries = await pool(open, 3, m => getUrl(`${ESPN}/summary?event=${m.ev.id}`));
  const perMatch = summaries.map(matchRows);

  const score = new Map(standings.models.map(m => [m.lineupId, m]));
  const pts = squads.players.map(p => perMatch.reduce((a, rows) => a + playerPoints(findRow(rows, p), p.p), 0));
  const result = squads.teams.map(t => {
    const o = score.get(t.id) || { score: 0, rank: null };
    const add = t.s.reduce((a, i) => a + pts[i], 0);
    return { id: t.id, n: t.n, or: o.rank, o: o.score, l: o.score + add, ok: t.s.length === 11 };
  }).sort((a, b) => b.l - a.l || a.or - b.or);
  let rank = 0, last = null;
  result.forEach((r, i) => { if (r.l !== last) { rank = i + 1; last = r.l; } r.r = rank; });

  const started = rounds.filter(r => r.matches.some(m => m.official || (m.ev && m.ev.state !== 'pre')));
  const shown = started[started.length - 1] || rounds[0];
  const status = m => m.official ? 'official' : !m.ev || m.ev.state === 'pre' ? 'pre' : m.ev.state === 'in' ? 'live' : 'done';
  return {
    ronde: shown.seq - cur.first + 1,
    counted: open.length,
    incomplete: result.filter(r => !r.ok).length,
    matches: shown.matches.map(m => ({
      h: m.home, a: m.away, st: status(m),
      hs: m.official ? m.hs : m.ev && m.ev.state !== 'pre' ? m.ev.hs : null,
      as: m.official ? m.as : m.ev && m.ev.state !== 'pre' ? m.ev.as : null,
      t: m.ev && m.ev.state === 'in' ? m.ev.detail : null,
      d: m.ev ? m.ev.date : null
    })).sort((x, y) => String(x.d).localeCompare(String(y.d))),
    rows: result.map(({ ok, ...r }) => r)
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
  if (changed || !data.actual || !data.squads || data.actual.asOf !== asOf || process.env.FORCE_CRAWL) {
    const lineupIds = cur.standings.models.map(m => m.lineupId);
    const res = await crawlPlayers(cur.seq, lineupIds);
    data.actual = { asOf, players: res.actual };
    data.ownership = { asOf, ...res.ownership };
    data.squads = await buildSquads(res.views, data.squads);
  }

  // 3. Voorlopige stand. Een storing hier mag de rest van de run niet raken.
  try {
    const live = await computeLive(edition.seasonId, cur.standings, { first: edition.first }, data.squads);
    const { updatedAt: _a, error: _b, ...previous } = data.live || {};
    if (JSON.stringify(previous) !== JSON.stringify(live) || (data.live && data.live.error)) {
      data.live = { updatedAt: new Date().toISOString(), ...live };
    }
    console.log(`Voorlopige stand: ronde ${live.ronde}, ${live.counted} wedstrijd(en) meegerekend.`);
  } catch (err) {
    console.error('Voorlopige stand mislukt:', err);
    data.live = { ...(data.live || {}), error: 'De voorlopige stand kon niet worden bijgewerkt.' };
  }

  if (JSON.stringify(data) !== before) {
    data.updatedAt = new Date().toISOString();
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
    console.log('data.json bijgewerkt.');
  } else {
    console.log('Niets veranderd in data.json.');
  }

  // 4. Melding (pas na het wegschrijven, zodat de site al klopt als je kijkt).
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
