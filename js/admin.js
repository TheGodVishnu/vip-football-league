// =====================================================================
// VIP FOOTBALL LEAGUE — ADMIN PANEL
// Real security lives in firestore.rules + the Cloud Functions (only the Owner or an ACTIVE
// admin can write). This file only gives admins a friendly way to use that access.
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
  me: null, // this admin's own record from the `admins` collection
  admins: [], // Owner only: every admin account
  adminForm: false,
  redeeming: new Set(), // guards against double clicks on redemption
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
    return 'Firestore refused this change. Your admin access may have been disabled by the Owner, or the Firestore rules are not published yet.';
  }
  if (code === 'functions/not-found' || /NOT_FOUND|Failed to fetch|network|CORS/i.test((e && e.message) || '')) {
    if (String(code).startsWith('functions/')) return 'The admin service (Cloud Functions) is not reachable. Make sure it is deployed — see DEPLOYMENT-GUIDE.md.';
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
// Image resize (photos are saved inside Firestore — no paid Storage needed)
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
// Database write helpers (transactions for match changes)
// ---------------------------------------------------------------------
// fn(d) edits a copy of the match and returns the list of top-level keys it changed.
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

// Makes the playerMatches records match the match document (roster, team, result, status).
// Goals / reward points already typed in are kept. Returns every affected player id.
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
      participation: r.isCaptain ? PARTICIPATION.PLAYED : participationOf(m, r.playerId), // copied from the match (default: played)
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

// Rebuilds a player's aggregate stats from scratch (so nothing is ever double counted).
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

// THE shared points balance (Auction Points = Reward Points).
// = points earned in completed matches + every entry in the player's points ledger.
const balanceOf = (p) => sharedBalance((S.stats.get(p.id) || {}).rewardEarned, p.rewardLedger);
const myName = () => (S.me && (S.me.displayName || S.me.username)) || (S.isOwner ? 'Owner' : 'Admin');

// ---------------------------------------------------------------------
// Authentication (username + password; the Cloud Function hides the internal e-mail)
// ---------------------------------------------------------------------
const callAdminLogin = httpsCallable(functions, 'adminLogin');
const callCreateAdmin = httpsCallable(functions, 'createAdmin');
const callSetAdminActive = httpsCallable(functions, 'setAdminActive');
const callRemoveAdmin = httpsCallable(functions, 'removeAdmin');
const callResetAdminPassword = httpsCallable(functions, 'resetAdminPassword');

function loginErr(e) {
  const code = (e && e.code) || '';
  if (
    code === 'auth/invalid-credential' ||
    code === 'auth/wrong-password' ||
    code === 'auth/user-not-found' ||
    code === 'auth/invalid-email'
  ) {
    return 'Wrong email/username or password.';
  }
  if (code === 'auth/too-many-requests') {
    return 'Too many attempts. Wait a few minutes and try again.';
  }
  if (code === 'functions/unauthenticated' || code === 'functions/invalid-argument') return (e.message && !/^(unauthenticated|invalid-argument)$/i.test(e.message)) ? e.message : 'Wrong email/username or password.';
  if (code === 'functions/permission-denied' || code === 'functions/resource-exhausted' || code === 'functions/failed-precondition') return e.message;
  if (code === 'functions/internal') return e.message && e.message !== 'internal' ? e.message : 'Login service error. Please try again in a minute.';
  if (code === 'functions/not-found' || code === 'functions/unavailable' || /Failed to fetch|network/i.test((e && e.message) || '')) return 'Cannot reach the username login service. Check your internet or sign in with your registered email and password. (If this is the first setup, deploy the Cloud Functions — see DEPLOYMENT-GUIDE.md.)';
  if (code === 'auth/network-request-failed') return 'No internet connection.';
  if (code === 'auth/user-disabled') return 'This admin account is disabled. Ask the Owner to re-activate it.';
  return 'Could not sign in. Please try again.';
}

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
  if (!identifier || !password) { $('#loginError').textContent = 'Enter your email or username and password.'; return; }
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    if (identifier.includes('@')) {
      const cred = await signInWithEmailAndPassword(auth, identifier.toLowerCase(), password);
      if (cred && cred.user && cred.user.uid === OWNER_UID) {
        // Keep Owner record synced for username login too (only Owner UID can write this doc)
        setDoc(doc(db, 'admins', OWNER_UID), {
          role: 'owner',
          email: cred.user.email || identifier.toLowerCase(),
          active: true,
          lastLoginAt: ts(),
        }, { merge: true }).catch(() => {});
      }
    } else {
      const res = await callAdminLogin({ username: identifier, password });
      await signInWithCustomToken(auth, res.data.token);
    }
    $('#loginPassword').value = '';
  } catch (err) {
    console.error(err);
    $('#loginError').textContent = loginErr(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

// The Sign out button ends THIS session. (Closing the tab or browser is NOT a sign-out.)
$('#logoutBtn').addEventListener('click', () => { S.logoutMsg = ''; signOut(auth); });

async function forceLogout(message) {
  S.logoutMsg = message || '';
  try { await signOut(auth); } catch (e) { console.error(e); }
}

// Is this signed-in person still allowed to be an admin? Checked live, all the time.
function judgeMe(snap) {
  S.me = snap && snap.exists() ? snap.data() : null;
  if (S.isOwner) return true; // the Owner is identified by UID and can never be locked out by a record
  return !!(S.me && S.me.active === true);
}
async function recheckAccess() {
  if (!S.user || S.isOwner) return;
  try {
    const snap = await getDoc(doc(db, 'admins', S.user.uid));
    if (!judgeMe(snap)) forceLogout('Your admin access has been disabled by the Owner.');
  } catch (e) {
    console.error('recheck', e);
  }
}
function startAccessWatch(user) {
  stopAccessWatch();
  S.accessOk = false;
  S.meUnsub = onSnapshot(
    doc(db, 'admins', user.uid),
    (snap) => {
      const ok = judgeMe(snap);
      if (!ok) { forceLogout(S.accessOk ? 'Your admin access was just disabled by the Owner. You have been signed out.' : 'This account is not an active admin account.'); return; }
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
      if (err && err.code === 'permission-denied') forceLogout('Your session is no longer valid. Please sign in again.');
      else if (!S.accessOk) { forceLogout('Could not verify your access (no connection?). Please try again.'); }
    }
  );
}
function stopAccessWatch() {
  if (S.meUnsub) { S.meUnsub(); S.meUnsub = null; }
}

// ---------------------------------------------------------------------
// Live listeners (admin sees the same real-time data)
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
    // Owner only (Firestore rules refuse everybody else). Does not block the page from loading.
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
// Rendering
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
        ${field('Bonus points', `<input name="bonus${i}" type="number" min="0" step="1" value="${esc(toNum(t.bonusPoints))}" ${locked ? 'disabled' : ''}>`, 'Taken from this captain’s shared points balance (Auction Points = Reward Points).')}
      </div>
      ${field('Vice captain', picks.length ? `<select name="vice${i}" ${locked ? 'disabled' : ''}><option value="">— none —</option>${picks.map((p) => `<option value="${esc(p.playerId)}" ${t.viceCaptainId === p.playerId ? 'selected' : ''}>${esc(p.playerName)}</option>`).join('')}</select>` : '<input disabled value="Buy players first, then choose a vice captain">')}
      <div class="hint" id="hint${i}">${captainHint(m, i, t.captainId)}</div>
      ${budgetGridHtml(t)}</div>`;
    })
    .join('');
  return `<section class="card" id="sec-captains"><h3>Captains &amp; budgets</h3>
    <p class="small muted" style="margin-bottom:12px">Total = starting + bonus. Usable = the smaller of Total and the max budget (<b>${maxB}</b>). Anything above is Excess. Remaining = Usable − Spent. Bonus points are deducted from the captain’s shared points balance — the same balance as Reward Points.</p>
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
    <p class="small muted" style="margin-bottom:12px">Being bought in the auction does not mean the player played. Set the real status for every purchased player of <b>this match only</b> — other matches are not affected, and the auction purchase itself never changes. Players with no status count as <b>Played</b>. Captains always count as played. You can change this after the match too; statistics rebuild automatically.</p>
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
        message: `${g ? `${g} goal(s) are recorded for this player in this match and will stop counting in statistics (they are kept, so switching back restores them). ` : ''}${rp ? `${rp} reward point(s) were entered for this match and stay in the balance unless you change them in Score & player stats. ` : ''}Continue?`,
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
      <p class="small muted" style="margin-top:10px">Saved goals so far: <b>${totN}</b> normal + <b>${totP}</b> penalty = <b>${totN + totP}</b>. Team score total: ${scoreKnown(m) ? sc.reduce((a, b) => a + b, 0) : 'not recorded'} (they can differ, e.g. own goals).${allZero ? ' Reward earning rules are all 0 in Settings, so enter reward points by hand.' : ''}</p>
      <div class="form-error" role="alert"></div>
      <div class="row-actions"><button class="btn primary" type="submit">Save goals &amp; reward points</button><button type="button" class="btn" data-act="apply-rules" ${allZero ? 'disabled' : ''}>Fill reward points from rules</button></div></form>`;
  }
  return `<section class="card" id="sec-score"><h3>Score &amp; player stats</h3>
    ${enabled ? '' : '<p class="small muted" style="margin-bottom:10px">Start the match (Status section) to enter the score.</p>'}
    ${enabled && !scoreKnown(m) ? '<div class="alert warn">The final score of this match was not recorded. Set it with + / − below, or confirm the current numbers. <button class="btn small" data-act="score-confirm" style="margin-left:6px">Confirm 0 – 0</button></div>' : ''}
    <div class="score-board">${board}</div>
    <h4 class="sec-title" style="font-size:20px">Goals &amp; reward points per player</h4>${stats}
    <p class="small muted" style="margin-top:10px">Player statistics are counted from completed matches only and are rebuilt from scratch every time you save, so editing a result never double-counts. You can edit goals of completed matches too.</p></section>`;
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
        <div class="meta">${esc(r.teamName)}${noFee ? '' : ` · due ${money(f.fee - disc, sym)}`}${disc ? ` (discount ${money(disc, sym)} for ${toNum(fe.redeemedPoints)} points)` : ''}</div></div>
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
    ${roster.length ? `${rows}<div class="row-actions"><button class="btn small" data-act="fees-all">Mark everyone paid</button><span class="small muted">${f.paidCount} paid · ${f.pendingCount} pending · ${f.unconfirmedCount} not confirmed${noFee ? '' : ` · outstanding ${money(f.outstanding, sym)}`}</span></div>` : '<p class="small muted">Fees appear once players are on teams.</p>'}
    <h4 class="sec-title" style="font-size:20px">Expenses</h4>${exp || '<p class="small muted">No expenses recorded.</p>'}
    <form data-form="expense" class="grid-form" style="margin-top:10px">${field('What for', '<input name="label" maxlength="60" required placeholder="Ground booking, water, bibs…">')}${field(`Amount (${esc(sym)})`, '<input name="amount" type="number" min="0" step="0.5" required inputmode="decimal">')}
    <div class="form-error" role="alert" style="grid-column:1/-1"></div><div class="row-actions" style="grid-column:1/-1;margin-top:0"><button class="btn primary" type="submit">Add expense</button></div></form></section>`;
}

function logSection(m) {
  const log = [...(m.auctionLog || [])].reverse();
  return `<section class="card" id="sec-log"><h3>Auction log <span class="small muted">(permanent record)</span></h3>
    ${log.length ? `<ol class="log-list">${log.map((e) => `<li><time>${new Date(e.ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</time><span>${logText(e)}</span></li>`).join('')}</ol>` : '<p class="small muted">Nothing yet.</p>'}
    <div class="row-actions"><button class="btn small ghost" data-act="resync">Repair player records</button></div></section>`;
}

// ----- match actions -----
async function saveMatchDetails(form, m) {
  clearFail(form);
  const fd = new FormData(form);
  const dateRaw = String(fd.get('date') || '').trim();
  const dateMs = dateRaw ? new Date(dateRaw).getTime() : null;
  const feeRaw = String(fd.get('fee') || '').trim();
  const fee = feeRaw === '' ? null : Number(feeRaw);
  if (dateRaw && !Number.isFinite(dateMs)) return fail(form, 'Choose a valid date and time.');
  if (!dateRaw && m.status === 'upcoming') return fail(form, 'An upcoming match needs a date and time.');
  if (fee !== null && (!Number.isFinite(fee) || fee < 0)) return fail(form, 'Entry fee must be 0 or more (or leave it empty).');
  const names = (m.teams || []).map((_, i) => String(fd.get(`t${i}`) || '').trim());
  if (names.some((x) => !x)) return fail(form, 'Every team needs a name.');
  if (new Set(names.map((x) => x.toLowerCase())).size !== names.length) return fail(form, 'Team names must be different.');
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
    if (!Number.isInteger(bonus)) return fail(form, 'Bonus points must be a whole number.');
    caps.push({ id: String(fd.get(`cap${i}`) || ''), start, bonus, vice: fd.has(`vice${i}`) ? String(fd.get(`vice${i}`) || '') : null });
  }
  const chosen = caps.map((c) => c.id).filter(Boolean);
  if (new Set(chosen).size !== chosen.length) return fail(form, 'The same player cannot captain two teams.');

  // One transaction: the match AND the captains' shared point balances change together or not at all.
  const touched = new Set();
  const d = await runTransaction(db, async (tx) => {
    const mRef = doc(db, 'matches', m.id);
    const mSnap = await tx.get(mRef);
    if (!mSnap.exists()) throw new Error('This match no longer exists.');
    const d2 = structuredClone(mSnap.data());
    if (d2.status === 'completed') throw new Error('Re-open the match before changing captains.');

    // read every captain involved (old and new) BEFORE writing anything
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
      if (c.id && d2.teams.some((o) => (o.picks || []).some((p) => p.playerId === c.id))) throw new Error('A player who was already bought cannot be a captain. Undo that pick first.');
      const oldId = t.captainId || '';
      const changed = c.id !== oldId || c.start !== toNum(t.startingPoints) || c.bonus !== toNum(t.bonusPoints);
      const pl = c.id ? playerById(c.id) : null;
      const plan = planCaptainBonus(t, c.id, c.bonus); // decided BEFORE the team is modified
      plan.refunds.forEach((x) => refunds.push({ id: x.playerId, pts: x.points, team: t.name, i }));
      plan.charges.forEach((x) => charges.push({ id: x.playerId, pts: x.points, team: t.name, i }));
      const newCharged = plan.newCharged;
      const newFree = plan.newFree;

      t.captainId = c.id || null;
      t.captainName = c.id ? (pl ? pl.name : t.captainName || '') : '';
      t.startingPoints = c.start;
      t.bonusPoints = c.bonus;
      t.bonusCharged = newCharged;
      t.bonusFree = newFree;
      if (c.vice !== null) {
        const vp = c.vice ? (t.picks || []).find((p) => p.playerId === c.vice) : null;
        if (c.vice && !vp) throw new Error('The vice captain must be one of the players bought by this team.');
        t.viceCaptainId = vp ? vp.playerId : null;
        t.viceCaptainName = vp ? vp.playerName : '';
      }
      d2.teams[i] = recalcTeam(t, maxB);
      if (d2.teams[i].remainingPoints < 0) throw new Error(`${t.name}: this budget is lower than what the team has already spent (${d2.teams[i].spentPoints}).`);
      if (changed && c.id) {
        const nt = d2.teams[i];
        logs.push({ ts: ts(), type: 'captain', teamIndex: i, teamName: nt.name, playerId: c.id, playerName: nt.captainName, startingPoints: nt.startingPoints, bonusPoints: nt.bonusPoints, totalBeforeCap: nt.totalBeforeCap, usablePoints: nt.usablePoints, excessPoints: nt.excessPoints });
      }
    });

    // apply the point movements: refunds first, then charges (so a swap between teams works)
    const move = (x, sign) => {
      const pi = info.get(x.id);
      if (!pi || !pi.exists) throw new Error('A captain could not be found in the player list.');
      const bal = pi.earned + ledgerSum(pi.ledger);
      const pts = sign * x.pts;
      if (bal + pts < 0) throw new Error(`${pi.name} has only ${bal} points in the shared balance, so ${x.pts} cannot be used as bonus. Lower the bonus.`);
      pi.ledger.push({
        id: newLedgerId(), ts: ts(), type: sign < 0 ? 'auction-bonus' : 'auction-bonus-refund', points: pts, balanceAfter: bal + pts,
        matchId: m.id, matchNumber: d2.number, by: S.user.uid, byName: myName(),
        note: sign < 0 ? `Auction bonus used — Match #${d2.number} (${x.team})` : `Auction bonus returned — Match #${d2.number} (${x.team})`,
      });
      pi.dirty = true;
      touched.add(x.id);
      logs.push({ ts: ts(), type: 'bonus-charge', teamIndex: x.i, teamName: x.team, playerId: x.id, playerName: pi.name, points: pts });
    };
    refunds.forEach((x) => move(x, +1));
    charges.forEach((x) => move(x, -1));

    d2.auctionLog = [...(d2.auctionLog || []), ...logs];
    if (d2.auctionStatus === 'pending' && d2.teams.some((t) => t.captainId)) d2.auctionStatus = 'inProgress';

    info.forEach((pi) => { if (pi.dirty) tx.update(pi.ref, { rewardLedger: pi.ledger }); });
    tx.update(mRef, JSON.parse(JSON.stringify({ teams: d2.teams, auctionLog: d2.auctionLog, auctionStatus: d2.auctionStatus })));
    return d2;
  });
  await afterRosterChange(m.id, d);
  if (touched.size) await recomputeStats([...touched]);
  toast(touched.size ? 'Captains saved. Bonus points moved in the shared points balance.' : 'Captains saved.');
}

