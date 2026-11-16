// =====================================================================
// VIP FOOTBALL LEAGUE — public website (data + pages + routing)
// READ-ONLY: visitors can never change anything.
// All data comes live from Firestore. Card designs are in components.js,
// colours in css/theme.css, section order in site-config.js.
// =====================================================================
import { db } from './firebase-config.js';
import { collection, doc, onSnapshot, query, where } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js';
import {
  LEAGUE_NAME, mergeSettings, emptyStats, rankRows, SORT_OPTIONS, esc, safeImg, splitGoals,
  fmtDate, fmtTime, money, toNum, auctionHtml, eligibleTiers, scoreKnown,
} from './lib.js';
import {
  avatar, statusChip, emptyBox, resultText, scoreBlock, teamCol, dateLine, matchCard, playerCard, newsCard, statTile,
} from './components.js';
import { HOME_SECTIONS, FEATURED_PLAYERS_COUNT, HOME_NEWS_COUNT, LEADERBOARD_DEFAULT_SORT } from './site-config.js';

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
const state = {
  settings: mergeSettings(null),
  players: [],
  stats: new Map(),
  matches: [],
  news: [],
  ready: { settings: false, players: false, stats: false, matches: false, news: false },
  errors: {},
  pm: [],
  pmKey: null,
  pmReady: false,
  lbSort: LEADERBOARD_DEFAULT_SORT,
  rankMemory: {},
  rankDelta: {},
  moved: new Set(),
  filter: 'all',
  search: '',
  showInactive: false,
  animate: true,
  lastPage: null,
};

const $view = document.getElementById('view');
const $banner = document.getElementById('banner');
document.getElementById('year').textContent = new Date().getFullYear();

// ---------------------------------------------------------------------
// Live Firestore listeners (the site updates by itself, no refresh needed)
// ---------------------------------------------------------------------
function listen(name, ref, onData) {
  onSnapshot(
    ref,
    (snap) => {
      try { onData(snap); } catch (e) { console.error(name, e); }
      state.ready[name] = true;
      delete state.errors[name];
      scheduleRender();
    },
    (err) => {
      console.error('Firestore error on', name, err);
      state.ready[name] = true;
      state.errors[name] = err;
      scheduleRender();
    }
  );
}
const docsOf = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

listen('settings', doc(db, 'settings', 'league'), (snap) => { state.settings = mergeSettings(snap.exists() ? snap.data() : null); });
listen('players', collection(db, 'players'), (snap) => { state.players = docsOf(snap).sort((a, b) => String(a.name).localeCompare(String(b.name))); });
listen('stats', collection(db, 'playerStats'), (snap) => { state.stats = new Map(snap.docs.map((d) => [d.id, d.data()])); });
listen('matches', collection(db, 'matches'), (snap) => { state.matches = docsOf(snap); });
listen('news', collection(db, 'announcements'), (snap) => { state.news = docsOf(snap).sort((a, b) => toNum(b.dateMs) - toNum(a.dateMs)); });

// playerMatches are loaded only on a player page / match page
let pmUnsub = null;
function syncPm() {
  const { page, id } = route();
  let field = null;
  let key = null;
  if (page === 'player' && id) { field = 'playerId'; key = `playerId:${id}`; }
  else if (page === 'match' && id) { field = 'matchId'; key = `matchId:${id}`; }
  if (key === state.pmKey) return;
  if (pmUnsub) { pmUnsub(); pmUnsub = null; }
  state.pm = [];
  state.pmKey = key;
  state.pmReady = !key;
  if (!key) return;
  pmUnsub = onSnapshot(
    query(collection(db, 'playerMatches'), where(field, '==', id)),
    (snap) => { state.pm = docsOf(snap); state.pmReady = true; delete state.errors.pm; scheduleRender(); },
    (err) => { console.error(err); state.pmReady = true; state.errors.pm = err; scheduleRender(); }
  );
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [page, id] = h.split('/');
  return { page: page || 'home', id: id ? decodeURIComponent(id) : null };
}
const playerById = (id) => state.players.find((p) => p.id === id);
const matchesSorted = () => [...state.matches].sort((a, b) => toNum(b.number) - toNum(a.number));
function statsFor(p) {
  const s = { ...emptyStats(), ...(state.stats.get(p.id) || {}) };
  s.goals = toNum(s.normalGoals) + toNum(s.penaltyGoals);
  // The reward ledger lives on the player document, so the balance is always fresh.
  s.rewardBalance = toNum(s.rewardEarned) + (p.rewardLedger || []).reduce((t, e) => t + toNum(e.points), 0);
  return s;
}
const rowsAll = () => state.players.map((p) => ({ p, s: statsFor(p) }));
const cur = () => state.settings.reward.currencySymbol;
const pCard = (p, i = 0) => playerCard(p, statsFor(p), i);
const mCard = (m) => matchCard(m, cur());

