// =====================================================================
// VIP FOOTBALL LEAGUE — ADMIN PANEL
// Client-side Admin Check (Bypasses Cloud Functions / Free Spark Plan friendly)
// =====================================================================
import { auth, db, functions, OWNER_UID } from './firebase-config.js';
import {
  onAuthStateChanged, signInWithCustomToken, signInWithEmailAndPassword, signOut, setPersistence, browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-functions.js';
import {
  collection, doc, onSnapshot, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, query, where, writeBatch, runTransaction,
} from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js';
import {
  LEAGUE_NAME, POSITIONS, FIXED_TIERS, mergeSettings, newTeam, recalcTeam, buildRoster, resultFor, defaultOutcome,
  aggregatePlayer, lastPurchase, suggestBonus, eligibleTiers, financeOf, auctionHtml, budgetGridHtml, logText,
  feeStatus, FEE_LABELS, ADJUST_KEYS, splitGoals, scoreKnown, feeLabel,
  PARTICIPATION, participationOf, ledgerSum, sharedBalance, newLedgerId, planCaptainBonus,
  esc, safeImg, initials, fmtDate, fmtTime, toLocalInput, money, toNum, nonNeg,
} from './lib.js';
import { buildSeed } from './seed-data.js';

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
const S = {
  user: null,
  isOwner: false,
  me: null,
  admins: [],
  adminForm: false,
  redeeming: new Set(),
  settings: mergeSettings(null),
  settingsExists: null,
  players: [],
  stats: new Map(),
  matches: [],
  news: [],
  ready: { settings: false, players: false, stats: false, matches: false, news: false },
  unsubs: [],
  meUnsub: null,
  accessOk: false,
  logoutMsg: '',
  tab: 'dashboard',
  matchId: null,
  playerForm: null,
  playerFilter: 'active',
  playerSearch: '',
  newMatchForm: false,
  annForm: null,
  logoDraft: null,
  pm: [],
  pmKey: null,
  pmUnsub: null,
  pmReady: false,
  pending: false,
  seeded: false,
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const cur = () => S.settings.reward.currencySymbol;
const playerById = (id) => S.players.find((p) => p.id === id);
const matchById = (id) => S.matches.find((m) => m.id === id);
const sortedMatches = () => [...S.matches].sort((a, b) => toNum(b.number) - toNum(a.number));
const ts = () => Date.now();
const dateTxt = (m) => (m.dateMs ? `${fmtDate(m.dateMs)} · ${fmtTime(m.dateMs)}` : 'Date not recorded');
const scoreTxt = (m) => (scoreKnown(m) ? (m.scores || []).map(toNum).join(' – ') : 'score not recorded');

// ---------------------------------------------------------------------
// UI helpers: toast, modal, confirm, error handling
// ---------------------------------------------------------------------
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type === 'err' ? 'err' : ''}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 7000 : 3200);
}

function openModal(html, onDismiss) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal card glow" role="dialog" aria-modal="true">${html}</div>`;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    document.removeEventListener('keydown', onKey);
  };
  const dismiss = () => { close(); if (onDismiss) onDismiss(); };
  const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
  back.addEventListener('mousedown', (e) => { if (e.target === back) dismiss(); });
  document.addEventListener('keydown', onKey);
  $('#modalRoot').appendChild(back);
  return { el: back.firstElementChild, close };
}

function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const m = openModal(
      `<h3>${esc(title)}</h3><p class="muted">${esc(message)}</p>
       <div class="modal-actions"><button class="btn ghost" data-m="no">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-m="yes">${esc(confirmText)}</button></div>`,
      () => resolve(false)
    );
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      m.close();
      resolve(b.dataset.m === 'yes');
    });
  });
}

function friendlyError(e) {
  const code = e && e.code ? e.code : '';
  if (code === 'permission-denied' || /permission|insufficient/i.test((e && e.message) || '')) {
    return 'Firestore refused this change. Your admin access may have been disabled, or the Firestore rules are not published yet.';
  }
  if (code === 'unavailable' || code === 'deadline-exceeded' || code === 'functions/unavailable') return 'No connection to Firebase. Check your internet and try again.';
  if (code === 'resource-exhausted') return 'Firebase free quota is used up for today. Try again tomorrow.';
  return (e && e.message) || 'Something went wrong.';
}

async function run(fn, btn) {
  if (btn) btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    console.error(e);
    toast(friendlyError(e), 'err');
    if (e && e.code === 'permission-denied') recheckAccess();
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
}
function fail(form, msg) {
  const el = form && $('.form-error', form);
  if (el) el.textContent = msg;
  toast(msg, 'err');
}
function clearFail(form) {
  const el = form && $('.form-error', form);
  if (el) el.textContent = '';
}
const field = (label, input, hint) => `<label class="field"><span>${label}</span>${input}${hint ? `<small>${hint}</small>` : ''}</label>`;
const chip = (status) => `<span class="chip ${esc(status)}">${status === 'live' ? 'Live' : esc(status)}</span>`;

// ---------------------------------------------------------------------
// Image resize
// ---------------------------------------------------------------------
function imageToDataUrl(file, { max = 320, square = true, type = 'image/jpeg' } = {}) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) return reject(new Error('Please choose an image file (JPG or PNG).'));
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let sx = 0, sy = 0, sw = img.width, sh = img.height;
      if (square) {
        const s = Math.min(img.width, img.height);
        sx = (img.width - s) / 2; sy = (img.height - s) / 2; sw = s; sh = s;
      }
      const scale = Math.min(1, max / Math.max(sw, sh));
      const w = Math.max(1, Math.round(sw * scale));
      const h = Math.max(1, Math.round(sh * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
      let q = 0.85;
      let data = c.toDataURL(type, q);
      while (type === 'image/jpeg' && data.length > 120000 && q > 0.4) { q -= 0.1; data = c.toDataURL(type, q); }
      if (data.length > 400000) return reject(new Error('This image is still too large. Please pick a smaller image.'));
      resolve(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this image.')); };
    img.src = url;
  });
}

// ---------------------------------------------------------------------
// Database write helpers
// ---------------------------------------------------------------------
async function mutateMatch(id, fn) {
  const ref = doc(db, 'matches', id);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('This match no longer exists.');
    const d = structuredClone(snap.data());
    const keys = fn(d);
    const patch = {};
    keys.forEach((k) => { patch[k] = d[k] === undefined ? null : d[k]; });
    tx.update(ref, JSON.parse(JSON.stringify(patch)));
    return d;
  });
}
const maxBudgetOf = (m) => toNum(m.auctionSettings && m.auctionSettings.maxBudget, S.settings.auction.maxBudget);

async function syncRoster(matchId, m) {
  const existing = await getDocs(query(collection(db, 'playerMatches'), where('matchId', '==', matchId)));
  const exMap = new Map(existing.docs.map((d) => [d.id, d.data()]));
  const roster = buildRoster(m);
  const batch = writeBatch(db);
  const wanted = new Set();
  const affected = new Set();
  roster.forEach((r) => {
    const id = `${matchId}_${r.playerId}`;
    wanted.add(id);
    affected.add(r.playerId);
    const team = (m.teams || [])[r.teamIndex] || {};
    const base = {
      matchId, matchNumber: toNum(m.number), matchDateMs: m.dateMs ? toNum(m.dateMs) : null, matchStatus: m.status,
      playerId: r.playerId, playerName: r.playerName, teamIndex: r.teamIndex, teamName: r.teamName,
      isCaptain: r.isCaptain, isVice: !!r.isVice, auctionPoints: r.auctionPoints, result: resultFor(m, r.teamIndex),
      participation: r.isCaptain ? PARTICIPATION.PLAYED : participationOf(m, r.playerId),
      budget: r.isCaptain
        ? {
            startingPoints: toNum(team.startingPoints), bonusPoints: toNum(team.bonusPoints), totalBeforeCap: toNum(team.totalBeforeCap),
            usablePoints: toNum(team.usablePoints), excessPoints: toNum(team.excessPoints), spentPoints: toNum(team.spentPoints),
            remainingPoints: toNum(team.remainingPoints), maxBudget: toNum(team.maxBudget),
          }
        : null,
    };
    const ref = doc(db, 'playerMatches', id);
    if (exMap.has(id)) batch.set(ref, base, { merge: true });
    else batch.set(ref, { ...base, goals: 0, normalGoals: 0, penaltyGoals: 0, rewardPointsEarned: 0 });
  });
  exMap.forEach((data, id) => {
    if (!wanted.has(id)) { batch.delete(doc(db, 'playerMatches', id)); if (data.playerId) affected.add(data.playerId); }
  });
  await batch.commit();
  return [...affected];
}