async function recordPick(form, m) {
  clearFail(form);
  const fd = new FormData(form);
  const idx = Number(fd.get('team'));
  const playerId = String(fd.get('player') || '');
  const priceRaw = String(fd.get('price') || '').trim();
  const price = Number(priceRaw);
  if (!playerId) return fail(form, 'Choose a player.');
  if (priceRaw === '' || !Number.isInteger(price) || price < 0) return fail(form, 'Points must be a whole number (0 or more).');
  const pl = playerById(playerId);
  if (!pl) return fail(form, 'That player no longer exists.');
  const d = await mutateMatch(m.id, (d2) => {
    if (d2.status === 'completed') throw new Error('Re-open the match before changing the auction.');
    const t = d2.teams[idx];
    if (!t) throw new Error('Team not found.');
    if (!t.captainId) throw new Error('Select and save this team’s captain first.');
    if (d2.teams.some((o) => o.captainId === playerId || (o.picks || []).some((p) => p.playerId === playerId))) throw new Error(`${pl.name} is already on a team in this match.`);
    const cur2 = recalcTeam(t, toNum(d2.auctionSettings && d2.auctionSettings.maxBudget, S.settings.auction.maxBudget));
    if (price > cur2.remainingPoints) throw new Error(`${t.name} only has ${cur2.remainingPoints} points left — cannot pay ${price}.`);
    const order = d2.teams.reduce((s, x) => s + (x.picks || []).length, 0) + 1;
    t.picks = [...(t.picks || []), { playerId, playerName: pl.name, points: price, order, ts: ts() }];
    d2.teams[idx] = recalcTeam(t, toNum(d2.auctionSettings && d2.auctionSettings.maxBudget, S.settings.auction.maxBudget));
    d2.auctionLog = [...(d2.auctionLog || []), { ts: ts(), type: 'pick', teamIndex: idx, teamName: t.name, playerId, playerName: pl.name, points: price }];
    if (d2.auctionStatus === 'pending') d2.auctionStatus = 'inProgress';
    return ['teams', 'auctionLog', 'auctionStatus'];
  });
  await afterRosterChange(m.id, d);
  toast(`${pl.name} → ${d.teams[idx].name} for ${price} pts.`);
}