function friendlyError(err) {
  const code = err && err.code ? err.code : '';
  if (code === 'permission-denied') return 'Firestore is blocking reads. Publish the rules from firestore.rules in the Firebase console.';
  if (code === 'unavailable' || code === 'deadline-exceeded') return 'Cannot reach the server. Check your internet connection — the page will recover by itself.';
  return (err && err.message) || 'Unknown error';
}

// ---------------------------------------------------------------------
// Home page — sections are listed in site-config.js (HOME_SECTIONS)
// ---------------------------------------------------------------------
const HOME = {
  hero() {
    const logo = safeImg(state.settings.logo) || 'assets/logo.svg';
    return `<section class="hero">
      <img class="hero-logo" src="${esc(logo)}" alt="${LEAGUE_NAME} logo">
      <h1>VIP <span>FOOTBALL</span> LEAGUE</h1>
      <p>${esc(state.settings.tagline)}</p>
      <div class="hero-actions"><a class="btn primary" href="#/matches">View Matches</a><a class="btn" href="#/leaderboard">Leaderboard</a><a class="btn ghost" href="#/auction">Auction History</a></div>
    </section>`;
  },
  stats() {
    const done = state.matches.filter((m) => m.status === 'completed');
    const goals = rowsAll().reduce((s, r) => s + r.s.goals, 0);
    const auctions = state.matches.filter((m) => (m.teams || []).some((t) => (t.picks || []).length)).length;
    const tile = (v, l) => `<div class="card stat-tile"><b data-count="${v}">${v}</b><span>${l}</span></div>`;
    return `<section class="section"><div class="grid cols-4">${tile(done.length, 'Matches played')}${tile(state.players.length, 'Registered players')}${tile(goals, 'Goals scored')}${tile(auctions, 'Auctions held')}</div></section>`;
  },
  live() {
    const live = state.matches.filter((m) => m.status === 'live');
    return `<section class="section"><div class="section-head"><h2>Live now</h2></div>
      ${live.length ? `<div class="grid">${live.map(mCard).join('')}</div>` : '<div class="empty">No match is live right now.</div>'}</section>`;
  },
  fixtures() {
    const upcoming = state.matches.filter((m) => m.status === 'upcoming').sort((a, b) => toNum(a.dateMs) - toNum(b.dateMs));
    const latest = state.matches.filter((m) => m.status === 'completed').sort((a, b) => toNum(b.number) - toNum(a.number))[0];
    return `<section class="section"><div class="grid cols-2 wide">
      <div><div class="section-head"><h2>Next match</h2><a href="#/matches">All matches</a></div>${upcoming[0] ? mCard(upcoming[0]) : emptyBox('No upcoming match', 'The next match will appear here once the admin schedules it.')}</div>
      <div><div class="section-head"><h2>Latest result</h2></div>${latest ? mCard(latest) : emptyBox('No results yet', 'Finished matches will show up here.')}</div>
    </div></section>`;
  },
  players() {
    let list = rankRows(rowsAll().filter((r) => r.p.active !== false), 'goals').filter((r) => r.s.goals > 0 || r.s.wins > 0).slice(0, FEATURED_PLAYERS_COUNT).map((r) => r.p);
    const label = list.length ? 'Featured players' : 'Players';
    if (!list.length) list = state.players.filter((p) => p.active !== false).slice(0, FEATURED_PLAYERS_COUNT);
    return `<section class="section"><div class="section-head"><h2>${label}</h2><a href="#/players">All players</a></div>
      ${list.length ? `<div class="grid cols-4 players-grid">${list.map(pCard).join('')}</div>` : emptyBox('No players yet', 'Players will appear here once the admin adds them.')}</section>`;
  },
  news() {
    return `<section class="section"><div class="section-head"><h2>Announcements</h2><a href="#/news">View all</a></div>
      ${state.news.length ? `<div class="grid">${state.news.slice(0, HOME_NEWS_COUNT).map(newsCard).join('')}</div>` : emptyBox('No announcements', 'League notices will appear here.')}</section>`;
  },
};
const homePage = () => HOME_SECTIONS.map((k) => (HOME[k] ? HOME[k]() : '')).join('');