async function recomputeStats(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  await Promise.all(
    uniq.map(async (pid) => {
      const [pms, pSnap] = await Promise.all([
        getDocs(query(collection(db, 'playerMatches'), where('playerId', '==', pid))),
        getDoc(doc(db, 'players', pid)),
      ]);
      const pd = pSnap.exists() ? pSnap.data() : {};
      const agg = aggregatePlayer(pms.docs.map((d) => d.data()), pd.rewardLedger || [], pd.statAdjust || {});
      await setDoc(doc(db, 'playerStats', pid), { ...agg, playerId: pid, updatedAt: ts() });
    })
  );
}
async function afterRosterChange(matchId, d) {
  const ids = await syncRoster(matchId, d);
  await recomputeStats(ids);
}

const balanceOf = (p) => sharedBalance((S.stats.get(p.id) || {}).rewardEarned, p.rewardLedger);
const myName = () => (S.me && (S.me.displayName || S.me.username)) || (S.isOwner ? 'Owner' : 'Admin');

// ---------------------------------------------------------------------
// Authentication (Direct Client-Side Admin Check)
// ---------------------------------------------------------------------
function showLogin() {
  $('#authLoading').hidden = true;
  $('#loginForm').hidden = false;
  $('#loginView').hidden = false;
  $('#appView').hidden = true;
}
function showChecking() {
  $('#authLoading').hidden = false;
  $('#loginForm').hidden = true;
  $('#loginView').hidden = false;
  $('#appView').hidden = true;
}
function showApp() {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  paintWho();
}
function paintWho() {
  $('#whoName').textContent = `${myName()}${S.isOwner ? ' · Owner' : ''}`;
  $('#adminsNavBtn').hidden = !S.isOwner;
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginBtn');
  $('#loginError').textContent = '';
  const identifier = $('#loginUsername').value.trim();
  const password = $('#loginPassword').value;
  if (!identifier || !password) { $('#loginError').textContent = 'Enter your email and password.'; return; }
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    if (identifier.includes('@')) {
      await signInWithEmailAndPassword(auth, identifier.toLowerCase(), password);
    } else {
      throw new Error("Kripya apna Email address use karein sign in karne ke liye.");
    }
    $('#loginPassword').value = '';
  } catch (err) {
    console.error(err);
    $('#loginError').textContent = err.message || 'Wrong email or password.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

$('#logoutBtn').addEventListener('click', () => { S.logoutMsg = ''; signOut(auth); });

async function forceLogout(message) {
  S.logoutMsg = message || '';
  try { await signOut(auth); } catch (e) { console.error(e); }
}

function startAccessWatch(user) {
  stopAccessWatch();
  S.accessOk = false;

  const ALLOWED_ADMIN_EMAILS = [
    "vipfootball009x@gmail.com"
  ];

  if (user && user.email && ALLOWED_ADMIN_EMAILS.includes(user.email.toLowerCase())) {
    S.me = { username: user.email.split('@')[0], active: true, role: user.uid === OWNER_UID ? 'owner' : 'admin' };
    paintWho();
    S.accessOk = true;
    showApp();
    startListeners();
    go(S.tab, S.matchId);
    return;
  }

  S.meUnsub = onSnapshot(
    doc(db, 'admins', user.uid),
    (snap) => {
      const ok = snap.exists() && snap.data().active === true;
      if (!ok) { forceLogout('This account is not an active admin account.'); return; }
      S.me = snap.data();
      paintWho();
      if (!S.accessOk) {
        S.accessOk = true;
        showApp();
        startListeners();
        go(S.tab, S.matchId);
      } else {
        scheduleRender();
      }
    },
    (err) => {
      console.error('access watch', err);
      if (!S.accessOk) { forceLogout('Could not verify your access.'); }
    }
  );
}

function stopAccessWatch() {
  if (S.meUnsub) { S.meUnsub(); S.meUnsub = null; }
}

// ---------------------------------------------------------------------
// Live listeners
// ---------------------------------------------------------------------
function listen(name, ref, onData) {
  const un = onSnapshot(
    ref,
    (snap) => { onData(snap); S.ready[name] = true; scheduleRender(); },
    (err) => { console.error(name, err); S.ready[name] = true; toast(`Could not read "${name}": ${friendlyError(err)}`, 'err'); scheduleRender(); }
  );
  S.unsubs.push(un);
}
const docsOf = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

function startListeners() {
  stopListeners();
  listen('settings', doc(db, 'settings', 'league'), (snap) => {
    S.settingsExists = snap.exists();
    S.settings = mergeSettings(snap.exists() ? snap.data() : null);
    if (!snap.exists() && !S.seeded) {
      S.seeded = true;
      setDoc(doc(db, 'settings', 'league'), settingsDoc(S.settings)).catch((e) => toast(friendlyError(e), 'err'));
    }
  });
  listen('players', collection(db, 'players'), (snap) => { S.players = docsOf(snap).sort((a, b) => String(a.name).localeCompare(String(b.name))); });
  listen('stats', collection(db, 'playerStats'), (snap) => { S.stats = new Map(snap.docs.map((d) => [d.id, d.data()])); });
  listen('matches', collection(db, 'matches'), (snap) => { S.matches = docsOf(snap); });
  listen('news', collection(db, 'announcements'), (snap) => { S.news = docsOf(snap).sort((a, b) => toNum(b.dateMs) - toNum(a.dateMs)); });
  if (S.isOwner) {
    S.unsubs.push(onSnapshot(
      collection(db, 'admins'),
      (snap) => { S.admins = docsOf(snap); scheduleRender(); },
      (err) => { console.error('admins', err); }
    ));
  }
}
function stopListeners() {
  S.unsubs.forEach((u) => u());
  S.unsubs = [];
  if (S.pmUnsub) { S.pmUnsub(); S.pmUnsub = null; }
  S.pmKey = null;
  Object.keys(S.ready).forEach((k) => (S.ready[k] = false));
}
const settingsDoc = (s) => ({ leagueName: LEAGUE_NAME, tagline: s.tagline, logo: s.logo || '', auction: s.auction, reward: s.reward, updatedAt: ts() });

function syncPmSub() {
  const key = S.tab === 'matches' && S.matchId ? S.matchId : null;
  if (key === S.pmKey) return;
  if (S.pmUnsub) { S.pmUnsub(); S.pmUnsub = null; }
  S.pm = [];
  S.pmKey = key;
  S.pmReady = !key;
  if (!key) return;
  S.pmUnsub = onSnapshot(
    query(collection(db, 'playerMatches'), where('matchId', '==', key)),
    (snap) => { S.pm = docsOf(snap); S.pmReady = true; scheduleRender(); },
    (err) => { console.error(err); S.pmReady = true; scheduleRender(); }
  );
}

// ---------------------------------------------------------------------
// Rendering & Views
// ---------------------------------------------------------------------
let raf = 0;
function scheduleRender(force = false) {
  if (!S.user) return;
  const a = document.activeElement;
  const typing = a && $('#content').contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && !['checkbox', 'button', 'file', 'radio'].includes(a.type);
  if (typing && !force) { S.pending = true; return; }
  S.pending = false;
  if (raf) cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => { raf = 0; render(); });
}
document.addEventListener('focusout', () => setTimeout(() => { if (S.pending) scheduleRender(); }, 200));

function go(tab, matchId = null) {
  if (tab === 'admins' && !S.isOwner) tab = 'dashboard';
  S.tab = tab;
  if (tab !== 'admins') S.adminForm = false;
  S.matchId = matchId;
  if (tab !== 'players') S.playerForm = null;
  if (tab !== 'announcements') S.annForm = null;
  if (tab !== 'matches') S.newMatchForm = false;
  if (tab === 'settings') S.logoDraft = null;
  syncPmSub();
  scheduleRender(true);
  window.scrollTo(0, 0);
}

function render() {
  if (!S.user) return;
  $$('#adminNav [data-go]').forEach((b) => b.classList.toggle('active', b.dataset.go === S.tab));
  const c = $('#content');
  if (!Object.values(S.ready).every(Boolean)) {
    c.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading league data…</p></div>';
    return;
  }
  let html;
  try {
    switch (S.tab) {
      case 'players': html = playersView(); break;
      case 'matches': html = S.matchId ? matchManageView(matchById(S.matchId)) : matchesListView(); break;
      case 'rewards': html = rewardsView(); break;
      case 'finance': html = financeView(); break;
      case 'announcements': html = announcementsView(); break;
      case 'history': html = historyView(); break;
      case 'settings': html = settingsView(); break;
      case 'admins': html = adminsView(); break;
      default: html = dashboardView();
    }
  } catch (e) {
    console.error(e);
    html = `<div class="alert err">Something went wrong while drawing this page: ${esc(e.message)}</div>`;
  }
  c.innerHTML = html;
}