async function undoPick(m, idx, playerId) {
  const t = (m.teams || [])[idx];
  const pk = t && (t.picks || []).find((p) => p.playerId === playerId);
  if (!pk) return;
  const ok = await confirmDialog({
    title: 'Undo this pick?', message: `${pk.playerName} will leave ${t.name} and ${toNum(pk.points)} points return to the team. Any goals or reward points typed for this player in this match will be removed. The undo is written to the auction log.`,
    confirmText: 'Undo pick', danger: true,
  });
  if (!ok) return;
  const d = await mutateMatch(m.id, (d2) => {
    if (d2.status === 'completed') throw new Error('Re-open the match before changing the auction.');
    const tt = d2.teams[idx];
    tt.picks = (tt.picks || []).filter((p) => p.playerId !== playerId);
    if (tt.viceCaptainId === playerId) { tt.viceCaptainId = null; tt.viceCaptainName = ''; }
    if (d2.participation && d2.participation[playerId]) { d2.participation = { ...d2.participation }; delete d2.participation[playerId]; }
    d2.teams[idx] = recalcTeam(tt, toNum(d2.auctionSettings && d2.auctionSettings.maxBudget, S.settings.auction.maxBudget));
    d2.auctionLog = [...(d2.auctionLog || []), { ts: ts(), type: 'undo-pick', teamIndex: idx, teamName: tt.name, playerId, playerName: pk.playerName, points: toNum(pk.points) }];
    return ['teams', 'auctionLog', 'participation'];
  });
  await afterRosterChange(m.id, d);
  toast('Pick undone.');
}

async function setAuctionStatus(m, status) {
  const d = await mutateMatch(m.id, (d2) => {
    d2.auctionStatus = status;
    d2.auctionLog = [...(d2.auctionLog || []), { ts: ts(), type: status === 'completed' ? 'auction-complete' : 'auction-reopen' }];
    return ['auctionStatus', 'auctionLog'];
  });
  toast(status === 'completed' ? 'Auction marked complete.' : 'Auction re-opened.');
  return d;
}

async function savePool(form, m) {
  const ids = $$('input[name="pool"]', form).filter((i) => i.checked || i.disabled).map((i) => i.value);
  await mutateMatch(m.id, (d) => { d.pool = [...new Set(ids)]; return ['pool']; });
  toast(`Auction pool saved (${ids.length} players).`);
}

async function changeStatus(m, kind) {
  if (kind === 'live') {
    const noCaps = (m.teams || []).some((t) => !t.captainId);
    const notDone = m.auctionStatus !== 'completed';
    if (noCaps || notDone) {
      const ok = await confirmDialog({ title: 'Start without finishing the auction?', message: `${noCaps ? 'Some teams have no captain. ' : ''}${notDone ? 'The auction is not marked complete. ' : ''}You can still start the match now.`, confirmText: 'Start match' });
      if (!ok) return;
    }
    const d = await mutateMatch(m.id, (d2) => { d2.status = 'live'; return ['status']; });
    await afterRosterChange(m.id, d);
    toast('Match is LIVE on the website.');
  } else if (kind === 'reopen') {
    const ok = await confirmDialog({ title: 'Re-open this match?', message: 'The match goes back to LIVE and the declared result is cleared. Player statistics are rebuilt automatically.', confirmText: 'Re-open' });
    if (!ok) return;
    const d = await mutateMatch(m.id, (d2) => { d2.status = 'live'; d2.result = null; return ['status', 'result']; });
    await afterRosterChange(m.id, d);
    toast('Match re-opened.');
  }
}

async function declareResult(form, m) {
  clearFail(form);
  if (!scoreKnown(m)) return fail(form, 'Set or confirm the final score first (Score section below).');
  const v = String(new FormData(form).get('outcome') || '');
  const result = v === 'draw' ? { outcome: 'draw', winnerIndex: null } : { outcome: 'win', winnerIndex: Number(v.split(':')[1]) };
  const label = result.outcome === 'draw' ? 'a draw' : `a win for ${m.teams[result.winnerIndex].name}`;
  const ok = await confirmDialog({ title: 'Declare result?', message: `Final score ${(m.scores || []).map(toNum).join(' – ')}, recorded as ${label}. Player wins/losses/draws and statistics will be updated. You can re-open the match later if needed.`, confirmText: 'Declare result' });
  if (!ok) return;
  const d = await mutateMatch(m.id, (d2) => {
    d2.status = 'completed';
    d2.result = { ...result, declaredAt: ts() };
    if (d2.auctionStatus !== 'completed') {
      d2.auctionStatus = 'completed';
      d2.auctionLog = [...(d2.auctionLog || []), { ts: ts(), type: 'auction-complete' }];
    }
    return ['status', 'result', 'auctionStatus', 'auctionLog'];
  });
  await afterRosterChange(m.id, d);
  toast('Result declared. Stats updated.');
}

async function deleteMatch(m) {
  if ((m.teams || []).some((t) => (t.picks || []).length)) return toast('A match with auction picks cannot be deleted (history is protected).', 'err');
  const refundN = (m.teams || []).reduce((n, t) => n + (t.captainId && toNum(t.bonusCharged) > 0 ? 1 : 0), 0);
  const ok = await confirmDialog({ title: `Delete Match #${m.number}?`, message: `This empty, not-yet-started match will be removed permanently.${refundN ? ' Bonus points already taken from captains for this match are returned to their shared points balance.' : ''}`, confirmText: 'Delete match', danger: true });
  if (!ok) return;
  const refunded = [];
  await runTransaction(db, async (tx) => {
    const mRef = doc(db, 'matches', m.id);
    const mSnap = await tx.get(mRef);
    if (!mSnap.exists()) return;
    const md = mSnap.data();
    if ((md.teams || []).some((t) => (t.picks || []).length)) throw new Error('This match now has auction picks and cannot be deleted.');
    const jobs = (md.teams || []).filter((t) => t.captainId && toNum(t.bonusCharged) > 0);
    const reads = [];
    for (const t of jobs) reads.push({ t, pSnap: await tx.get(doc(db, 'players', t.captainId)), sSnap: await tx.get(doc(db, 'playerStats', t.captainId)) });
    for (const { t, pSnap, sSnap } of reads) {
      if (!pSnap.exists()) continue;
      const ledger = [...(pSnap.data().rewardLedger || [])];
      const bal = sharedBalance(sSnap.exists() ? sSnap.data().rewardEarned : 0, ledger);
      ledger.push({ id: newLedgerId(), ts: ts(), type: 'auction-bonus-refund', points: toNum(t.bonusCharged), balanceAfter: bal + toNum(t.bonusCharged), matchId: m.id, matchNumber: md.number, by: S.user.uid, byName: myName(), note: `Auction bonus returned — Match #${md.number} deleted` });
      tx.update(pSnap.ref, { rewardLedger: ledger });
      refunded.push(t.captainId);
    }
    tx.delete(mRef);
  });
  const pms = await getDocs(query(collection(db, 'playerMatches'), where('matchId', '==', m.id)));
  const ids = [...pms.docs.map((d) => d.data().playerId), ...refunded];
  const batch = writeBatch(db);
  pms.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  await recomputeStats(ids);
  toast('Match deleted.');
  go('matches');
}

async function changeScore(m, idx, delta) {
  await mutateMatch(m.id, (d) => {
    const sc = [...(d.scores || [])];
    while (sc.length < d.teams.length) sc.push(0);
    sc[idx] = Math.max(0, toNum(sc[idx]) + delta);
    d.scores = sc;
    d.scoreUnknown = false;
    return ['scores', 'scoreUnknown'];
  });
}
async function confirmScore(m) {
  await mutateMatch(m.id, (d) => { d.scoreUnknown = false; return ['scoreUnknown']; });
  toast('Score confirmed.');
}

async function savePlayerStats(form, m) {
  clearFail(form);
  const updates = new Map();
  for (const inp of $$('input[data-pm]', form)) {
    const v = Number(inp.value);
    if (!Number.isInteger(v) || v < 0) return fail(form, 'Goals and reward points must be whole numbers (0 or more).');
    const id = inp.dataset.pm;
    const o = updates.get(id) || {};
    o[{ normal: 'normalGoals', penalty: 'penaltyGoals', reward: 'rewardPointsEarned' }[inp.dataset.field]] = v;
    updates.set(id, o);
  }
  const batch = writeBatch(db);
  updates.forEach((o, id) => batch.update(doc(db, 'playerMatches', id), { ...o, goals: toNum(o.normalGoals) + toNum(o.penaltyGoals) }));
  await batch.commit();
  await recomputeStats(S.pm.map((r) => r.playerId));
  toast('Goals & reward points saved. Stats updated.');
}