// ---------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------
function matchesPage() {
  const order = { live: 0, upcoming: 1, completed: 2 };
  const count = (st) => state.matches.filter((m) => m.status === st).length;
  const list = state.matches
    .filter((m) => state.filter === 'all' || m.status === state.filter)
    .sort((a, b) => (order[a.status] - order[b.status]) || (a.status === 'upcoming' ? toNum(a.dateMs) - toNum(b.dateMs) : toNum(b.number) - toNum(a.number)));
  const tab = (k, label, n) => `<button class="tab ${state.filter === k ? 'active' : ''}" data-filter="${k}">${label} (${n})</button>`;
  return `<h1 class="page-title">Matches</h1><p class="page-sub">Live scores, fixtures and results.</p>
    <div class="tabs">${tab('all', 'All', state.matches.length)}${tab('live', 'Live', count('live'))}${tab('upcoming', 'Upcoming', count('upcoming'))}${tab('completed', 'Completed', count('completed'))}</div>
    ${list.length ? `<div class="grid cols-2 wide">${list.map(mCard).join('')}</div>` : emptyBox('No matches here', 'Nothing to show for this filter yet.')}`;
}

function matchPage(id) {
  const m = state.matches.find((x) => x.id === id);
  if (!m) return `<a class="back" href="#/matches">← Matches</a>${emptyBox('Match not found', 'It may have been removed.')}`;
  const teams = m.teams || [];
  const sc = m.scores || [];
  const scorers = state.pm.filter((r) => splitGoals(r).total > 0).sort((a, b) => splitGoals(b).total - splitGoals(a).total || String(a.playerName).localeCompare(String(b.playerName)));
  const totN = state.pm.reduce((s, r) => s + splitGoals(r).normal, 0);
  const totP = state.pm.reduce((s, r) => s + splitGoals(r).pen, 0);
  const board = teams.length === 2
    ? `<div class="mc-vs">${teamCol(teams[0])}${scoreBlock(m)}${teamCol(teams[1])}</div>`
    : `<div class="mc-list">${teams.map((t, i) => `<div class="row" style="--tc:${esc(t.color)}"><b>${esc(t.name)}</b>${m.status === 'upcoming' || !scoreKnown(m) ? '' : `<span class="mc-score" style="font-size:30px">${toNum(sc[i])}</span>`}</div>`).join('')}</div>`;
  const res = resultText(m);
  const scorerRows = scorers.map((r) => {
    const g = splitGoals(r);
    const parts = [g.normal ? `${g.normal} normal` : '', g.pen ? `${g.pen} penalty` : ''].filter(Boolean).join(' · ');
    return `<div class="roster-row"><span class="nm">${esc(r.playerName)}</span><span class="small muted">${esc(r.teamName)} · ${parts}</span><span class="pts">${g.total} ⚽</span></div>`;
  }).join('');
  return `<a class="back" href="#/matches">← Matches</a>
    <div class="card scoreboard ${m.status === 'live' ? 'live-card' : 'glow'}">
      <div class="mc-top" style="justify-content:center;gap:12px"><span>Match #${esc(m.number)}</span>${statusChip(m)}</div>
      ${board}
      ${res ? `<p class="${m.result ? 'green' : 'muted'}" style="margin-top:12px;font-weight:700">${esc(res)}</p>` : ''}
      <div class="mc-foot" style="justify-content:center"><span>${dateLine(m)}</span>${m.venue ? `<span>${esc(m.venue)}</span>` : ''}</div>
    </div>
    ${scorers.length ? `<section class="section"><div class="section-head"><h2>Goal scorers</h2></div><div class="card">${scorerRows}
      <div class="roster-row"><span class="nm muted">Total recorded goals</span><span class="small muted">${totN} normal · ${totP} penalty</span><span class="pts">${totN + totP} ⚽</span></div></div></section>` : ''}
    <section class="section"><div class="section-head"><h2>Teams &amp; auction</h2></div>
      ${teams.some((t) => t.captainId) ? auctionHtml(m) : emptyBox('Auction not held yet', 'Captains and teams will appear after the auction.')}
    </section>
    ${(m.notes || []).length ? `<section class="section"><div class="card"><h3 style="font-size:20px;margin-bottom:6px">Notes</h3><ul class="notes">${m.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div></section>` : ''}`;
}

function playersGridHtml() {
  const q = state.search.trim().toLowerCase();
  const list = state.players.filter((p) => (state.showInactive || p.active !== false) && (!q || String(p.name).toLowerCase().includes(q) || String(p.jersey).includes(q) || String(p.position || '').toLowerCase().includes(q)));
  if (!state.players.length) return emptyBox('No players yet', 'Players will appear here once the admin adds them.');
  if (!list.length) return emptyBox('No match', 'No player matches your search.');
  return `<div class="grid cols-3 players-grid">${list.map(pCard).join('')}</div>`;
}
function playersPage() {
  return `<h1 class="page-title">Players</h1><p class="page-sub">Tap a player to see their full profile and auction history.</p>
    <input id="playerSearch" class="search" type="search" placeholder="Search by name, jersey number or position…" value="${esc(state.search)}" autocomplete="off">
    <label class="small muted" style="display:flex;gap:8px;align-items:center;margin:-4px 0 14px"><input type="checkbox" id="showInactive" ${state.showInactive ? 'checked' : ''}> Show inactive players</label>
    <div id="playersGrid">${playersGridHtml()}</div>`;
}

function playerPage(id) {
  const p = playerById(id);
  if (!p) return `<a class="back" href="#/players">← Players</a>${emptyBox('Player not found', 'This player may not exist.')}`;
  const s = statsFor(p);
  const tiers = eligibleTiers(s.rewardBalance, state.settings.reward.tiers);
  const best = tiers[tiers.length - 1];
  const hist = [...state.pm].sort((a, b) => toNum(b.matchNumber) - toNum(a.matchNumber));
  const vice = hist.filter((r) => r.isVice && r.matchStatus === 'completed').length;
  const histHtml = !state.pmReady
    ? '<div class="loading" style="padding:30px 0"><div class="spinner"></div></div>'
    : hist.length
      ? hist.map((r) => {
          const mt = state.matches.find((x) => x.id === r.matchId);
          const color = mt && mt.teams && mt.teams[r.teamIndex] ? mt.teams[r.teamIndex].color : '#00ff6a';
          const role = r.isCaptain
            ? `<span class="chip captain">Captain</span> ${r.budget ? `<span class="small muted">budget ${toNum(r.budget.startingPoints)} + ${toNum(r.budget.bonusPoints)} bonus → ${toNum(r.budget.usablePoints)} usable</span>` : ''}`
            : `${r.isVice ? '<span class="chip captain">Vice</span> ' : ''}<span class="small muted">Bought for</span> <b class="green">${toNum(r.auctionPoints)} pts</b>`;
          const g = splitGoals(r);
          return `<a class="hist-row" style="--tc:${esc(color)}" href="#/match/${esc(r.matchId)}">
            <span class="hn">#${esc(r.matchNumber)}</span>
            <div><b>${esc(r.teamName)}</b><div class="small">${role}</div><div class="small muted">${r.matchDateMs ? fmtDate(r.matchDateMs) : 'Date not recorded'}</div></div>
            <div style="text-align:right">${r.result ? `<span class="chip ${esc(r.result)}">${esc(r.result)}</span>` : `<span class="chip ${esc(r.matchStatus)}">${r.matchStatus === 'completed' ? 'result n/a' : esc(r.matchStatus)}</span>`}<div class="small muted" style="margin-top:4px">${g.total} goal${g.total === 1 ? '' : 's'}${g.pen ? ` (${g.pen} pen)` : ''}</div></div>
          </a>`;
        }).join('')
      : emptyBox('No auction history yet', 'This player has not been part of an auction.');
  return `<a class="back" href="#/players">← Players</a>
    <div class="card glow">
      <div class="profile-head">${avatar(p, 'xl')}<div><h1>${esc(p.name)}</h1><p class="muted">${esc(p.position || 'Position not set')}${p.jersey !== undefined && p.jersey !== '' ? ' · Jersey #' + esc(p.jersey) : ''}${p.active === false ? ' · Inactive' : ''}</p></div></div>
      <div class="big-stats">
        ${statTile(s.matches, 'Matches')}${statTile(s.wins, 'Wins')}${statTile(s.losses, 'Losses')}${statTile(s.draws, 'Draws')}
        ${statTile(s.normalGoals, 'Normal goals')}${statTile(s.penaltyGoals, 'Penalty goals')}${statTile(s.goals, 'Total goals')}${statTile(s.rewardBalance, 'Reward pts')}
        ${statTile(s.captainCount, 'Captain')}${statTile(vice, 'Vice-captain')}${statTile(s.highestPrice, 'Top price')}${statTile(s.winRate + '%', 'Win rate')}
      </div>
      ${s.hasAdjust ? '<p class="small muted" style="margin-top:12px;text-align:center">Includes manual corrections made by the admin.</p>' : ''}
      ${best ? `<p class="small" style="margin-top:14px;text-align:center">Eligible for up to <b class="green">${money(best.discount, cur())}</b> entry-fee discount (${best.points} reward points tier).</p>` : ''}
    </div>
    <section class="section"><div class="section-head"><h2>Match &amp; auction history</h2></div>${histHtml}</section>`;
}

function leaderboardPage() {
  const key = state.lbSort;
  const rows = rowsAll().filter((r) => r.p.active !== false || r.s.matches > 0);
  const ranked = rankRows(rows, key);

  // rank changes since this page was opened
  const now = new Map(ranked.map((r) => [r.p.id, r.rank]));
  const before = state.rankMemory[key];
  if (before) {
    now.forEach((rk, pid) => {
      const old = before.get(pid);
      if (old !== undefined && old !== rk) { state.rankDelta[pid] = old - rk; state.moved.add(pid); }
    });
  }
  state.rankMemory[key] = now;

  const tabs = SORT_OPTIONS.map((o) => `<button class="tab ${key === o.key ? 'active' : ''}" data-lb="${o.key}">${o.label}</button>`).join('');
  const list = ranked.length
    ? `<div class="lb"><div class="lb-head"><span>#</span><span>Player</span><span>W</span><span>G</span><span>RP</span><span>MP</span></div>
      ${ranked.map((r) => {
        const d = state.rankDelta[r.p.id];
        const arrow = d ? `<small class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</small>` : '';
        return `<a class="lb-row ${r.rank <= 3 && toNum(r.s[key]) > 0 ? 'r' + r.rank : ''} ${state.moved.has(r.p.id) ? 'moved' : ''}" data-id="${esc(r.p.id)}" href="#/player/${esc(r.p.id)}">
          <div class="rank">${r.rank}${arrow}</div>
          <div class="lb-who">${avatar(r.p, 'sm')}<div class="nm">${esc(r.p.name)}<small>${esc(r.p.position || '')}</small></div></div>
          <div class="num ${key === 'wins' ? 'key' : ''}">${r.s.wins}</div>
          <div class="num ${key === 'goals' ? 'key' : ''}">${r.s.goals}</div>
          <div class="num ${key === 'rewardBalance' ? 'key' : ''}">${r.s.rewardBalance}</div>
          <div class="num ${key === 'matches' ? 'key' : ''}">${r.s.matches}</div>
        </a>`;
      }).join('')}</div>`
    : emptyBox('No rankings yet', 'Rankings appear after players are added.');
  state.moved.clear();

  const tiers = state.settings.reward.tiers;
  return `<h1 class="page-title">Leaderboard</h1><p class="page-sub">W = wins · G = goals · RP = reward points · MP = matches played</p>
    <div class="tabs">${tabs}</div>${list}
    <section class="section"><div class="card"><div class="section-head" style="margin-bottom:6px"><h2 style="font-size:22px">Reward Points</h2></div>
      <p class="small muted">Reward Points are separate from Auction Points. They can be redeemed for entry-fee discounts (rules may change):</p>
      ${tiers.length ? `<table class="tier-table">${tiers.map((t) => `<tr><td>${t.points} reward points</td><td>${money(t.discount, cur())} off</td></tr>`).join('')}</table>` : '<p class="small muted">No discount table set yet.</p>'}
    </div></section>`;
}

function auctionPage() {
  const list = matchesSorted().filter((m) => (m.teams || []).some((t) => t.captainId || (t.picks || []).length));
  if (!list.length) return `<h1 class="page-title">Auction</h1><p class="page-sub">Every match has a brand-new auction.</p>${emptyBox('No auctions yet', 'Auction history appears here after the first auction.')}`;
  const domOpen = state.lastPage === 'auction' ? new Set([...document.querySelectorAll('details.auc-match[open]')].map((d) => d.dataset.id)) : null;
  return `<h1 class="page-title">Auction</h1>
    <p class="page-sub">Teams are never permanent — every match gets new captains, a fresh auction and new teams. Auction Points are bidding points, not money.</p>
    <div class="grid">${list.map((m, i) => {
      const spent = (m.teams || []).reduce((s, t) => s + toNum(t.spentPoints), 0);
      return `<details class="card auc-match" data-id="${esc(m.id)}" ${(domOpen ? domOpen.has(m.id) : i === 0) ? 'open' : ''}>
      <summary><div><h3 style="font-size:24px">Match #${esc(m.number)}</h3><span class="small muted">${m.dateMs ? fmtDate(m.dateMs) : 'Date not recorded'} · ${spent} points spent in total</span></div>
        <div style="text-align:right">${statusChip(m)} <span class="chip ${m.auctionStatus === 'completed' ? 'completed' : ''}">Auction ${esc(m.auctionStatus === 'completed' ? 'complete' : m.auctionStatus === 'inProgress' ? 'in progress' : 'pending')}</span></div></summary>
      ${auctionHtml(m)}
    </details>`;
    }).join('')}</div>`;
}

function rankList(title, rows, key, fmt = (v) => v, sub) {
  const top = rankRows(rows, key).filter((r) => toNum(r.s[key]) >= 1).slice(0, 5);
  return `<div class="card"><div class="section-head" style="margin-bottom:8px"><h2 style="font-size:21px">${title}</h2></div>
    ${top.length ? `<div class="rank-list">${top.map((r) => `<a class="row" href="#/player/${esc(r.p.id)}"><span class="pos">${r.rank}</span>${avatar(r.p, 'sm')}<span class="nm">${esc(r.p.name)}${sub ? `<span class="small muted"> · ${sub(r)}</span>` : ''}</span><span class="val">${fmt(r.s[key])}</span></a>`).join('')}</div>` : '<p class="small muted">Not enough data yet.</p>'}</div>`;
}

function statsPage() {
  const done = state.matches.filter((m) => m.status === 'completed');
  const rows = rowsAll();
  const normal = rows.reduce((s, r) => s + r.s.normalGoals, 0);
  const pen = rows.reduce((s, r) => s + r.s.penaltyGoals, 0);
  const goals = normal + pen;
  const decided = done.filter((m) => m.result && m.result.outcome === 'win').length;
  const draws = done.filter((m) => m.result && m.result.outcome === 'draw').length;
  let spent = 0, topPick = null, bigWin = null;
  state.matches.forEach((m) => {
    (m.teams || []).forEach((t) => {
      spent += toNum(t.spentPoints);
      (t.picks || []).forEach((p) => { if (!topPick || toNum(p.points) > topPick.points) topPick = { points: toNum(p.points), name: p.playerName, num: m.number }; });
    });
    if (m.status === 'completed' && m.result && m.result.outcome === 'win' && scoreKnown(m)) {
      const s2 = (m.scores || []).map(toNum).sort((a, b) => b - a);
      const margin = s2[0] - (s2[1] ?? 0);
      if (!bigWin || margin > bigWin.margin) bigWin = { margin, m };
    }
  });
  const tile = (v, l) => `<div class="card stat-tile"><b>${v}</b><span>${l}</span></div>`;
  return `<h1 class="page-title">Statistics</h1><p class="page-sub">League numbers, updated live. Only completed matches are counted.</p>
    <div class="grid cols-4">
      ${tile(state.players.length, 'Registered players')}${tile(done.length, 'Matches played')}
      ${tile(goals, 'Total goals')}${tile(normal, 'Normal goals')}
      ${tile(pen, 'Penalty goals')}${tile(decided, 'Matches won')}
      ${tile(draws, 'Draws')}${tile(done.length ? (goals / done.length).toFixed(1) : '0', 'Goals per match')}
      ${tile(spent, 'Auction points spent')}${tile(topPick ? topPick.points : 0, 'Highest auction price')}
    </div>
    <p class="small muted" style="margin-top:10px;text-align:center">${topPick ? `League records: most expensive pick <b class="green">${esc(topPick.name)}</b> (${topPick.points} points, Match #${esc(topPick.num)}).` : ''}${bigWin && bigWin.margin > 0 ? ` Biggest win: ${bigWin.margin}-goal margin in Match #${esc(bigWin.m.number)}.` : ''}</p>
    <section class="section"><div class="section-head"><h2>Most successful players</h2></div>
      <div class="grid cols-2 wide">
        ${rankList('Most goals', rows, 'goals')}${rankList('Most wins', rows, 'wins')}
        ${rankList('Most penalty goals', rows, 'penaltyGoals')}${rankList('Most normal goals', rows, 'normalGoals')}
        ${rankList('Most appearances', rows, 'matches')}${rankList('Most reward points', rows, 'rewardBalance')}
        ${rankList('Best win rate', rows, 'winRate', (v) => v + '%', (r) => `${r.s.wins}W ${r.s.losses}L ${r.s.draws}D`)}${rankList('Most captain appearances', rows, 'captainCount')}
        ${rankList('Highest auction price', rows, 'highestPrice', (v) => v + ' pts')}${rankList('Most auction points spent on', rows, 'auctionSpentTotal', (v) => v + ' pts')}
      </div></section>`;
}

function newsPage() {
  return `<h1 class="page-title">Announcements</h1><p class="page-sub">Match updates and important league notices.</p>
    ${state.news.length ? `<div class="grid">${state.news.map(newsCard).join('')}</div>` : emptyBox('No announcements', 'League notices will appear here.')}`;
}

// ---------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------
let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; render(); });
}

function captureLb() {
  const m = new Map();
  document.querySelectorAll('.lb-row[data-id]').forEach((el) => m.set(el.dataset.id, el.getBoundingClientRect().top));
  return m;
}
function playFlip(prev) {
  document.querySelectorAll('.lb-row[data-id]').forEach((el) => {
    const old = prev.get(el.dataset.id);
    if (old === undefined) return;
    const d = old - el.getBoundingClientRect().top;
    if (Math.abs(d) < 1) return;
    el.animate([{ transform: `translateY(${d}px)` }, { transform: 'none' }], { duration: 650, easing: 'cubic-bezier(.2,.8,.2,1)' });
  });
}
function countUp() {
  document.querySelectorAll('[data-count]').forEach((el) => {
    const to = Number(el.dataset.count);
    if (!to) return;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 900);
      el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function updateChrome(page) {
  const navKey = page === 'player' ? 'players' : page === 'match' ? 'matches' : page;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === navKey));
  const el = document.getElementById('brandLogo');
  if (el) el.src = safeImg(state.settings.logo) || 'assets/logo.svg';
}

function render() {
  const { page, id } = route();
  updateChrome(page);

  const errs = Object.entries(state.errors);
  if (errs.length) {
    $banner.hidden = false;
    $banner.textContent = `Could not load some data (${errs.map(([k]) => k).join(', ')}): ${friendlyError(errs[0][1])}`;
  } else $banner.hidden = true;

  if (!['settings', 'players', 'stats', 'matches', 'news'].every((k) => state.ready[k])) {
    $view.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading VIP FOOTBALL LEAGUE…</p></div>';
    return;
  }

  // typing in the search box: only refresh the grid so the keyboard stays open
  if (page === 'players' && document.activeElement && document.activeElement.id === 'playerSearch') {
    const g = document.getElementById('playersGrid');
    if (g) { g.innerHTML = playersGridHtml(); return; }
  }

  const prevRects = state.lastPage === 'leaderboard' && page === 'leaderboard' ? captureLb() : null;
  let html;
  try {
    switch (page) {
      case 'home': html = homePage(); break;
      case 'matches': html = matchesPage(); break;
      case 'match': html = matchPage(id); break;
      case 'players': html = playersPage(); break;
      case 'player': html = playerPage(id); break;
      case 'leaderboard': html = leaderboardPage(); break;
      case 'auction': html = auctionPage(); break;
      case 'stats': html = statsPage(); break;
      case 'news': html = newsPage(); break;
      default: html = homePage();
    }
  } catch (e) {
    console.error(e);
    html = emptyBox('Something went wrong', 'Please refresh the page. If this keeps happening, tell the admin.');
  }
  $view.innerHTML = html;
  if (state.animate) {
    $view.classList.remove('enter');
    void $view.offsetWidth;
    $view.classList.add('enter');
    countUp();
    state.animate = false;
  }
  if (prevRects) playFlip(prevRects);
  state.lastPage = page;
}

// ---------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------
window.addEventListener('hashchange', () => {
  state.animate = true;
  syncPm();
  window.scrollTo(0, 0);
  render();
});
$view.addEventListener('click', (e) => {
  const f = e.target.closest('[data-filter]');
  if (f) { state.filter = f.dataset.filter; render(); return; }
  const lb = e.target.closest('[data-lb]');
  if (lb) { state.lbSort = lb.dataset.lb; state.rankDelta = {}; state.moved.clear(); render(); }
});
$view.addEventListener('input', (e) => {
  if (e.target.id === 'playerSearch') { state.search = e.target.value; document.getElementById('playersGrid').innerHTML = playersGridHtml(); }
});
$view.addEventListener('change', (e) => {
  if (e.target.id === 'showInactive') { state.showInactive = e.target.checked; document.getElementById('playersGrid').innerHTML = playersGridHtml(); }
});

syncPm();
render();