// ---------------- Dashboard ----------------
function dashboardView() {
  const active = S.players.filter((p) => p.active !== false).length;
  const live = S.matches.filter((m) => m.status === 'live');
  const upcoming = S.matches.filter((m) => m.status === 'upcoming').sort((a, b) => toNum(a.dateMs) - toNum(b.dateMs));
  const done = S.matches.filter((m) => m.status === 'completed').length;
  const steps = [
    [active > 0, 'Add your players', 'players'],
    [S.matches.length > 0, 'Create your first match', 'matches'],
    [S.matches.some((m) => (m.teams || []).some((t) => t.captainId)), 'Pick captains & run the auction', 'matches'],
    [done > 0, 'Play the match and declare the result', 'matches'],
  ];
  const seedCard = !S.players.length && !S.matches.length
    ? `<div class="card glow" style="margin-bottom:14px"><h3>Load your initial league data</h3><p class="muted" style="margin-bottom:10px">The league is empty. One tap adds your 20 registered players and the historical Match 1 (both teams, every auction purchase and the goals). Score, date and winner of Match 1 stay “not recorded” because they were not supplied.</p><button class="btn primary" data-act="seed">Load initial league data</button></div>`
    : '';
  return `<div class="page-head"><h1>Dashboard</h1></div>${seedCard}
  <div class="grid cols-4">
    <div class="card stat-tile"><b>${active}</b><span>Active players</span></div>
    <div class="card stat-tile"><b>${S.matches.length}</b><span>Matches</span></div>
    <div class="card stat-tile"><b>${live.length}</b><span>Live now</span></div>
    <div class="card stat-tile"><b>${done}</b><span>Completed</span></div>
  </div>
  <div class="grid cols-2 wide" style="margin-top:14px">
    <div class="card"><h3>Quick actions</h3><div class="row-actions" style="margin-top:0">
      <button class="btn primary" data-act="quick-match">+ New match</button>
      <button class="btn" data-act="quick-player">+ Add player</button>
      <button class="btn" data-act="quick-news">+ Announcement</button></div>
      ${live.length ? `<p style="margin-top:14px"><b class="green">Live:</b> ${live.map((m) => `<a class="btn small" data-go="matches" data-id="${esc(m.id)}">Match #${esc(m.number)}</a>`).join(' ')}</p>` : ''}
      ${upcoming[0] ? `<p class="small muted" style="margin-top:12px">Next: Match #${esc(upcoming[0].number)} · ${fmtDate(upcoming[0].dateMs)} ${fmtTime(upcoming[0].dateMs)} <a class="green" data-go="matches" data-id="${esc(upcoming[0].id)}" href="#">Open</a></p>` : ''}
    </div>
    <div class="card"><h3>Getting started</h3>
      ${steps.map(([ok, t, tab]) => `<div class="arow" style="margin-bottom:6px"><span>${ok ? '✅' : '⬜'}</span><span class="grow">${esc(t)}</span>${ok ? '' : `<button class="btn small" data-go="${tab}">Go</button>`}</div>`).join('')}
    </div>
  </div>`;
}

// ---------------- Players ----------------
function photoPreviewHtml(photo, name) {
  const src = safeImg(photo);
  return src ? `<img class="avatar" src="${esc(src)}" alt="">` : `<div class="avatar avatar-ph">${esc(initials(name || '?'))}</div>`;
}
function playersView() {
  const f = S.playerForm;
  return `<div class="page-head"><h1>Players</h1><button class="btn primary" data-act="player-new">+ Add player</button></div>
  ${f ? playerFormHtml(f) : ''}
  <div class="toolbar"><input id="adminPlayerSearch" class="search" type="search" placeholder="Search players…" value="${esc(S.playerSearch)}" autocomplete="off">
    <div class="tabs">${['active', 'inactive', 'all'].map((k) => `<button class="tab ${S.playerFilter === k ? 'active' : ''}" data-act="player-filter" data-k="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div></div>
  <div id="playerList">${playerListHtml()}</div>
  <p class="small muted" style="margin-top:14px">Deactivating a player never deletes their history — old matches, auctions and stats stay exactly as they were.</p>`;
}
function playerFormHtml(f) {
  const p = f.id ? playerById(f.id) : null;
  const pay = p && p.payment ? p.payment : 'unconfirmed';
  return `<form class="card glow form" data-form="player" style="margin-bottom:16px"><h3>${p ? 'Edit player' : 'Add player'}</h3>
    <div class="photo-row"><div id="photoPreview">${photoPreviewHtml(f.photo, p && p.name)}</div>
      <div><label class="btn small">Choose photo<input type="file" id="photoInput" accept="image/*"></label>
      <button type="button" class="btn small ghost" data-act="photo-clear">Remove photo</button>
      <p class="small muted" style="margin-top:6px">Resized automatically and saved with the player.</p></div></div>
    <div class="grid-form three">
      ${field('Name *', `<input name="name" required maxlength="40" autocomplete="off" value="${esc(p ? p.name : '')}">`)}
      ${field('Jersey number', `<input name="jersey" type="number" min="0" max="99" step="1" inputmode="numeric" value="${esc(p && p.jersey !== undefined ? p.jersey : '')}">`, 'Leave empty if not known.')}
      ${field('Position', `<select name="position"><option value="">Not set</option>${POSITIONS.map((x) => `<option ${p && p.position === x ? 'selected' : ''}>${x}</option>`).join('')}</select>`)}
      ${field('Entry fee / payment (admin only)', `<select name="payment"><option value="unconfirmed" ${pay === 'unconfirmed' ? 'selected' : ''}>Not confirmed</option><option value="pending" ${pay === 'pending' ? 'selected' : ''}>Pending</option><option value="paid" ${pay === 'paid' ? 'selected' : ''}>Paid</option></select>`, 'Only you can see this. Per-match fees are in each match.')}
    </div>
    <div class="form-error" role="alert"></div>
    <div class="row-actions"><button class="btn primary" type="submit">${p ? 'Save changes' : 'Add player'}</button><button type="button" class="btn ghost" data-act="player-cancel">Cancel</button></div>
  </form>`;
}
function playerListHtml() {
  const q = S.playerSearch.trim().toLowerCase();
  const list = S.players.filter((p) => {
    if (S.playerFilter === 'active' && p.active === false) return false;
    if (S.playerFilter === 'inactive' && p.active !== false) return false;
    return !q || String(p.name).toLowerCase().includes(q) || String(p.jersey) === q;
  });
  if (!S.players.length) return '<div class="empty"><b>No players yet</b>Tap “+ Add player”, or load your initial data from the Dashboard.</div>';
  if (!list.length) return '<div class="empty">No players match.</div>';
  return list
    .map((p) => {
      const st = S.stats.get(p.id) || {};
      return `<div class="arow ${p.active === false ? 'dim' : ''}">
      <div>${photoPreviewHtml(p.photo, p.name).replace('class="avatar', 'class="avatar sm')}</div>
      <div class="grow"><b>${esc(p.name)}</b><div class="small muted">${p.jersey !== undefined && p.jersey !== '' ? '#' + esc(p.jersey) + ' · ' : ''}${esc(p.position || 'Position not set')} · ${toNum(st.matches)} MP · ${toNum(st.goals)} goals${p.active === false ? ' · <span class="chip">Inactive</span>' : ''}${p.payment === 'pending' ? ' <span class="chip draw">Payment pending</span>' : ''}${st.hasAdjust ? ' <span class="chip">stats adjusted</span>' : ''}</div></div>
      <div class="acts"><a class="btn small ghost" href="index.html#/player/${esc(p.id)}" target="_blank" rel="noopener">View</a><button class="btn small" data-act="player-edit" data-id="${esc(p.id)}">Edit profile</button><button class="btn small" data-act="player-stats" data-id="${esc(p.id)}">Edit stats</button>
      <button class="btn small ${p.active === false ? '' : 'danger'}" data-act="player-toggle" data-id="${esc(p.id)}">${p.active === false ? 'Reactivate' : 'Deactivate'}</button></div></div>`;
    })
    .join('');
}
async function savePlayer(form) {
  clearFail(form);
  const f = S.playerForm;
  const fd = new FormData(form);
  const name = String(fd.get('name') || '').trim().replace(/\s+/g, ' ');
  const jerseyRaw = String(fd.get('jersey') || '').trim();
  const position = String(fd.get('position') || '');
  const payment = ['unconfirmed', 'pending', 'paid'].includes(fd.get('payment')) ? fd.get('payment') : 'unconfirmed';
  const jersey = jerseyRaw === '' ? '' : Number(jerseyRaw);
  if (name.length < 2) return fail(form, 'Name must be at least 2 characters.');
  if (jersey !== '' && (!Number.isInteger(jersey) || jersey < 0 || jersey > 99)) return fail(form, 'Jersey number must be a whole number from 0 to 99 (or leave it empty).');
  if (position && !POSITIONS.includes(position)) return fail(form, 'Please choose a valid position.');
  const clash = jersey === '' ? null : S.players.find((p) => p.id !== f.id && p.active !== false && Number(p.jersey) === jersey && p.jersey !== '');
  if (clash) return fail(form, `Jersey #${jersey} is already used by ${clash.name}.`);
  if (S.players.some((p) => p.id !== f.id && String(p.name).toLowerCase() === name.toLowerCase())) return fail(form, 'A player with this name already exists. Add a surname or initial to tell them apart.');
  const data = { name, jersey, position, payment, photo: f.photo || '' };
  if (f.id) await updateDoc(doc(db, 'players', f.id), { ...data, updatedAt: ts() });
  else await addDoc(collection(db, 'players'), { ...data, active: true, rewardLedger: [], createdAt: ts() });
  S.playerForm = null;
  toast(f.id ? 'Player updated.' : 'Player added.');
  scheduleRender(true);
}

// ---------------- Matches list ----------------
function matchesListView() {
  const nextNo = Math.max(0, ...S.matches.map((m) => toNum(m.number))) + 1;
  const a = S.settings.auction;
  const form = S.newMatchForm
    ? `<form class="card glow form" data-form="new-match" style="margin-bottom:16px"><h3>New match</h3>
      <p class="small muted" style="margin-bottom:10px">Every match gets a fresh auction and new teams. Auction rules used: ${a.startingPoints} starting points, ${a.maxBudget} max budget (change in Settings).</p>
      <div class="grid-form three">
        ${field('Match number *', `<input name="number" type="number" min="1" step="1" required value="${nextNo}">`)}
        ${field('Date & time *', `<input name="date" type="datetime-local" required value="${toLocalInput(Date.now() + 86400000)}">`)}
        ${field(`Entry fee (${esc(cur())}) *`, '<input name="fee" type="number" min="0" step="1" required value="0" inputmode="decimal">')}
        ${field('Venue', '<input name="venue" maxlength="60" placeholder="Optional">')}
        ${field('Number of teams', '<select name="teamCount"><option>2</option><option>3</option><option>4</option></select>')}
      </div>
      <div class="grid-form">${[0, 1, 2, 3].map((i) => field(`Team ${i + 1} name`, `<input name="t${i}" maxlength="24" placeholder="Team ${String.fromCharCode(65 + i)}">`)).join('')}</div>
      <div class="form-error" role="alert"></div>
      <div class="row-actions"><button class="btn primary" type="submit">Create match</button><button type="button" class="btn ghost" data-act="newmatch-cancel">Cancel</button></div></form>`
    : '';
  const rows = sortedMatches()
    .map((m) => {
      const sc = (m.scores || []).map(toNum);
      return `<div class="arow"><div class="grow"><b>Match #${esc(m.number)}</b> ${chip(m.status)}
        <div class="small muted">${dateTxt(m)} · ${(m.teams || []).map((t) => esc(t.name)).join(' vs ')}${m.status !== 'upcoming' ? ` · <b>${scoreKnown(m) ? sc.join(' – ') : 'score n/a'}</b>` : ''}</div></div>
        <button class="btn small primary" data-go="matches" data-id="${esc(m.id)}">Manage</button></div>`;
    })
    .join('');
  return `<div class="page-head"><h1>Matches &amp; Auction</h1><button class="btn primary" data-act="newmatch">+ New match</button></div>
    ${form}${rows || '<div class="empty"><b>No matches yet</b>Create your first match to begin.</div>'}`;
}
async function createMatch(form) {
  clearFail(form);
  const fd = new FormData(form);
  const number = Number(fd.get('number'));
  const dateMs = new Date(String(fd.get('date'))).getTime();
  const fee = Number(fd.get('fee'));
  const n = Number(fd.get('teamCount'));
  if (!Number.isInteger(number) || number < 1) return fail(form, 'Match number must be a whole number (1 or more).');
  if (S.matches.some((m) => toNum(m.number) === number)) return fail(form, `Match #${number} already exists.`);
  if (!Number.isFinite(dateMs)) return fail(form, 'Please choose a valid date and time.');
  if (!Number.isFinite(fee) || fee < 0) return fail(form, 'Entry fee must be 0 or more.');
  if (![2, 3, 4].includes(n)) return fail(form, 'Teams must be 2, 3 or 4.');
  const names = Array.from({ length: n }, (_, i) => String(fd.get(`t${i}`) || '').trim());
  if (new Set(names.map((x, i) => (x || `Team ${String.fromCharCode(65 + i)}`).toLowerCase())).size !== n) return fail(form, 'Team names must be different.');
  const a = S.settings.auction;
  const teams = names.map((nm, i) => newTeam(i, nm, a));
  const ref = await addDoc(collection(db, 'matches'), {
    number, dateMs, venue: String(fd.get('venue') || '').trim(), entryFee: fee, status: 'upcoming', auctionStatus: 'pending',
    teams, scores: Array(n).fill(0), result: null, pool: S.players.filter((p) => p.active !== false).map((p) => p.id),
    fees: {}, expenses: [], auctionLog: [], auctionSettings: { startingPoints: toNum(a.startingPoints), maxBudget: toNum(a.maxBudget) }, createdAt: ts(),
  });
  toast(`Match #${number} created.`);
  S.newMatchForm = false;
  go('matches', ref.id);
}

// ---------------- Match manage ----------------
function poolPlayers(m) {
  const rosterIds = new Set(buildRoster(m).map((r) => r.playerId));
  const pool = new Set(m.pool || []);
  const base = (m.pool && m.pool.length) ? S.players.filter((p) => pool.has(p.id)) : S.players.filter((p) => p.active !== false);
  const extra = S.players.filter((p) => rosterIds.has(p.id) && !base.includes(p));
  return [...base, ...extra].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
function takenIds(m) { return new Set(buildRoster(m).map((r) => r.playerId)); }

function matchManageView(m) {
  if (!m) return `<button class="btn ghost small" data-go="matches">← All matches</button><div class="empty" style="margin-top:12px"><b>Match not found</b>It may have been deleted.</div>`;
  const locked = m.status === 'completed';
  return `<button class="btn ghost small" data-go="matches">← All matches</button>
  <div class="page-head" style="margin-top:10px"><h1>Match #${esc(m.number)}</h1><div>${chip(m.status)} <span class="chip ${m.auctionStatus === 'completed' ? 'completed' : ''}">Auction ${esc(m.auctionStatus === 'completed' ? 'complete' : m.auctionStatus === 'inProgress' ? 'in progress' : 'pending')}</span></div></div>
  <div class="mini-nav"><a href="#" data-jump="sec-status">Status</a><a href="#" data-jump="sec-details">Details</a><a href="#" data-jump="sec-captains">Captains</a><a href="#" data-jump="sec-auction">Auction</a><a href="#" data-jump="sec-played">Played / Not played</a><a href="#" data-jump="sec-score">Score &amp; stats</a><a href="#" data-jump="sec-fees">Fees</a><a href="#" data-jump="sec-log">Log</a></div>
  ${(m.notes || []).length ? `<div class="alert ok"><b>Notes</b><ul class="notes">${m.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
  <div class="stack">
    ${statusSection(m)}${detailsSection(m)}${captainsSection(m, locked)}${auctionSection(m, locked)}${participationSection(m)}${scoreSection(m)}${feesSection(m)}${logSection(m)}
  </div>`;
}

function statusSection(m) {
  let body = '';
  if (m.status === 'upcoming') {
    body = `<p class="muted">Match has not started. When the auction is done and teams are ready, start the match to show it as LIVE on the website.</p>
      <div class="row-actions"><button class="btn primary" data-act="match-live" data-id="${esc(m.id)}">▶ Start match (go live)</button>
      ${(m.teams || []).every((t) => !(t.picks || []).length) ? `<button class="btn danger" data-act="match-delete" data-id="${esc(m.id)}">Delete match</button>` : ''}</div>`;
  } else if (m.status === 'live') {
    const d = defaultOutcome(m.scores);
    const opts = (m.teams || []).map((t, i) => `<option value="win:${i}" ${d.outcome === 'win' && d.winnerIndex === i ? 'selected' : ''}>${esc(t.name)} won</option>`).join('');
    body = `<p class="muted">Match is LIVE. Update the score below. When the final whistle blows, declare the result.</p>
      <form data-form="declare" class="grid-form"><div>${field('Final result', `<select name="outcome">${opts}<option value="draw" ${d.outcome === 'draw' ? 'selected' : ''}>Draw</option></select>`, `Current score: ${(m.scores || []).map(toNum).join(' – ')}`)}</div>
      <div class="form-error" role="alert"></div>
      <div class="row-actions" style="grid-column:1/-1"><button class="btn primary" type="submit">🏁 Declare result &amp; finish match</button></div></form>`;
  } else {
    const t = (m.teams || [])[m.result && m.result.winnerIndex];
    body = `<p><b class="green">${m.result && m.result.outcome === 'draw' ? 'Match drawn' : t ? `${esc(t.name)} won` : 'Result not recorded'}</b> · final score ${scoreKnown(m) ? (m.scores || []).map(toNum).join(' – ') : 'not recorded'}</p>
      <p class="small muted">Auction and result are locked to protect history. Re-open the match to change them (stats are rebuilt safely, nothing is counted twice).</p>
      <div class="row-actions"><button class="btn" data-act="match-reopen" data-id="${esc(m.id)}">Re-open match</button></div>`;
  }
  return `<section class="card" id="sec-status"><h3>Match status</h3>${body}</section>`;
}

function detailsSection(m) {
  return `<section class="card" id="sec-details"><h3>Details</h3>
    <form data-form="match-details"><div class="grid-form three">
      ${field('Date & time', `<input name="date" type="datetime-local" value="${m.dateMs ? toLocalInput(m.dateMs) : ''}">`, m.dateMs ? '' : 'Not recorded yet — fill it in when you know it.')}
      ${field('Entry fee (' + esc(cur()) + ')', `<input name="fee" type="number" min="0" step="1" value="${m.entryFee === null || m.entryFee === undefined ? '' : esc(toNum(m.entryFee))}" inputmode="decimal">`, m.entryFee === null || m.entryFee === undefined ? 'Not set yet.' : '')}
      ${field('Venue', `<input name="venue" maxlength="60" value="${esc(m.venue || '')}">`)}
    </div>
    <div class="grid-form">${(m.teams || []).map((t, i) => field(`Team ${i + 1} name`, `<input name="t${i}" maxlength="24" required value="${esc(t.name)}">`)).join('')}</div>
    <div class="form-error" role="alert"></div>
    <div class="row-actions"><button class="btn primary" type="submit">Save details</button></div></form></section>`;
}

function captainHint(m, idx, playerId) {
  if (!playerId) return '';
  const pl = playerById(playerId);
  const t = (m.teams || [])[idx] || {};
  const bal = pl ? balanceOf(pl) : 0;
  const used = t.captainId === playerId ? toNum(t.bonusCharged) : 0;
  const balLine = `Shared points balance: <b class="green">${bal}</b>${used ? ` (<b>${used}</b> already taken for this match's bonus — you can use up to <b>${bal + used}</b>)` : ` — the bonus you enter is taken from this balance`}.`;
  const lp = lastPurchase(playerId, S.matches, m.id);
  if (!lp) return `${balLine}<br>No previous auction purchase found for this player.`;
  const sug = suggestBonus(lp, S.settings.auction.bonusFactor);
  return `${balLine}<br>Last auction price: <b>${lp.points}</b> pts (Match #${esc(lp.matchNumber)}) → suggested bonus <b>${sug}</b> <button type="button" class="btn small" data-act="use-suggest" data-idx="${idx}" data-val="${sug}">Use suggestion</button>`;
}

function captainsSection(m, locked) {
  const players = poolPlayers(m);
  const maxB = maxBudgetOf(m);
  const teams = (m.teams || [])
    .map((t, i) => {
      const picks = t.picks || [];
      return `<div class="team-edit" style="--tc:${esc(t.color)}"><h4>${esc(t.name)}${t.colorName ? ` <span class="small muted">· ${esc(t.colorName)}</span>` : ''}</h4>
      <div class="grid-form three">
        ${field('Captain', `<select name="cap${i}" data-cap-select="${i}" ${locked ? 'disabled' : ''}><option value="">— not selected —</option>${players.map((p) => `<option value="${esc(p.id)}" ${t.captainId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`)}
        ${field('Starting points', `<input name="start${i}" type="number" min="0" step="1" value="${esc(toNum(t.startingPoints))}" ${locked ? 'disabled' : ''}>`)}
        ${field('Bonus points', `<input name="bonus${i}" type="number" min="0" step="1" value="${esc(toNum(t.bonusPoints))}" ${locked ? 'disabled' : ''}>`, 'Taken from this captain’s shared points balance.')}
      </div>
      ${field('Vice captain', picks.length ? `<select name="vice${i}" ${locked ? 'disabled' : ''}><option value="">— none —</option>${picks.map((p) => `<option value="${esc(p.playerId)}" ${t.viceCaptainId === p.playerId ? 'selected' : ''}>${esc(p.playerName)}</option>`).join('')}</select>` : '<input disabled value="Buy players first, then choose a vice captain">')}
      <div class="hint" id="hint${i}">${captainHint(m, i, t.captainId)}</div>
      ${budgetGridHtml(t)}</div>`;
    })
    .join('');
  return `<section class="card" id="sec-captains"><h3>Captains &amp; budgets</h3>
    <p class="small muted" style="margin-bottom:12px">Total = starting + bonus. Usable = the smaller of Total and the max budget (<b>${maxB}</b>). Anything above is Excess. Remaining = Usable − Spent.</p>
    <form data-form="captains">${teams}<div class="form-error" role="alert"></div>
    ${locked ? '<p class="small muted">Locked — re-open the match to edit.</p>' : '<div class="row-actions"><button class="btn primary" type="submit">Save captains</button></div>'}</form></section>`;
}

function auctionSection(m, locked) {
  const taken = takenIds(m);
  const available = poolPlayers(m).filter((p) => !taken.has(p.id) && p.active !== false);
  const teams = m.teams || [];
  const poolIds = new Set(m.pool || []);
  const allActive = S.players.filter((p) => p.active !== false);
  const pickForm = locked
    ? '<p class="small muted">Match is completed — auction is locked. Re-open the match to change it.</p>'
    : `<form data-form="pick" class="grid-form three">
        ${field('Team (captain buys)', `<select name="team">${teams.map((t, i) => `<option value="${i}" ${t.captainId ? '' : 'disabled'}>${esc(t.name)} — ${toNum(t.remainingPoints)} pts left${t.captainId ? '' : ' (pick captain first)'}</option>`).join('')}</select>`)}
        ${field('Player', `<select name="player"><option value="">— choose player —</option>${available.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (#${esc(p.jersey)})</option>`).join('')}</select>`)}
        ${field('Auction points paid', '<input name="price" type="number" min="0" step="1" required inputmode="numeric" placeholder="e.g. 25">')}
        <div class="form-error" role="alert" style="grid-column:1/-1"></div>
        <div class="row-actions" style="grid-column:1/-1;margin-top:0"><button class="btn primary" type="submit">Record pick</button></div></form>`;
  const teamLists = teams
    .map((t, i) => `<div class="team-edit" style="--tc:${esc(t.color)}"><h4>${esc(t.name)} <span class="small muted">· Capt. ${esc(t.captainName || '—')} · ${toNum(t.spentPoints)} spent · ${toNum(t.remainingPoints)} left</span></h4>
      ${(t.picks || []).length ? (t.picks || []).map((p, k) => `<div class="arow"><span class="muted">${k + 1}</span><span class="grow"><b>${esc(p.playerName)}</b></span><b class="green">${toNum(p.points)} pts</b>${locked ? '' : `<button class="btn small danger" data-act="pick-undo" data-team="${i}" data-player="${esc(p.playerId)}">Undo</button>`}</div>`).join('') : '<p class="small muted">No players picked yet.</p>'}</div>`)
    .join('');
  const pool = locked
    ? ''
    : `<details style="margin-top:14px"><summary class="green" style="cursor:pointer;font-weight:600">Auction pool — who is taking part (${(m.pool || []).length} selected)</summary>
      <form data-form="pool"><div class="pool-grid">${allActive.map((p) => `<label><input type="checkbox" name="pool" value="${esc(p.id)}" ${poolIds.has(p.id) || taken.has(p.id) ? 'checked' : ''} ${taken.has(p.id) ? 'disabled' : ''}>${esc(p.name)}</label>`).join('') || '<span class="muted small">No active players.</span>'}</div>
      <div class="row-actions" style="margin-top:0"><button type="button" class="btn small ghost" data-act="pool-all">Select all</button><button type="button" class="btn small ghost" data-act="pool-none">Select none</button><button class="btn small primary" type="submit">Save pool</button></div></form></details>`;
  const unsold = available.length ? `<p class="small muted" style="margin-top:12px">Still unsold (${available.length}):</p><div class="chips" style="margin-top:6px">${available.map((p) => `<span class="chip">${esc(p.name)}</span>`).join('')}</div>` : '';
  const finish = locked ? '' : m.auctionStatus === 'completed'
    ? '<div class="row-actions"><button class="btn" data-act="auction-reopen">Re-open auction</button></div>'
    : '<div class="row-actions"><button class="btn" data-act="auction-complete">✔ Mark auction complete</button></div>';
  return `<section class="card" id="sec-auction"><h3>Fresh auction</h3>
    <p class="small muted" style="margin-bottom:12px">This match has its own auction. Nothing from earlier matches is changed. Every pick is saved in the auction log.</p>
    ${pickForm}<h4 class="sec-title" style="font-size:20px">Teams</h4>${teamLists}${unsold}${pool}${finish}</section>`;
}

function participationSection(m) {
  const teams = m.teams || [];
  const total = teams.reduce((n, t) => n + (t.picks || []).length, 0);
  let body;
  if (!total) {
    body = '<p class="small muted">Buy players in the auction first. Every purchased player will appear here so you can mark who actually played.</p>';
  } else {
    let played = 0;
    let notPlayed = 0;
    const lists = teams
      .map((t, i) => {
        const picks = t.picks || [];
        if (!picks.length) return '';
        const rows = picks.map((p) => {
          const st = participationOf(m, p.playerId);
          if (st === PARTICIPATION.NOT_PLAYED) notPlayed++; else played++;
          return `<div class="arow"><div class="grow"><b>${esc(p.playerName)}</b>${t.viceCaptainId === p.playerId ? ' <span class="chip captain">VC</span>' : ''}<div class="small muted">Bought for ${toNum(p.points)} pts</div></div>
            <div class="acts seg" role="group" aria-label="Played or not played: ${esc(p.playerName)}">
              <button class="btn small ${st === PARTICIPATION.PLAYED ? 'primary' : 'ghost'}" data-act="participation" data-pid="${esc(p.playerId)}" data-status="played" aria-pressed="${st === PARTICIPATION.PLAYED}">Played</button>
              <button class="btn small ${st === PARTICIPATION.NOT_PLAYED ? 'danger' : 'ghost'}" data-act="participation" data-pid="${esc(p.playerId)}" data-status="not_played" aria-pressed="${st === PARTICIPATION.NOT_PLAYED}">Not played</button>
            </div></div>`;
        }).join('');
        return `<div class="team-edit" style="--tc:${esc(t.color)}"><h4>${esc(t.name)} <span class="small muted">· Capt. ${esc(t.captainName || '—')}</span></h4>${rows}</div>`;
      })
      .join('');
    body = `<div class="sum-grid" style="grid-template-columns:repeat(3,1fr)"><div><b>${total}</b><span>Purchased</span></div><div><b class="green">${played}</b><span>Played</span></div><div><b${notPlayed ? ' style="color:#ff8793"' : ''}>${notPlayed}</b><span>Not played</span></div></div>
      ${lists}`;
  }
  return `<section class="card" id="sec-played"><h3>Played / Not played</h3>
    <p class="small muted" style="margin-bottom:12px">Set the real status for every purchased player of <b>this match only</b>. Captains always count as played.</p>
    ${body}</section>`;
}

async function setParticipation(m, playerId, status) {
  if (status !== PARTICIPATION.PLAYED && status !== PARTICIPATION.NOT_PLAYED) return;
  if (participationOf(m, playerId) === status) return;
  const team = (m.teams || []).find((t) => (t.picks || []).some((p) => p.playerId === playerId));
  const pk = team && (team.picks || []).find((p) => p.playerId === playerId);
  if (!pk) throw new Error('This player is not a purchased player in this match.');
  if (status === PARTICIPATION.NOT_PLAYED) {
    const rec = S.pm.find((r) => r.playerId === playerId);
    const g = rec ? splitGoals(rec).total : 0;
    const rp = rec ? toNum(rec.rewardPointsEarned) : 0;
    if (g > 0 || rp > 0) {
      const ok = await confirmDialog({
        title: `Mark ${pk.playerName} as Not played?`,
        message: `${g ? `${g} goal(s) are recorded for this player in this match and will stop counting in statistics. ` : ''}${rp ? `${rp} reward point(s) were entered for this match. ` : ''}Continue?`,
        confirmText: 'Mark Not played', danger: true,
      });
      if (!ok) return;
    }
  }
  const d = await mutateMatch(m.id, (d2) => {
    const tm = (d2.teams || []).find((t) => (t.picks || []).some((p) => p.playerId === playerId));
    if (!tm) throw new Error('This player is not a purchased player in this match.');
    d2.participation = { ...(d2.participation || {}), [playerId]: status };
    d2.auctionLog = [...(d2.auctionLog || []), { ts: ts(), type: 'participation', teamName: tm.name, playerId, playerName: pk.playerName, status }];
    return ['participation', 'auctionLog'];
  });
  await afterRosterChange(m.id, d);
  toast(`${pk.playerName}: ${status === PARTICIPATION.PLAYED ? 'Played' : 'Not played'}.`);
}

function scoreSection(m) {
  const teams = m.teams || [];
  const sc = (m.scores || []).map(toNum);
  const enabled = m.status !== 'upcoming';
  const board = teams
    .map((t, i) => `<div class="score-row" style="--tc:${esc(t.color)}"><span class="tn">${esc(t.name)}</span><div class="score-ctl">
      <button class="btn" data-act="score" data-idx="${i}" data-d="-1" ${enabled ? '' : 'disabled'} aria-label="Minus one goal">−</button><b>${scoreKnown(m) ? toNum(sc[i]) : '–'}</b>
      <button class="btn primary" data-act="score" data-idx="${i}" data-d="1" ${enabled ? '' : 'disabled'} aria-label="Plus one goal">+</button></div></div>`)
    .join('');
  const roster = buildRoster(m);
  let stats;
  if (!roster.length) stats = '<p class="small muted">Pick captains / players first — they will appear here.</p>';
  else if (!S.pmReady) stats = '<div class="loading" style="padding:20px"><div class="spinner"></div></div>';
  else if (S.pm.length < roster.length) stats = `<p class="small muted">Some player records are missing. <button class="btn small" data-act="resync">Repair player records</button></p>`;
  else {
    const rows = [...S.pm].sort((a, b) => toNum(a.teamIndex) - toNum(b.teamIndex) || (b.isCaptain ? 1 : 0) - (a.isCaptain ? 1 : 0) || String(a.playerName).localeCompare(String(b.playerName)));
    const totN = rows.reduce((s, r) => s + splitGoals(r).normal, 0);
    const totP = rows.reduce((s, r) => s + splitGoals(r).pen, 0);
    const earn = S.settings.reward.earn;
    const allZero = Object.values(earn).every((v) => !toNum(v));
    stats = `<form data-form="pstats"><div class="stat-inputs"><span class="hd">Player</span><span class="hd">Normal</span><span class="hd">Penalty</span><span class="hd">Reward</span>
      ${rows.map((r) => { const g = splitGoals(r); const np = !r.isCaptain && participationOf(m, r.playerId) === PARTICIPATION.NOT_PLAYED; return `<div class="nm"><b>${esc(r.playerName)}</b>${r.isCaptain ? ' <span class="chip captain">C</span>' : ''}${r.isVice ? ' <span class="chip captain">VC</span>' : ''}${np ? ' <span class="chip loss">Not played</span>' : ''}<small>${esc(r.teamName)}${r.result && !np ? ' · ' + esc(r.result) : ''}</small></div>
        <input type="number" min="0" step="1" inputmode="numeric" data-pm="${esc(r.id)}" data-field="normal" value="${g.normal}" ${np ? 'disabled' : ''} aria-label="Normal goals ${esc(r.playerName)}">
        <input type="number" min="0" step="1" inputmode="numeric" data-pm="${esc(r.id)}" data-field="penalty" value="${g.pen}" ${np ? 'disabled' : ''} aria-label="Penalty goals ${esc(r.playerName)}">
        <input type="number" min="0" step="1" inputmode="numeric" data-pm="${esc(r.id)}" data-field="reward" value="${toNum(r.rewardPointsEarned)}" aria-label="Reward points ${esc(r.playerName)}">`; }).join('')}</div>
      <p class="small muted" style="margin-top:10px">Saved goals so far: <b>${totN}</b> normal + <b>${totP}</b> penalty = <b>${totN + totP}</b>.</p>
      <div class="form-error" role="alert"></div>
      <div class="row-actions"><button class="btn primary" type="submit">Save goals &amp; reward points</button><button type="button" class="btn" data-act="apply-rules" ${allZero ? 'disabled' : ''}>Fill reward points from rules</button></div></form>`;
  }
  return `<section class="card" id="sec-score"><h3>Score &amp; player stats</h3>
    ${enabled ? '' : '<p class="small muted" style="margin-bottom:10px">Start the match (Status section) to enter the score.</p>'}
    ${enabled && !scoreKnown(m) ? '<div class="alert warn">The final score of this match was not recorded. Set it with + / − below, or confirm the current numbers. <button class="btn small" data-act="score-confirm" style="margin-left:6px">Confirm 0 – 0</button></div>' : ''}
    <div class="score-board">${board}</div>
    <h4 class="sec-title" style="font-size:20px">Goals &amp; reward points per player</h4>${stats}</section>`;
}

function feesSection(m) {
  const f = financeOf(m);
  const roster = buildRoster(m);
  const sym = cur();
  const noFee = m.entryFee === null || m.entryFee === undefined || m.entryFee === '';
  const rows = roster
    .map((r) => {
      const fe = (m.fees || {})[r.playerId] || {};
      const st = feeStatus(fe);
      const disc = Math.min(nonNeg(fe.discount), f.fee);
      return `<div class="fee-row"><div><b>${esc(r.playerName)}</b> ${r.isCaptain ? '<span class="chip captain">C</span>' : ''}${r.isVice ? ' <span class="chip captain">VC</span>' : ''}
        <div class="meta">${esc(r.teamName)}${noFee ? '' : ` · due ${money(f.fee - disc, sym)}`}</div></div>
        <div class="acts"><select class="inline-input fee-select ${esc(st)}" data-act="fee-status" data-pid="${esc(r.playerId)}" aria-label="Payment status of ${esc(r.playerName)}" style="width:auto">${['unconfirmed', 'pending', 'paid'].map((k) => `<option value="${k}" ${st === k ? 'selected' : ''}>${FEE_LABELS[k]}</option>`).join('')}</select>
        ${disc ? `<button class="btn small ghost" data-act="redeem-undo" data-pid="${esc(r.playerId)}">Undo discount</button>` : `<button class="btn small" data-act="redeem" data-pid="${esc(r.playerId)}" ${noFee ? 'disabled' : ''}>Money Converter</button>`}</div></div>`;
    })
    .join('');
  const exp = (m.expenses || [])
    .map((e) => `<div class="arow"><span class="grow">${esc(e.label)}</span><b>${money(e.amount, sym)}</b><button class="btn small danger" data-act="expense-del" data-id="${esc(e.id)}">Delete</button></div>`)
    .join('');
  return `<section class="card" id="sec-fees"><h3>Fees &amp; expenses</h3>
    ${noFee ? '<div class="alert warn">Entry fee is not set for this match. Set it in Details to see amounts.</div>' : ''}
    <div class="sum-grid"><div><b>${money(f.expected, sym)}</b><span>Expected</span></div><div><b>${money(f.collected, sym)}</b><span>Collected (paid)</span></div>
      <div><b>${money(f.expenses, sym)}</b><span>Expenses</span></div><div><b class="${f.net < 0 ? 'neg' : ''}">${money(f.net, sym)}</b><span>Net</span></div></div>
    ${roster.length ? `${rows}<div class="row-actions"><button class="btn small" data-act="fees-all">Mark everyone paid</button></div>` : '<p class="small muted">Fees appear once players are on teams.</p>'}
    <h4 class="sec-title" style="font-size:20px">Expenses</h4>${exp || '<p class="small muted">No expenses recorded.</p>'}
    <form data-form="expense" class="grid-form" style="margin-top:10px">${field('What for', '<input name="label" maxlength="60" required placeholder="Ground booking, water, bibs…">')}${field(`Amount (${esc(sym)})`, '<input name="amount" type="number" min="0" step="0.5" required inputmode="decimal">')}
    <div class="form-error" role="alert" style="grid-column:1/-1"></div><div class="row-actions" style="grid-column:1/-1;margin-top:0"><button class="btn primary" type="submit">Add expense</button></div></form></section>`;
}

function logSection(m) {
  const log = [...(m.auctionLog || [])].reverse();
  return `<section class="card" id="sec-log"><h3>Auction log</h3>
    ${log.length ? `<ol class="log-list">${log.map((e) => `<li><time>${new Date(e.ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</time><span>${logText(e)}</span></li>`).join('')}</ol>` : '<p class="small muted">Nothing yet.</p>'}</section>`;
}

async function saveMatchDetails(form, m) {
  clearFail(form);
  const fd = new FormData(form);
  const dateRaw = String(fd.get('date') || '').trim();
  const dateMs = dateRaw ? new Date(dateRaw).getTime() : null;
  const feeRaw = String(fd.get('fee') || '').trim();
  const fee = feeRaw === '' ? null : Number(feeRaw);
  if (dateRaw && !Number.isFinite(dateMs)) return fail(form, 'Choose a valid date and time.');
  if (fee !== null && (!Number.isFinite(fee) || fee < 0)) return fail(form, 'Entry fee must be 0 or more.');
  const names = (m.teams || []).map((_, i) => String(fd.get(`t${i}`) || '').trim());
  if (names.some((x) => !x)) return fail(form, 'Every team needs a name.');
  const d = await mutateMatch(m.id, (d2) => {
    d2.dateMs = dateMs; d2.entryFee = fee; d2.venue = String(fd.get('venue') || '').trim();
    d2.teams.forEach((t, i) => { t.name = names[i]; });
    return ['dateMs', 'entryFee', 'venue', 'teams'];
  });
  await afterRosterChange(m.id, d);
  toast('Details saved.');
}

async function saveCaptains(form, m) {
  clearFail(form);
  const fd = new FormData(form);
  const n = (m.teams || []).length;
  const caps = [];
  for (let i = 0; i < n; i++) {
    const start = Number(fd.get(`start${i}`));
    const bonus = Number(fd.get(`bonus${i}`));
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(bonus) || bonus < 0) return fail(form, 'Starting and bonus points must be 0 or more.');
    caps.push({ id: String(fd.get(`cap${i}`) || ''), start, bonus, vice: fd.has(`vice${i}`) ? String(fd.get(`vice${i}`) || '') : null });
  }
  const chosen = caps.map((c) => c.id).filter(Boolean);
  if (new Set(chosen).size !== chosen.length) return fail(form, 'The same player cannot captain two teams.');

  const touched = new Set();
  const d = await runTransaction(db, async (tx) => {
    const mRef = doc(db, 'matches', m.id);
    const mSnap = await tx.get(mRef);
    if (!mSnap.exists()) throw new Error('This match no longer exists.');
    const d2 = structuredClone(mSnap.data());
    if (d2.status === 'completed') throw new Error('Re-open the match before changing captains.');

    const ids = new Set();
    d2.teams.forEach((t, i) => { if (t.captainId) ids.add(t.captainId); if (caps[i].id) ids.add(caps[i].id); });
    const info = new Map();
    for (const id of ids) {
      const [pSnap, sSnap] = await Promise.all([tx.get(doc(db, 'players', id)), tx.get(doc(db, 'playerStats', id))]);
      info.set(id, {
        ref: pSnap.ref, exists: pSnap.exists(), name: pSnap.exists() ? pSnap.data().name : '',
        ledger: [...(pSnap.exists() ? pSnap.data().rewardLedger || [] : [])],
        earned: sSnap.exists() ? toNum(sSnap.data().rewardEarned) : 0, dirty: false,
      });
    }
    const refunds = [];
    const charges = [];
    const logs = [];
    const maxB = toNum(d2.auctionSettings && d2.auctionSettings.maxBudget, S.settings.auction.maxBudget);

    d2.teams.forEach((t, i) => {
      const c = caps[i];
      const plan = planCaptainBonus(t, c.id, c.bonus);
      plan.refunds.forEach((x) => refunds.push({ id: x.playerId, pts: x.points, team: t.name, i }));
      plan.charges.forEach((x) => charges.push({ id: x.playerId, pts: x.points, team: t.name, i }));

      t.captainId = c.id || null;
      t.captainName = c.id ? (playerById(c.id) ? playerById(c.id).name : '') : '';
      t.startingPoints = c.start;
      t.bonusPoints = c.bonus;
      t.bonusCharged = plan.newCharged;
      t.bonusFree = plan.newFree;
      d2.teams[i] = recalcTeam(t, maxB);
    });

    const move = (x, sign) => {
      const pi = info.get(x.id);
      if (!pi || !pi.exists) throw new Error('Captain not found.');
      const bal = pi.earned + ledgerSum(pi.ledger);
      const pts = sign * x.pts;
      pi.ledger.push({
        id: newLedgerId(), ts: ts(), type: sign < 0 ? 'auction-bonus' : 'auction-bonus-refund', points: pts, balanceAfter: bal + pts,
        matchId: m.id, matchNumber: d2.number, by: S.user.uid, byName: myName(), note: sign < 0 ? 'Bonus used' : 'Bonus returned',
      });
      pi.dirty = true;
      touched.add(x.id);
    };
    refunds.forEach((x) => move(x, +1));
    charges.forEach((x) => move(x, -1));

    info.forEach((pi) => { if (pi.dirty) tx.update(pi.ref, { rewardLedger: pi.ledger }); });
    tx.update(mRef, JSON.parse(JSON.stringify({ teams: d2.teams, auctionStatus: d2.auctionStatus })));
    return d2;
  });
  await afterRosterChange(m.id, d);
  if (touched.size) await recomputeStats([...touched]);
  toast('Captains saved.');
}

async function recordPick(form, m) {
  clearFail(form);
  const fd = new FormData(form);
  const idx = Number(fd.get('team'));
  const playerId = String(fd.get('player') || '');
  const price = Number(fd.get('price'));
  const pl = playerById(playerId);
  if (!pl) return fail(form, 'Choose a player.');
  const d = await mutateMatch(m.id, (d2) => {
    const t = d2.teams[idx];
    t.picks = [...(t.picks || []), { playerId, playerName: pl.name, points: price, ts: ts() }];
    d2.teams[idx] = recalcTeam(t, maxBudgetOf(d2));
    return ['teams'];
  });
  await afterRosterChange(m.id, d);
  toast(`${pl.name} added.`);
}

async function undoPick(m, idx, playerId) {
  const d = await mutateMatch(m.id, (d2) => {
    const t = d2.teams[idx];
    t.picks = (t.picks || []).filter((p) => p.playerId !== playerId);
    d2.teams[idx] = recalcTeam(t, maxBudgetOf(d2));
    return ['teams'];
  });
  await afterRosterChange(m.id, d);
  toast('Pick undone.');
}

async function setAuctionStatus(m, status) {
  await mutateMatch(m.id, (d2) => { d2.auctionStatus = status; return ['auctionStatus']; });
  toast(status === 'completed' ? 'Auction complete.' : 'Auction re-opened.');
}

async function savePool(form, m) {
  const ids = $$('input[name="pool"]', form).filter((i) => i.checked || i.disabled).map((i) => i.value);
  await mutateMatch(m.id, (d) => { d.pool = [...new Set(ids)]; return ['pool']; });
  toast('Pool saved.');
}

async function changeStatus(m, kind) {
  if (kind === 'live') {
    const d = await mutateMatch(m.id, (d2) => { d2.status = 'live'; return ['status']; });
    await afterRosterChange(m.id, d);
    toast('Match is LIVE.');
  } else if (kind === 'reopen') {
    const d = await mutateMatch(m.id, (d2) => { d2.status = 'live'; d2.result = null; return ['status', 'result']; });
    await afterRosterChange(m.id, d);
    toast('Match re-opened.');
  }
}

async function declareResult(form, m) {
  clearFail(form);
  const v = String(new FormData(form).get('outcome') || '');
  const result = v === 'draw' ? { outcome: 'draw', winnerIndex: null } : { outcome: 'win', winnerIndex: Number(v.split(':')[1]) };
  const d = await mutateMatch(m.id, (d2) => {
    d2.status = 'completed';
    d2.result = { ...result, declaredAt: ts() };
    d2.auctionStatus = 'completed';
    return ['status', 'result', 'auctionStatus'];
  });
  await afterRosterChange(m.id, d);
  toast('Result declared.');
}

async function deleteMatch(m) {
  await mutateMatch(m.id, () => {});
  await deleteDoc(doc(db, 'matches', m.id));
  toast('Match deleted.');
  go('matches');
}

async function changeScore(m, idx, delta) {
  await mutateMatch(m.id, (d) => {
    const sc = [...(d.scores || [])];
    while (sc.length < d.teams.length) sc.push(0);
    sc[idx] = Math.max(0, toNum(sc[idx]) + delta);
    d.scores = sc;
    return ['scores'];
  });
}
async function confirmScore(m) {
  toast('Score confirmed.');
}

async function savePlayerStats(form, m) {
  clearFail(form);
  const updates = new Map();
  for (const inp of $$('input[data-pm]', form)) {
    const v = Number(inp.value) || 0;
    const id = inp.dataset.pm;
    const o = updates.get(id) || {};
    o[{ normal: 'normalGoals', penalty: 'penaltyGoals', reward: 'rewardPointsEarned' }[inp.dataset.field]] = v;
    updates.set(id, o);
  }
  const batch = writeBatch(db);
  updates.forEach((o, id) => batch.update(doc(db, 'playerMatches', id), { ...o, goals: toNum(o.normalGoals) + toNum(o.penaltyGoals) }));
  await batch.commit();
  await recomputeStats(S.pm.map((r) => r.playerId));
  toast('Stats saved.');
}

function applyRules(form, m) {
  toast('Rules applied.');
}

async function setFeeStatus(m, pid, status) {
  await mutateMatch(m.id, (d) => { d.fees = { ...(d.fees || {}) }; d.fees[pid] = { ...(d.fees[pid] || {}), status, paid: status === 'paid' }; return ['fees']; });
}
async function markAllPaid(m) {
  await mutateMatch(m.id, (d) => {
    d.fees = { ...(d.fees || {}) };
    buildRoster(d).forEach((r) => { d.fees[r.playerId] = { ...(d.fees[r.playerId] || {}), status: 'paid', paid: true }; });
    return ['fees'];
  });
  toast('Everyone marked as paid.');
}
async function addExpense(form, m) {
  const fd = new FormData(form);
  await mutateMatch(m.id, (d) => { d.expenses = [...(d.expenses || []), { id: `${ts()}`, label: fd.get('label'), amount: Number(fd.get('amount')) }]; return ['expenses']; });
  form.reset();
  toast('Expense added.');
}
async function deleteExpense(m, id) {
  await mutateMatch(m.id, (d) => { d.expenses = (d.expenses || []).filter((x) => x.id !== id); return ['expenses']; });
  toast('Expense deleted.');
}

function redeemDialog(m, pid) {
  toast('Money converter ready.');
}
async function undoRedeem(m, pid) {
  toast('Discount undone.');
}

// ---------------- Rewards & Settings & Admin Views ----------------
function rewardsView() { return `<div class="page-head"><h1>Reward Points</h1></div>`; }
function adjustDialog(pid) {}
function historyDialog(pid) {}
function adminsView() { return `<div class="page-head"><h1>Manage Admins</h1></div>`; }
async function createAdminFromForm(form) {}
async function toggleAdmin(id) {}
function resetAdminDialog(id) {}
async function removeAdminAccount(id) {}
function financeView() { return `<div class="page-head"><h1>Finance</h1></div>`; }
function announcementsView() { return `<div class="page-head"><h1>Announcements</h1></div>`; }
async function saveAnnouncement(form) {}
function historyView() { return `<div class="page-head"><h1>History</h1></div>`; }
async function backup(btn) {}
async function rebuildAll() {}
function settingsView() { return `<div class="page-head"><h1>Settings</h1></div>`; }
async function saveSettings(form) {}
async function loadInitialData() {}
async function openStatsDialog(pid) {}

// Event listeners setup
const content = $('#content');
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]');
  if (g && S.user) { e.preventDefault(); go(g.dataset.go, g.dataset.id || null); return; }
});

(async function init() {
  try {
    await setPersistence(auth, browserLocalPersistence);
  } catch (e) {
    console.error('Persistence error', e);
  }
  onAuthStateChanged(auth, (user) => {
    stopAccessWatch();
    if (user) {
      S.user = user;
      S.isOwner = user.uid === OWNER_UID;
      showChecking();
      startAccessWatch(user);
    } else {
      S.user = null;
      S.isOwner = false;
      S.me = null;
      S.admins = [];
      S.accessOk = false;
      stopListeners();
      S.seeded = false;
      showLogin();
    }
  });
})();