function applyRules(form, m) {
  const earn = S.settings.reward.earn;
  S.pm.forEach((r) => {
    const q = (f) => $(`input[data-pm="${CSS.escape(r.id)}"][data-field="${f}"]`, form);
    const n = q('normal'), pn = q('penalty'), rw = q('reward');
    if (!n || !pn || !rw) return;
    if (!r.isCaptain && participationOf(m, r.playerId) === PARTICIPATION.NOT_PLAYED) { rw.value = 0; return; } // did not play: no participation / win / draw / goal points
    let pts = toNum(earn.participation) + (toNum(n.value) + toNum(pn.value)) * toNum(earn.goal) + (r.isCaptain ? toNum(earn.captain) : 0);
    const res = resultFor(m, r.teamIndex);
    if (res === 'win') pts += toNum(earn.win);
    if (res === 'draw') pts += toNum(earn.draw);
    rw.value = Math.max(0, Math.round(pts));
  });
  toast('Filled from your reward rules (players marked Not played get 0). Check the numbers, then press Save.');
}

async function setFeeStatus(m, pid, status) {
  if (!['paid', 'pending', 'unconfirmed'].includes(status)) return;
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
  clearFail(form);
  const fd = new FormData(form);
  const label = String(fd.get('label') || '').trim();
  const amount = Number(fd.get('amount'));
  if (!label) return fail(form, 'Write what the expense was for.');
  if (!Number.isFinite(amount) || amount < 0) return fail(form, 'Amount must be 0 or more.');
  await mutateMatch(m.id, (d) => { d.expenses = [...(d.expenses || []), { id: `${ts()}`, label, amount, ts: ts() }]; return ['expenses']; });
  form.reset();
  toast('Expense added.');
}
async function deleteExpense(m, id) {
  const e = (m.expenses || []).find((x) => x.id === id);
  if (!e) return;
  const ok = await confirmDialog({ title: 'Delete expense?', message: `${e.label} — ${money(e.amount, cur())}`, confirmText: 'Delete', danger: true });
  if (!ok) return;
  await mutateMatch(m.id, (d) => { d.expenses = (d.expenses || []).filter((x) => x.id !== id); return ['expenses']; });
  toast('Expense deleted.');
}

function redeemDialog(m, pid) {
  const p = playerById(pid);
  if (!p) return;
  const bal = balanceOf(p);
  const sym = cur();
  const fee = nonNeg(m.entryFee);
  const tiers = S.settings.reward.tiers; // always the 3 fixed options
  const options = tiers.map((t, i) => {
    const needMore = t.points - bal;
    const tooBig = t.discount > fee;
    const ok = needMore <= 0 && !tooBig;
    const why = needMore > 0 ? `needs ${needMore} more points` : tooBig ? `more than the entry fee (${money(fee, sym)})` : '';
    return `<label class="conv-opt ${ok ? '' : 'off'}"><input type="radio" name="tier" value="${i}" ${ok ? '' : 'disabled'}>
      <span class="conv-pts">${t.points} points</span><span class="conv-off">${money(t.discount, sym)} OFF</span>${why ? `<small class="muted">${esc(why)}</small>` : ''}</label>`;
  }).join('');
  const any = tiers.some((t) => t.points <= bal && t.discount <= fee);
  const mm = openModal(`<h3>Money Converter</h3>
    <p class="muted"><b>${esc(p.name)}</b> has <b class="green">${bal}</b> points (one shared balance). Choose the discount for Match #${esc(m.number)} — entry fee ${money(fee, sym)}.</p>
    <div class="conv-list">${options}</div>
    ${any ? '' : '<p class="small muted">No option is available right now.</p>'}
    <div class="form-error" id="convErr"></div>
    <div class="modal-actions"><button class="btn ghost" data-m="no">Cancel</button><button class="btn primary" data-m="yes" ${any ? '' : 'disabled'}>Apply discount</button></div>`);
  mm.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    if (b.dataset.m === 'no') return mm.close();
    const sel = $('input[name="tier"]:checked', mm.el);
    if (!sel) { $('#convErr', mm.el).textContent = 'Choose one of the options first.'; return; }
    const tier = tiers[Number(sel.value)];
    b.disabled = true;
    mm.close();
    run(() => redeem(m, pid, tier));
  });
}
async function redeem(m, pid, tier) {
  // never trust what the screen sent: the option must be one of the 3 fixed ones
  if (!FIXED_TIERS.some((t) => t.points === tier.points && t.discount === tier.discount)) throw new Error('That is not a valid redemption option.');
  const key = `${m.id}:${pid}`;
  if (S.redeeming.has(key)) return; // a redemption for this player + match is already in progress
  S.redeeming.add(key);
  try {
    await runTransaction(db, async (tx) => {
      const pRef = doc(db, 'players', pid);
      const sRef = doc(db, 'playerStats', pid);
      const mRef = doc(db, 'matches', m.id);
      const pSnap = await tx.get(pRef);
      const sSnap = await tx.get(sRef);
      const mSnap = await tx.get(mRef);
      if (!pSnap.exists() || !mSnap.exists()) throw new Error('Player or match not found.');
      const ledger = [...(pSnap.data().rewardLedger || [])];
      const md = mSnap.data();
      const bal = sharedBalance(sSnap.exists() ? sSnap.data().rewardEarned : 0, ledger);
      if (bal < tier.points) throw new Error(`Not enough points: ${bal} available, ${tier.points} needed.`);
      if (nonNeg(((md.fees || {})[pid] || {}).discount) > 0) throw new Error('A discount is already applied for this player in this match.');
      const fee = nonNeg(md.entryFee);
      if (!fee) throw new Error('Set the entry fee of this match first.');
      if (tier.discount > fee) throw new Error('This discount is more than the entry fee.');
      ledger.push({
        id: newLedgerId(), ts: ts(), type: 'redeem', points: -tier.points, discount: tier.discount, balanceAfter: bal - tier.points,
        matchId: m.id, matchNumber: md.number, by: S.user.uid, byName: myName(), note: `Entry fee discount ${money(tier.discount, cur())} OFF — Match #${md.number}`,
      });
      const fees = { ...(md.fees || {}) };
      fees[pid] = { ...(fees[pid] || { paid: false }), discount: tier.discount, redeemedPoints: tier.points };
      tx.update(pRef, { rewardLedger: ledger });
      tx.update(mRef, { fees });
    });
    await recomputeStats([pid]);
    toast(`Discount applied: ${money(tier.discount, cur())} OFF (−${tier.points} points).`);
  } finally {
    S.redeeming.delete(key);
  }
}
async function undoRedeem(m, pid) {
  const fe = (m.fees || {})[pid] || {};
  const p = playerById(pid);
  const ok = await confirmDialog({ title: 'Undo discount?', message: `${p ? p.name : 'This player'} gets ${toNum(fe.redeemedPoints)} points back and the discount is removed for this match.`, confirmText: 'Undo discount' });
  if (!ok) return;
  await runTransaction(db, async (tx) => {
    const pRef = doc(db, 'players', pid);
    const sRef = doc(db, 'playerStats', pid);
    const mRef = doc(db, 'matches', m.id);
    const pSnap = await tx.get(pRef);
    const sSnap = await tx.get(sRef);
    const mSnap = await tx.get(mRef);
    const md = mSnap.data();
    const f2 = ((md.fees || {})[pid]) || {};
    const pts = toNum(f2.redeemedPoints);
    if (!pts) throw new Error('No discount to undo.');
    const old = pSnap.data().rewardLedger || [];
    const bal = sharedBalance(sSnap.exists() ? sSnap.data().rewardEarned : 0, old);
    const ledger = [...old, { id: newLedgerId(), ts: ts(), type: 'redeem-reversal', points: pts, balanceAfter: bal + pts, matchId: m.id, matchNumber: md.number, by: S.user.uid, byName: myName(), note: `Discount undone — Match #${md.number}` }];
    const fees = { ...(md.fees || {}) };
    fees[pid] = { ...f2, discount: 0, redeemedPoints: 0 };
    tx.update(pRef, { rewardLedger: ledger });
    tx.update(mRef, { fees });
  });
  await recomputeStats([pid]);
  toast('Discount undone.');
}

// ---------------- Rewards ----------------
function rewardsView() {
  const sym = cur();
  const rows = S.players
    .map((p) => {
      const st = S.stats.get(p.id) || {};
      const ledger = (p.rewardLedger || []).reduce((s, e) => s + toNum(e.points), 0);
      return { p, earned: toNum(st.rewardEarned), ledger, bal: toNum(st.rewardEarned) + ledger };
    })
    .filter((r) => r.p.active !== false || r.bal !== 0 || (r.p.rewardLedger || []).length)
    .sort((a, b) => b.bal - a.bal);
  const tiers = S.settings.reward.tiers;
  return `<div class="page-head"><h1>Reward Points</h1></div>
  <div class="alert ok"><b>One shared balance.</b> Auction Points and Reward Points are the same points: auction bonuses are taken from this balance, match rewards are added to it, and redemptions are taken from it. Earning rules are set in <a class="green" data-go="settings" href="#">Settings</a>. Use the <b>Money Converter</b> inside a match's Fees section.</div>
  <div class="card" style="margin-bottom:14px"><h3>Money Converter <span class="small muted">(fixed)</span></h3>${tiers.length ? tiers.map((t) => `<span class="chip" style="margin:0 6px 6px 0">${t.points} points = ${money(t.discount, sym)} OFF</span>`).join('') : '<p class="muted small">No table set.</p>'}</div>
  ${rows.length ? rows.map((r) => `<div class="arow"><div class="grow"><b>${esc(r.p.name)}</b><div class="small muted">Earned in matches ${r.earned} · bonus, adjustments &amp; redemptions ${r.ledger >= 0 ? '+' : ''}${r.ledger}</div></div>
    <b class="green" style="font-family:var(--font-head);font-size:26px">${r.bal}</b>
    <div class="acts"><button class="btn small" data-act="reward-adjust" data-id="${esc(r.p.id)}">Adjust</button><button class="btn small ghost" data-act="reward-history" data-id="${esc(r.p.id)}">History</button></div></div>`).join('') : '<div class="empty"><b>No reward points yet</b>Points appear after you enter them for a match.</div>'}`;
}
function adjustDialog(pid) {
  const p = playerById(pid);
  if (!p) return;
  const mm = openModal(`<h3>Adjust points</h3><p class="muted">${esc(p.name)} — current balance <b class="green">${balanceOf(p)}</b></p>
    <label class="field" style="margin-top:12px"><span>Points (use − to remove)</span><input id="adjPts" type="number" step="1" inputmode="numeric" placeholder="e.g. 20 or -10"></label>
    <label class="field"><span>Reason *</span><input id="adjNote" maxlength="80" placeholder="Why are you changing it?"></label>
    <div class="form-error" id="adjErr"></div>
    <div class="modal-actions"><button class="btn ghost" data-m="no">Cancel</button><button class="btn primary" data-m="yes">Save</button></div>`);
  mm.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    if (b.dataset.m === 'no') return mm.close();
    const pts = Number($('#adjPts', mm.el).value);
    const note = $('#adjNote', mm.el).value.trim();
    const err = $('#adjErr', mm.el);
    if (!Number.isInteger(pts) || pts === 0) { err.textContent = 'Enter a whole number that is not 0.'; return; }
    if (!note) { err.textContent = 'Please write a reason.'; return; }
    if (balanceOf(p) + pts < 0) { err.textContent = 'That would make the balance negative.'; return; }
    mm.close();
    run(async () => {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, 'players', pid);
        const sRef = doc(db, 'playerStats', pid);
        const snap = await tx.get(ref);
        const sSnap = await tx.get(sRef);
        const old = snap.data().rewardLedger || [];
        const bal = sharedBalance(sSnap.exists() ? sSnap.data().rewardEarned : 0, old);
        if (bal + pts < 0) throw new Error(`That would make the balance negative (current balance ${bal}).`);
        const ledger = [...old, { id: newLedgerId(), ts: ts(), type: 'adjust', points: pts, balanceAfter: bal + pts, by: S.user.uid, byName: myName(), note }];
        tx.update(ref, { rewardLedger: ledger });
      });
      await recomputeStats([pid]);
      toast('Reward points updated.');
    });
  });
}
function historyDialog(pid) {
  const p = playerById(pid);
  if (!p) return;
  const st = S.stats.get(pid) || {};
  const led = [...(p.rewardLedger || [])].sort((a, b) => toNum(b.ts) - toNum(a.ts));
  const label = { redeem: 'Redemption', 'redeem-reversal': 'Redemption undone', adjust: 'Adjustment', 'auction-bonus': 'Auction bonus', 'auction-bonus-refund': 'Bonus returned' };
  const row = (e) => `<li><span>${esc(e.note || label[e.type] || e.type)}<br><small class="muted">${e.ts ? new Date(e.ts).toLocaleDateString('en-IN') : ''} · ${esc(label[e.type] || e.type)}${e.byName ? ' · by ' + esc(e.byName) : ''}${e.balanceAfter !== undefined ? ' · balance ' + toNum(e.balanceAfter) : ''}</small></span><b class="${toNum(e.points) < 0 ? '' : 'green'}">${toNum(e.points) > 0 ? '+' : ''}${toNum(e.points)}</b></li>`;
  const mm = openModal(`<h3>${esc(p.name)} — points history</h3><p class="muted">One shared balance · earned in matches: <b>${toNum(st.rewardEarned)}</b> · Balance: <b class="green">${balanceOf(p)}</b></p>
    <h4 style="margin:12px 0 4px">Bonus, adjustments &amp; redemptions</h4>
    <ul class="ledger">${led.length ? led.map(row).join('') : '<li class="muted small">None yet.</li>'}</ul>
    <h4 style="margin:12px 0 4px">Earned in matches</h4>
    <ul class="ledger" id="matchEarn"><li class="muted small">Loading…</li></ul>
    <div class="modal-actions"><button class="btn primary" data-m="no">Close</button></div>`);
  mm.el.addEventListener('click', (e) => { if (e.target.closest('[data-m]')) mm.close(); });
  getDocs(query(collection(db, 'playerMatches'), where('playerId', '==', pid)))
    .then((snap) => {
      const rows = snap.docs.map((d) => d.data()).filter((r) => toNum(r.rewardPointsEarned) > 0).sort((a, b) => toNum(b.matchNumber) - toNum(a.matchNumber));
      const el = $('#matchEarn', mm.el);
      if (!el) return;
      el.innerHTML = rows.length
        ? rows.map((r) => `<li><span>Match #${esc(r.matchNumber)} — ${esc(r.teamName)}<br><small class="muted">${r.matchStatus === 'completed' ? 'match points' : 'will count when the match is completed'}${r.participation === 'not_played' ? ' · marked Not played' : ''}</small></span><b class="green">+${toNum(r.rewardPointsEarned)}</b></li>`).join('')
        : '<li class="muted small">No match points yet.</li>';
    })
    .catch((err) => { const el = $('#matchEarn', mm.el); if (el) el.innerHTML = `<li class="muted small">Could not load: ${esc(friendlyError(err))}</li>`; });
}

// ---------------- Manage Admins (Owner only) ----------------
function adminsView() {
  if (!S.isOwner) return '<div class="alert err">Only the Owner can open this section.</div>';
  const list = [...S.admins].sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0) || toNum(a.createdAt) - toNum(b.createdAt));
  const hasOwnerRow = list.some((a) => a.role === 'owner' || a.id === OWNER_UID);
  const form = S.adminForm
    ? `<form class="card glow form" data-form="create-admin" autocomplete="off" style="margin-bottom:16px"><h3>New admin</h3>
      <p class="small muted" style="margin-bottom:10px">The admin signs in on the admin page with this username and password. Share them privately. They can use every admin feature except Manage Admins.</p>
      <div class="grid-form three">
        ${field('Name (optional)', '<input name="displayName" maxlength="40" autocomplete="off" placeholder="e.g. Rahul">')}
        ${field('Username *', '<input name="username" required minlength="3" maxlength="24" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="e.g. rahul">', 'Letters, numbers, dot, dash, underscore. Cannot be changed later.')}
        ${field('Password *', '<input name="password" type="password" required minlength="8" maxlength="64" autocomplete="new-password">', 'At least 8 characters.')}
      </div>
      <div class="form-error" role="alert"></div>
      <div class="row-actions"><button class="btn primary" type="submit">Create admin</button><button type="button" class="btn ghost" data-act="admin-cancel">Cancel</button></div></form>`
    : '';
  const fmt = (ms) => (ms ? `${fmtDate(ms)} ${fmtTime(ms)}` : 'never');
  const rows = list.map((a) => {
    const owner = a.role === 'owner' || a.id === OWNER_UID;
    const status = owner ? '<span class="chip captain">Owner</span>' : a.active === true ? '<span class="chip completed">Active</span>' : '<span class="chip loss">Disabled</span>';
    const acts = owner ? '' : `<div class="acts">
        <button class="btn small ${a.active === true ? 'danger' : 'primary'}" data-act="admin-toggle" data-id="${esc(a.id)}">${a.active === true ? 'Disable' : 'Activate'}</button>
        <button class="btn small" data-act="admin-reset" data-id="${esc(a.id)}">New password</button>
        <button class="btn small ghost" data-act="admin-remove" data-id="${esc(a.id)}">Remove</button></div>`;
    return `<div class="arow"><div class="grow"><b>${esc(a.displayName || a.username || '—')}</b> ${status}
      <div class="small muted">Username: <code>${esc(a.username || '')}</code>${a.email ? ` · Email: <code>${esc(a.email)}</code>` : ''} · last sign-in: ${fmt(a.lastLoginAt)}${owner ? '' : ` · created ${a.createdAt ? fmtDate(a.createdAt) : '—'}`}</div></div>${acts}</div>`;
  }).join('');
  return `<div class="page-head"><h1>Manage Admins</h1><button class="btn primary" data-act="admin-new">+ New admin</button></div>
  <div class="alert ok"><b>Disable</b> cuts access immediately: the admin is signed out on every device and can no longer change any data or sign in until you activate them again. <b>Remove</b> deletes the account for good. Your Owner account can never be disabled or removed here.</div>
  ${form}
  ${hasOwnerRow ? '' : `<div class="arow"><div class="grow"><b>You</b> <span class="chip captain">Owner</span><div class="small muted">Owner account</div></div></div>`}
  ${rows || (hasOwnerRow ? '' : '')}
  ${list.filter((a) => a.role !== 'owner' && a.id !== OWNER_UID).length ? '' : '<div class="empty" style="margin-top:12px"><b>No other admins yet</b>Press “+ New admin” to create the first one.</div>'}`;
}
async function createAdminFromForm(form) {
  clearFail(form);
  const fd = new FormData(form);
  const username = String(fd.get('username') || '').trim().toLowerCase();
  const password = String(fd.get('password') || '');
  const displayName = String(fd.get('displayName') || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,23}$/.test(username)) return fail(form, 'Username: 3–24 characters, lowercase letters, numbers, dot, dash or underscore.');
  if (password.length < 8) return fail(form, 'Password must be at least 8 characters.');
  await callCreateAdmin({ username, password, displayName });
  S.adminForm = false;
  toast(`Admin “${username}” created. Share the username and password with them privately.`);
  scheduleRender(true);
}
async function toggleAdmin(id) {
  const a = S.admins.find((x) => x.id === id);
  if (!a || id === OWNER_UID) return;
  const disabling = a.active === true;
  const ok = await confirmDialog({
    title: disabling ? `Disable ${a.displayName || a.username}?` : `Activate ${a.displayName || a.username}?`,
    message: disabling ? 'They will be signed out on every device right away and cannot change anything or sign in until you activate them again.' : 'They will be able to sign in and use the admin panel again.',
    confirmText: disabling ? 'Disable' : 'Activate', danger: disabling,
  });
  if (!ok) return;
  await callSetAdminActive({ uid: id, active: !disabling });
  toast(disabling ? 'Admin disabled. Their sessions can no longer change data.' : 'Admin activated.');
}
function resetAdminDialog(id) {
  const a = S.admins.find((x) => x.id === id);
  if (!a || id === OWNER_UID) return;
  const mm = openModal(`<h3>New password — ${esc(a.displayName || a.username)}</h3><p class="muted">Their current sessions end and they must sign in with the new password.</p>
    <label class="field" style="margin-top:12px"><span>New password (min. 8 characters)</span><input id="newPw" type="password" autocomplete="new-password" maxlength="64"></label>
    <div class="form-error" id="pwErr"></div>
    <div class="modal-actions"><button class="btn ghost" data-m="no">Cancel</button><button class="btn primary" data-m="yes">Save password</button></div>`);
  mm.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    if (b.dataset.m === 'no') return mm.close();
    const pw = $('#newPw', mm.el).value;
    if (pw.length < 8) { $('#pwErr', mm.el).textContent = 'At least 8 characters.'; return; }
    mm.close();
    run(async () => { await callResetAdminPassword({ uid: id, password: pw }); toast('Password changed. Share it privately.'); });
  });
}
async function removeAdminAccount(id) {
  const a = S.admins.find((x) => x.id === id);
  if (!a || id === OWNER_UID) return;
  const ok = await confirmDialog({ title: `Remove ${a.displayName || a.username}?`, message: 'The account is deleted permanently and signed out everywhere. League data they entered stays untouched.', confirmText: 'Remove admin', danger: true });
  if (!ok) return;
  await callRemoveAdmin({ uid: id });
  toast('Admin removed.');
}

// ---------------- Finance ----------------
function financeView() {
  const sym = cur();
  const list = sortedMatches();
  const tot = list.reduce((a, m) => {
    const f = financeOf(m);
    a.collected += f.collected; a.expenses += f.expenses; a.expected += f.expected; a.net += f.net;
    return a;
  }, { collected: 0, expenses: 0, expected: 0, net: 0 });
  return `<div class="page-head"><h1>Fees &amp; Expenses</h1></div>
  <div class="sum-grid"><div><b>${money(tot.expected, sym)}</b><span>Expected</span></div><div><b>${money(tot.collected, sym)}</b><span>Collected</span></div><div><b>${money(tot.expenses, sym)}</b><span>Expenses</span></div><div><b class="${tot.net < 0 ? 'neg' : ''}">${money(tot.net, sym)}</b><span>Net</span></div></div>
  ${list.length ? `<div class="card table-wrap"><table class="ftable"><thead><tr><th>Match</th><th>Players</th><th>Paid</th><th>Collected</th><th>Expenses</th><th>Net</th><th></th></tr></thead><tbody>
  ${list.map((m) => { const f = financeOf(m); return `<tr><td>#${esc(m.number)}<br><small class="muted">${m.dateMs ? fmtDate(m.dateMs) : 'Date not recorded'}</small></td><td>${f.players}</td><td>${f.paidCount}/${f.players}</td><td>${money(f.collected, sym)}</td><td>${money(f.expenses, sym)}</td><td style="color:${f.net < 0 ? '#ff8793' : 'var(--green)'}">${money(f.net, sym)}</td><td><button class="btn small" data-go="matches" data-id="${esc(m.id)}">Open</button></td></tr>`; }).join('')}
  </tbody></table></div>` : '<div class="empty"><b>No matches yet</b>Fees appear per match.</div>'}`;
}

// ---------------- Announcements ----------------
const CATEGORIES = ['Announcement', 'Match update', 'Important notice'];
function announcementsView() {
  const f = S.annForm;
  const a = f && f.id ? S.news.find((n) => n.id === f.id) : null;
  const form = f
    ? `<form class="card glow form" data-form="announcement" style="margin-bottom:16px"><h3>${a ? 'Edit announcement' : 'New announcement'}</h3>
      ${field('Title *', `<input name="title" required maxlength="90" value="${esc(a ? a.title : '')}">`)}
      ${field('Category', `<select name="category">${CATEGORIES.map((c) => `<option ${a && a.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select>`)}
      ${field('Message *', `<textarea name="message" required maxlength="2000">${esc(a ? a.message : '')}</textarea>`)}
      <div class="form-error" role="alert"></div>
      <div class="row-actions"><button class="btn primary" type="submit">${a ? 'Save' : 'Publish'}</button><button type="button" class="btn ghost" data-act="ann-cancel">Cancel</button></div></form>`
    : '';
  return `<div class="page-head"><h1>Announcements</h1><button class="btn primary" data-act="ann-new">+ New announcement</button></div>${form}
  ${S.news.length ? S.news.map((n) => `<div class="arow"><div class="grow"><span class="chip">${esc(n.category || 'Announcement')}</span> <b>${esc(n.title)}</b><div class="small muted">${fmtDate(n.dateMs)} · ${fmtTime(n.dateMs)}</div><div class="small" style="margin-top:4px">${esc(String(n.message).slice(0, 140))}${String(n.message).length > 140 ? '…' : ''}</div></div>
    <div class="acts"><button class="btn small" data-act="ann-edit" data-id="${esc(n.id)}">Edit</button><button class="btn small danger" data-act="ann-del" data-id="${esc(n.id)}">Delete</button></div></div>`).join('') : '<div class="empty"><b>No announcements</b>Post a notice for players.</div>'}`;
}
async function saveAnnouncement(form) {
  clearFail(form);
  const fd = new FormData(form);
  const title = String(fd.get('title') || '').trim();
  const message = String(fd.get('message') || '').trim();
  const category = CATEGORIES.includes(fd.get('category')) ? fd.get('category') : CATEGORIES[0];
  if (title.length < 3) return fail(form, 'Title must be at least 3 characters.');
  if (message.length < 3) return fail(form, 'Please write a message.');
  const f = S.annForm;
  if (f.id) await updateDoc(doc(db, 'announcements', f.id), { title, message, category, updatedAt: ts() });
  else await addDoc(collection(db, 'announcements'), { title, message, category, dateMs: ts() });
  S.annForm = null;
  toast(f.id ? 'Announcement updated.' : 'Announcement published.');
  scheduleRender(true);
}

// ---------------- History & backup ----------------
function historyView() {
  const list = sortedMatches();
  return `<div class="page-head"><h1>History &amp; Backup</h1></div>
  <div class="card" style="margin-bottom:16px"><h3>Backup &amp; maintenance</h3>
    <p class="small muted">Download all league data as a JSON file you can keep safe. Rebuilding statistics recalculates every player's numbers from the match records (safe to run any time).</p>
    <div class="row-actions"><button class="btn primary" data-act="backup">⬇ Download full backup</button><button class="btn" data-act="rebuild">Rebuild all player stats</button></div></div>
  <h2 class="sec-title">All matches &amp; auctions</h2>
  ${list.length ? list.map((m) => `<details class="card auc-match" style="margin-bottom:10px"><summary><div><h3 style="font-size:22px">Match #${esc(m.number)}</h3><span class="small muted">${m.dateMs ? fmtDate(m.dateMs) : 'Date not recorded'} · ${scoreTxt(m)}</span></div><div>${chip(m.status)} <button class="btn small" data-go="matches" data-id="${esc(m.id)}">Manage</button></div></summary>
    ${(m.teams || []).some((t) => t.captainId) ? auctionHtml(m) : '<p class="muted small">No auction recorded.</p>'}</details>`).join('') : '<div class="empty"><b>No history yet</b></div>'}`;
}
async function backup(btn) {
  const names = ['settings', 'players', 'matches', 'playerMatches', 'playerStats', 'announcements'];
  const out = { app: LEAGUE_NAME, exportedAt: new Date().toISOString(), collections: {} };
  for (const n of names) {
    const snap = await getDocs(collection(db, n));
    out.collections[n] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `vip-football-league-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Backup downloaded.');
}
async function rebuildAll() {
  const ok = await confirmDialog({ title: 'Rebuild all player stats?', message: 'Every player’s statistics are recalculated from the saved match records. Nothing in matches or auctions changes.', confirmText: 'Rebuild' });
  if (!ok) return;
  const all = await getDocs(collection(db, 'playerMatches'));
  const byPlayer = new Map();
  all.docs.forEach((d) => { const x = d.data(); if (!byPlayer.has(x.playerId)) byPlayer.set(x.playerId, []); byPlayer.get(x.playerId).push(x); });
  const ids = new Set([...S.players.map((p) => p.id), ...byPlayer.keys(), ...S.stats.keys()]);
  const arr = [...ids];
  for (let i = 0; i < arr.length; i += 400) {
    const batch = writeBatch(db);
    arr.slice(i, i + 400).forEach((pid) => {
      const p = playerById(pid);
      const agg = aggregatePlayer(byPlayer.get(pid) || [], p ? p.rewardLedger || [] : [], p ? p.statAdjust || {} : {});
      batch.set(doc(db, 'playerStats', pid), { ...agg, playerId: pid, updatedAt: ts() });
    });
    await batch.commit();
  }
  toast(`Stats rebuilt for ${arr.length} players.`);
}

// ---------------- Settings ----------------
function settingsView() {
  const s = S.settings;
  const logo = S.logoDraft !== null ? S.logoDraft : s.logo;
  return `<div class="page-head"><h1>Settings</h1></div>
  <form class="card form" data-form="settings">
    <h3>League</h3>
    <p class="small muted" style="margin-bottom:10px">League name is fixed: <b>${LEAGUE_NAME}</b>.</p>
    <div class="photo-row"><div id="logoPreview"><img class="avatar" style="border-radius:12px;object-fit:contain" src="${esc(safeImg(logo) || 'assets/logo.svg')}" alt=""></div>
      <div><label class="btn small">Upload logo<input type="file" id="logoInput" accept="image/*"></label> <button type="button" class="btn small ghost" data-act="logo-clear">Use default logo</button></div></div>
    ${field('Tagline (home page)', `<input name="tagline" maxlength="90" value="${esc(s.tagline)}">`)}

    <h3 style="margin-top:20px">Auction rules <span class="small muted">(apply to NEW matches only)</span></h3>
    <div class="grid-form three">
      ${field('Starting points per captain', `<input name="startingPoints" type="number" min="0" step="1" required value="${esc(s.auction.startingPoints)}">`)}
      ${field('Maximum usable budget', `<input name="maxBudget" type="number" min="0" step="1" required value="${esc(s.auction.maxBudget)}">`)}
      ${field('Bonus suggestion mode', `<select name="bonusMode"><option value="manual" ${s.auction.bonusMode === 'manual' ? 'selected' : ''}>Manual (I type the bonus)</option><option value="lastPurchase" ${s.auction.bonusMode === 'lastPurchase' ? 'selected' : ''}>Suggest from last purchase price</option></select>`)}
      ${field('Suggestion factor', `<input name="bonusFactor" type="number" min="0" step="0.05" value="${esc(s.auction.bonusFactor)}">`, 'Suggested bonus = last purchase price × factor. You can always change it.')}
    </div>

    <h3 style="margin-top:20px">Points (Auction Points = Reward Points)</h3>
    <div class="grid-form three">${field('Currency symbol', `<input name="currency" maxlength="3" required value="${esc(s.reward.currencySymbol)}">`)}</div>
    <p class="small muted" style="margin:4px 0 8px">Money Converter (fixed — shared points balance → entry-fee discount):</p>
    <div style="margin-bottom:6px">${FIXED_TIERS.map((t) => `<span class="chip" style="margin:0 6px 6px 0">${t.points} points = ${money(t.discount, s.reward.currencySymbol)} OFF</span>`).join('')}</div>
    <p class="small muted" style="margin:16px 0 8px">Points added to the shared balance when you press “Fill reward points from rules” in a match (0 = not used yet). Purchased players marked Not played get nothing:</p>
    <div class="grid-form three">
      ${['participation', 'win', 'draw', 'goal', 'captain'].map((k) => field({ participation: 'Per match played', win: 'For a win', draw: 'For a draw', goal: 'Per goal', captain: 'For being captain' }[k], `<input name="earn_${k}" type="number" min="0" step="1" value="${esc(toNum(s.reward.earn[k]))}">`)).join('')}
    </div>
    <div class="form-error" role="alert"></div>
    <div class="row-actions"><button class="btn primary" type="submit">Save settings</button></div>
  </form>

  <div class="card" style="margin-top:16px"><h3>My admin account</h3>
    <p class="small">Signed in as <b>${esc(myName())}</b>${S.me && S.me.username ? ` (<code>${esc(S.me.username)}</code>)` : ''} · role: <b class="green">${S.isOwner ? 'Owner' : 'Admin'}</b></p>
    <p class="small muted" style="margin-top:8px">${S.isOwner ? 'You can create, disable and remove admins in <a class="green" data-go="admins" href="#">Manage Admins</a>.' : 'The Owner manages admin accounts. If you lose access or forget your password, ask the Owner.'}</p>`;
}
async function saveSettings(form) {
  clearFail(form);
  const fd = new FormData(form);
  const startingPoints = Number(fd.get('startingPoints'));
  const maxBudget = Number(fd.get('maxBudget'));
  const bonusFactor = Number(fd.get('bonusFactor'));
  const bonusMode = fd.get('bonusMode') === 'lastPurchase' ? 'lastPurchase' : 'manual';
  const currency = String(fd.get('currency') || '').trim();
  if (!Number.isFinite(startingPoints) || startingPoints < 0) return fail(form, 'Starting points must be 0 or more.');
  if (!Number.isFinite(maxBudget) || maxBudget < 0) return fail(form, 'Maximum budget must be 0 or more.');
  if (!Number.isFinite(bonusFactor) || bonusFactor < 0) return fail(form, 'Suggestion factor must be 0 or more.');
  if (!currency) return fail(form, 'Enter a currency symbol.');
  const earn = {};
  for (const k of ['participation', 'win', 'draw', 'goal', 'captain']) {
    const v = Number(fd.get(`earn_${k}`));
    if (!Number.isFinite(v) || v < 0) return fail(form, 'Reward earning values must be 0 or more.');
    earn[k] = v;
  }
  const next = {
    tagline: String(fd.get('tagline') || '').trim(),
    logo: S.logoDraft !== null ? S.logoDraft : S.settings.logo,
    auction: { startingPoints, maxBudget, bonusMode, bonusFactor },
    reward: { currencySymbol: currency, tiers: FIXED_TIERS.map((t) => ({ ...t })), earn },
  };
  await setDoc(doc(db, 'settings', 'league'), settingsDoc(next));
  S.logoDraft = null;
  toast('Settings saved.');
}

// ---------------------------------------------------------------------
// Initial data + manual stat corrections
// ---------------------------------------------------------------------
async function loadInitialData() {
  if (S.players.length || S.matches.length) { toast('The league already has data. Initial data can only be loaded into an empty league.', 'err'); return; }
  const ok = await confirmDialog({
    title: 'Load initial league data?',
    message: 'This adds your 20 registered players and the historical Match 1 (both teams, every auction purchase, the captains and the goals). Match 1’s date, final score and winner stay “not recorded” because they were not supplied. You can edit everything afterwards.',
    confirmText: 'Load data',
  });
  if (!ok) return;
  const seed = buildSeed({ maxBudget: toNum(S.settings.auction.maxBudget, 150) });
  const batch = writeBatch(db);
  seed.players.forEach((p) => batch.set(doc(db, 'players', p.id), p.data));
  batch.set(doc(db, 'matches', seed.match.id), seed.match.data);
  seed.pms.forEach((x) => batch.set(doc(db, 'playerMatches', x.id), x.data));
  seed.stats.forEach((x) => batch.set(doc(db, 'playerStats', x.id), x.data));
  await batch.commit();
  toast('Initial data loaded: 20 players and Match 1.');
  go('players');
}

async function openStatsDialog(pid) {
  const p = playerById(pid);
  if (!p) return;
  const pms = await getDocs(query(collection(db, 'playerMatches'), where('playerId', '==', pid)));
  const base = aggregatePlayer(pms.docs.map((d) => d.data()), [], {});
  const adj = p.statAdjust || {};
  const bal = base.rewardEarned + (p.rewardLedger || []).reduce((s, e) => s + toNum(e.points), 0);
  const labels = { matches: 'Matches played', wins: 'Wins', losses: 'Losses', draws: 'Draws', normalGoals: 'Normal goals', penaltyGoals: 'Penalty goals' };
  const val = (k) => Math.max(0, base[k] + toNum(adj[k]));
  const rowHtml = (k) => `<tr><td>${labels[k]}</td><td class="muted">${base[k]}</td><td><input class="inline-input" type="number" min="0" step="1" inputmode="numeric" data-k="${k}" value="${val(k)}"></td></tr>`;
  const mm = openModal(`<h3>Edit stats — ${esc(p.name)}</h3>
    <p class="small muted">Stats are normally counted from match records (left column). Type the numbers you want to show; the difference is saved as a correction and stays visible. Total goals = normal + penalty (automatic).</p>
    <div class="table-wrap"><table class="ftable"><thead><tr><th>Stat</th><th>From matches</th><th>Show as</th></tr></thead><tbody>
      ${Object.keys(labels).map(rowHtml).join('')}
      <tr><td>Total goals</td><td class="muted">${base.goals}</td><td><b id="totGoals" class="green">${val('normalGoals') + val('penaltyGoals')}</b></td></tr>
      <tr><td>Reward points</td><td class="muted">${bal}</td><td><input class="inline-input" type="number" step="1" inputmode="numeric" id="rewardVal" value="${bal}"></td></tr>
    </tbody></table></div>
    <div class="form-error" id="statsErr"></div>
    <div class="modal-actions"><button class="btn ghost" data-m="reset">Reset to match records</button><button class="btn ghost" data-m="no">Cancel</button><button class="btn primary" data-m="yes">Save</button></div>`);
  const inputs = () => $$('input[data-k]', mm.el);
  const refreshTotal = () => {
    const g = (k) => Number($(`input[data-k="${k}"]`, mm.el).value) || 0;
    $('#totGoals', mm.el).textContent = g('normalGoals') + g('penaltyGoals');
  };
  mm.el.addEventListener('input', refreshTotal);
  mm.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    if (b.dataset.m === 'no') return mm.close();
    if (b.dataset.m === 'reset') { inputs().forEach((i) => { i.value = base[i.dataset.k]; }); $('#rewardVal', mm.el).value = bal; refreshTotal(); return; }
    const err = $('#statsErr', mm.el);
    const want = {};
    for (const i of inputs()) {
      const v = Number(i.value);
      if (!Number.isInteger(v) || v < 0) { err.textContent = 'Every stat must be a whole number (0 or more).'; return; }
      want[i.dataset.k] = v;
    }
    if (want.wins + want.losses + want.draws > want.matches) { err.textContent = 'Wins + losses + draws cannot be more than matches played.'; return; }
    const reward = Number($('#rewardVal', mm.el).value);
    if (!Number.isInteger(reward) || reward < 0) { err.textContent = 'Reward points must be a whole number (0 or more).'; return; }
    const newAdj = {};
    ADJUST_KEYS.forEach((k) => { const d = want[k] - base[k]; if (d) newAdj[k] = d; });
    const diff = reward - bal;
    mm.close();
    run(async () => {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, 'players', pid);
        const snap = await tx.get(ref);
        const patch = { statAdjust: newAdj };
        if (diff) patch.rewardLedger = [...(snap.data().rewardLedger || []), { id: `${ts()}`, ts: ts(), type: 'adjust', points: diff, note: 'Manual correction (Edit stats)' }];
        tx.update(ref, patch);
      });
      await recomputeStats([pid]);
      toast('Player stats updated.');
    });
  });
}

// ---------------------------------------------------------------------
// Event delegation
// ---------------------------------------------------------------------
const content = $('#content');

document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]');
  if (g && S.user) { e.preventDefault(); go(g.dataset.go, g.dataset.id || null); return; }
  const j = e.target.closest('[data-jump]');
  if (j) { e.preventDefault(); const t = document.getElementById(j.dataset.jump); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
});

content.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const act = el.dataset.act;
  const m = S.matchId ? matchById(S.matchId) : null;
  const R = (fn) => run(fn, el);
  switch (act) {
    // dashboard quick actions
    case 'quick-match': S.newMatchForm = true; go('matches'); S.newMatchForm = true; scheduleRender(true); break;
    case 'quick-player': S.playerForm = { id: null, photo: '' }; go('players'); S.playerForm = { id: null, photo: '' }; scheduleRender(true); break;
    case 'quick-news': S.annForm = { id: null }; go('announcements'); S.annForm = { id: null }; scheduleRender(true); break;
    // players
    case 'seed': R(loadInitialData); break;
    case 'player-stats': R(() => openStatsDialog(el.dataset.id)); break;
    case 'score-confirm': if (m) R(() => confirmScore(m)); break;
    case 'player-new': S.playerForm = { id: null, photo: '' }; scheduleRender(true); break;
    case 'player-cancel': S.playerForm = null; scheduleRender(true); break;
    case 'player-edit': { const p = playerById(el.dataset.id); if (p) { S.playerForm = { id: p.id, photo: p.photo || '' }; scheduleRender(true); window.scrollTo(0, 0); } break; }
    case 'player-filter': S.playerFilter = el.dataset.k; scheduleRender(true); break;
    case 'photo-clear': if (S.playerForm) { S.playerForm.photo = ''; $('#photoPreview').innerHTML = photoPreviewHtml('', ''); } break;
    case 'player-toggle': R(async () => {
      const p = playerById(el.dataset.id);
      if (!p) return;
      if (p.active === false) { await updateDoc(doc(db, 'players', p.id), { active: true }); toast(`${p.name} reactivated.`); return; }
      const ok = await confirmDialog({ title: `Deactivate ${p.name}?`, message: 'They will no longer appear in new auctions. Their history, stats and past matches stay untouched. You can reactivate them any time.', confirmText: 'Deactivate', danger: true });
      if (ok) { await updateDoc(doc(db, 'players', p.id), { active: false, deactivatedAt: ts() }); toast(`${p.name} deactivated.`); }
    }); break;
    // matches
    case 'newmatch': S.newMatchForm = true; scheduleRender(true); break;
    case 'newmatch-cancel': S.newMatchForm = false; scheduleRender(true); break;
    case 'match-live': if (m) R(() => changeStatus(m, 'live')); break;
    case 'match-reopen': if (m) R(() => changeStatus(m, 'reopen')); break;
    case 'match-delete': if (m) R(() => deleteMatch(m)); break;
    case 'use-suggest': { const i = el.dataset.idx; const inp = $(`[name="bonus${i}"]`); if (inp) inp.value = el.dataset.val; break; }
    case 'participation': if (m) R(() => setParticipation(m, el.dataset.pid, el.dataset.status)); break;
    case 'pick-undo': if (m) R(() => undoPick(m, Number(el.dataset.team), el.dataset.player)); break;
    case 'auction-complete': if (m) R(() => setAuctionStatus(m, 'completed')); break;
    case 'auction-reopen': if (m) R(() => setAuctionStatus(m, 'inProgress')); break;
    case 'pool-all': $$('input[name="pool"]', el.closest('form')).forEach((i) => { if (!i.disabled) i.checked = true; }); break;
    case 'pool-none': $$('input[name="pool"]', el.closest('form')).forEach((i) => { if (!i.disabled) i.checked = false; }); break;
    case 'score': if (m) R(() => changeScore(m, Number(el.dataset.idx), Number(el.dataset.d))); break;
    case 'apply-rules': if (m) applyRules(el.closest('form'), m); break;
    case 'resync': if (m) R(async () => { const d = matchById(m.id); await afterRosterChange(m.id, d); toast('Player records repaired.'); }); break;
    case 'fees-all': if (m) R(() => markAllPaid(m)); break;
    case 'expense-del': if (m) R(() => deleteExpense(m, el.dataset.id)); break;
    case 'redeem': if (m) redeemDialog(m, el.dataset.pid); break;
    case 'redeem-undo': if (m) R(() => undoRedeem(m, el.dataset.pid)); break;
    // manage admins (Owner only; the Cloud Functions enforce it again on the server)
    case 'admin-new': if (S.isOwner) { S.adminForm = true; scheduleRender(true); } break;
    case 'admin-cancel': S.adminForm = false; scheduleRender(true); break;
    case 'admin-toggle': if (S.isOwner) R(() => toggleAdmin(el.dataset.id)); break;
    case 'admin-reset': if (S.isOwner) resetAdminDialog(el.dataset.id); break;
    case 'admin-remove': if (S.isOwner) R(() => removeAdminAccount(el.dataset.id)); break;
    // rewards
    case 'reward-adjust': adjustDialog(el.dataset.id); break;
    case 'reward-history': historyDialog(el.dataset.id); break;
    // announcements
    case 'ann-new': S.annForm = { id: null }; scheduleRender(true); break;
    case 'ann-edit': S.annForm = { id: el.dataset.id }; scheduleRender(true); window.scrollTo(0, 0); break;
    case 'ann-cancel': S.annForm = null; scheduleRender(true); break;
    case 'ann-del': R(async () => {
      const n = S.news.find((x) => x.id === el.dataset.id);
      if (!n) return;
      const ok = await confirmDialog({ title: 'Delete announcement?', message: `“${n.title}” will be removed from the website.`, confirmText: 'Delete', danger: true });
      if (ok) { await deleteDoc(doc(db, 'announcements', n.id)); toast('Announcement deleted.'); }
    }); break;
    // history / settings
    case 'backup': R(() => backup(el)); break;
    case 'rebuild': R(rebuildAll); break;
    case 'logo-clear': S.logoDraft = ''; $('#logoPreview').innerHTML = '<img class="avatar" style="border-radius:12px;object-fit:contain" src="assets/logo.svg" alt="">'; break;
    default: break;
  }
});

content.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const m = S.matchId ? matchById(S.matchId) : null;
  const btn = $('button[type="submit"]', form);
  const map = {
    player: () => savePlayer(form),
    'new-match': () => createMatch(form),
    'match-details': () => m && saveMatchDetails(form, m),
    captains: () => m && saveCaptains(form, m),
    pick: () => m && recordPick(form, m),
    pool: () => m && savePool(form, m),
    declare: () => m && declareResult(form, m),
    pstats: () => m && savePlayerStats(form, m),
    expense: () => m && addExpense(form, m),
    announcement: () => saveAnnouncement(form),
    settings: () => saveSettings(form),
    'create-admin': () => createAdminFromForm(form),
  };
  const fn = map[form.dataset.form];
  if (fn) run(fn, btn);
});

content.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'photoInput' && S.playerForm) {
    run(async () => {
      S.playerForm.photo = await imageToDataUrl(t.files[0], { max: 320, square: true, type: 'image/jpeg' });
      $('#photoPreview').innerHTML = photoPreviewHtml(S.playerForm.photo, '');
    });
  } else if (t.id === 'logoInput') {
    run(async () => {
      S.logoDraft = await imageToDataUrl(t.files[0], { max: 256, square: false, type: 'image/png' });
      $('#logoPreview').innerHTML = `<img class="avatar" style="border-radius:12px;object-fit:contain" src="${esc(S.logoDraft)}" alt="">`;
    });
  } else if (t.dataset && t.dataset.capSelect !== undefined) {
    const i = Number(t.dataset.capSelect);
    const m = matchById(S.matchId);
    const hint = $(`#hint${i}`);
    if (m && hint) {
      hint.innerHTML = captainHint(m, i, t.value);
      if (S.settings.auction.bonusMode === 'lastPurchase' && t.value) {
        const lp = lastPurchase(t.value, S.matches, m.id);
        const inp = $(`[name="bonus${i}"]`);
        if (inp) inp.value = suggestBonus(lp, S.settings.auction.bonusFactor);
      }
    }
  } else if (t.dataset && t.dataset.act === 'fee-status') {
    const m = matchById(S.matchId);
    if (m) run(() => setFeeStatus(m, t.dataset.pid, t.value));
  }
});

content.addEventListener('input', (e) => {
  if (e.target.id === 'adminPlayerSearch') {
    S.playerSearch = e.target.value;
    $('#playerList').innerHTML = playerListHtml();
  }
});

// ---------------------------------------------------------------------
// Start: keep admins signed in across browser restarts (until THEY press Sign out
// or the Owner disables them)
// ---------------------------------------------------------------------
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
      if (S.logoutMsg) { $('#loginError').textContent = S.logoutMsg; S.logoutMsg = ''; }
    }
  });
})();
