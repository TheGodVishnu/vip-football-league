// =====================================================================
// VIP FOOTBALL LEAGUE — shared logic (no Firebase here, only pure functions)
// Used by both the public site (app.js) and the admin panel (admin.js).
// =====================================================================

export const LEAGUE_NAME = 'VIP FOOTBALL LEAGUE';
export const TEAM_COLORS = ['#3da9ff', '#ff3b4e', '#00ff6a', '#ff9f1c'];
export const POSITIONS = ['Goalkeeper', 'Defender', 'Midfielder', 'Forward', 'All-rounder'];

// Provisional table given by the league owner. Editable in Admin -> Settings.
export const DEFAULT_TIERS = [
  { points: 50, discount: 2 },
  { points: 100, discount: 4 },
  { points: 150, discount: 6 },
  { points: 200, discount: 8 },
  { points: 250, discount: 10 },
];

export const DEFAULT_SETTINGS = {
  leagueName: LEAGUE_NAME,
  tagline: 'Fresh auction. New captains. Every match.',
  logo: '',
  auction: { startingPoints: 100, maxBudget: 150, bonusMode: 'manual', bonusFactor: 1 },
  reward: {
    currencySymbol: '₹',
    tiers: DEFAULT_TIERS,
    // Earning rules are NOT finalised, so they start at 0 (admin enters points manually).
    earn: { participation: 0, win: 0, draw: 0, goal: 0, captain: 0 },
  },
};

// ---------- small helpers ----------
export const toNum = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
export const nonNeg = (v) => Math.max(0, toNum(v, 0));

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function escMultiline(s) {
  return esc(s).replace(/\n/g, '<br>');
}
// Only allow real image data / https images in <img src>
export function safeImg(u) {
  return typeof u === 'string' && /^(data:image\/(png|jpe?g|webp|gif);base64,|https:\/\/)/i.test(u) ? u : '';
}
export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
export function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
export function fmtShortDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
export function fmtTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
}
export function toLocalInput(ms) {
  const d = new Date(ms || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function money(n, symbol = '₹') {
  const v = toNum(n);
  return `${v < 0 ? '-' : ''}${symbol}${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

// ---------- settings ----------
export function mergeSettings(stored) {
  const s = stored || {};
  const tiersIn = s.reward && Array.isArray(s.reward.tiers) ? s.reward.tiers : null;
  const tiers = (tiersIn || DEFAULT_TIERS)
    .map((t) => ({ points: nonNeg(t.points), discount: nonNeg(t.discount) }))
    .filter((t) => t.points > 0)
    .sort((a, b) => a.points - b.points);
  return {
    leagueName: LEAGUE_NAME, // fixed on purpose
    tagline: typeof s.tagline === 'string' ? s.tagline : DEFAULT_SETTINGS.tagline,
    logo: typeof s.logo === 'string' ? s.logo : '',
    auction: { ...DEFAULT_SETTINGS.auction, ...(s.auction || {}) },
    reward: {
      currencySymbol: (s.reward && s.reward.currencySymbol) || '₹',
      tiers,
      earn: { ...DEFAULT_SETTINGS.reward.earn, ...((s.reward && s.reward.earn) || {}) },
    },
  };
}

// ---------- AUCTION POINT MATHS (exactly the formulas from the brief) ----------
//   totalBeforeCap  = startingPoints + bonusPoints
//   usablePoints    = Math.min(totalBeforeCap, maxBudget)      (maxBudget = 150 by default)
//   excessPoints    = Math.max(0, totalBeforeCap - maxBudget)
//   remainingPoints = usablePoints - spentPoints
export function calcBudget({ startingPoints, bonusPoints, spentPoints = 0 }, maxBudget = 150) {
  const sp = nonNeg(startingPoints);
  const bp = nonNeg(bonusPoints);
  const spent = nonNeg(spentPoints);
  const cap = nonNeg(maxBudget);
  const totalBeforeCap = sp + bp;
  const usablePoints = Math.min(totalBeforeCap, cap);
  const excessPoints = Math.max(0, totalBeforeCap - cap);
  const remainingPoints = usablePoints - spent;
  return { startingPoints: sp, bonusPoints: bp, maxBudget: cap, totalBeforeCap, usablePoints, excessPoints, spentPoints: spent, remainingPoints };
}

export function teamSpent(team) {
  return (team.picks || []).reduce((s, p) => s + nonNeg(p.points), 0);
}

// Re-calculates every budget field of a team from its picks. Never trust stored totals.
export function recalcTeam(team, maxBudget) {
  return {
    ...team,
    ...calcBudget({ startingPoints: team.startingPoints, bonusPoints: team.bonusPoints, spentPoints: teamSpent(team) }, maxBudget),
  };
}

export function newTeam(index, name, auctionSettings) {
  const base = recalcTeam(
    {
      name: name || `Team ${String.fromCharCode(65 + index)}`,
      color: TEAM_COLORS[index % TEAM_COLORS.length],
      captainId: null,
      captainName: '',
      viceCaptainId: null,
      viceCaptainName: '',
      startingPoints: nonNeg(auctionSettings.startingPoints),
      bonusPoints: 0,
      picks: [],
    },
    auctionSettings.maxBudget
  );
  return base;
}

// Most recent auction purchase price of a player (used to SUGGEST a captain bonus).
export function lastPurchase(playerId, matches, excludeMatchId) {
  const sorted = [...matches].sort((a, b) => toNum(b.number) - toNum(a.number));
  for (const m of sorted) {
    if (m.id === excludeMatchId) continue;
    for (const t of m.teams || []) {
      const pk = (t.picks || []).find((p) => p.playerId === playerId);
      if (pk) return { points: nonNeg(pk.points), matchNumber: m.number };
    }
  }
  return null;
}
export function suggestBonus(lp, factor) {
  return lp ? Math.round(lp.points * toNum(factor, 1)) : 0;
}

// ---------- roster / results ----------
export function buildRoster(m) {
  const out = [];
  (m.teams || []).forEach((t, i) => {
    if (t.captainId) out.push({ playerId: t.captainId, playerName: t.captainName || '', teamIndex: i, teamName: t.name, isCaptain: true, isVice: false, auctionPoints: 0 });
    (t.picks || []).forEach((p) =>
      out.push({ playerId: p.playerId, playerName: p.playerName, teamIndex: i, teamName: t.name, isCaptain: false, isVice: !!t.viceCaptainId && t.viceCaptainId === p.playerId, auctionPoints: nonNeg(p.points) })
    );
  });
  return out;
}
export function resultFor(m, teamIndex) {
  if (m.status !== 'completed' || !m.result) return null;
  if (m.result.outcome === 'draw') return 'draw';
  return m.result.winnerIndex === teamIndex ? 'win' : 'loss';
}
export function defaultOutcome(scores) {
  const arr = (scores || []).map((s) => toNum(s));
  if (!arr.length) return { outcome: 'draw', winnerIndex: null };
  const max = Math.max(...arr);
  const tops = arr.map((s, i) => (s === max ? i : -1)).filter((i) => i >= 0);
  return tops.length === 1 ? { outcome: 'win', winnerIndex: tops[0] } : { outcome: 'draw', winnerIndex: null };
}

// ---------- statistics ----------
// Stats are ALWAYS rebuilt from scratch from playerMatches (+ reward ledger),
// so editing a result can never double-count anything.
export function emptyStats() {
  return {
    matches: 0, wins: 0, losses: 0, draws: 0, goals: 0, normalGoals: 0, penaltyGoals: 0, rewardEarned: 0, captainCount: 0,
    picksCount: 0, auctionSpentTotal: 0, highestPrice: 0, rewardLedgerTotal: 0, rewardRedeemed: 0,
    rewardBalance: 0, winRate: 0, hasAdjust: false, computed: null,
  };
}
// Fields the admin may correct by hand. They are stored as OFFSETS (desired - computed),
// so the numbers still follow the match records if those change later.
export const ADJUST_KEYS = ['matches', 'wins', 'losses', 'draws', 'normalGoals', 'penaltyGoals'];
export function splitGoals(p) {
  const pen = nonNeg(p.penaltyGoals);
  const normal = p.normalGoals !== undefined && p.normalGoals !== null ? nonNeg(p.normalGoals) : Math.max(0, nonNeg(p.goals) - pen);
  return { normal, pen, total: normal + pen };
}
export function aggregatePlayer(pms, ledger = [], adjust = {}) {
  const a = emptyStats();
  for (const p of pms) {
    if (p.matchStatus !== 'completed') continue; // only finished matches count
    a.matches++;
    if (p.result === 'win') a.wins++;
    else if (p.result === 'loss') a.losses++;
    else if (p.result === 'draw') a.draws++;
    const g = splitGoals(p);
    a.normalGoals += g.normal;
    a.penaltyGoals += g.pen;
    a.rewardEarned += nonNeg(p.rewardPointsEarned);
    if (p.isCaptain) a.captainCount++;
    else {
      a.picksCount++;
      a.auctionSpentTotal += nonNeg(p.auctionPoints);
      a.highestPrice = Math.max(a.highestPrice, nonNeg(p.auctionPoints));
    }
  }
  a.computed = {};
  ADJUST_KEYS.forEach((k) => { a.computed[k] = a[k]; });
  const adj = adjust || {};
  ADJUST_KEYS.forEach((k) => {
    const d = toNum(adj[k]);
    if (d) a.hasAdjust = true;
    a[k] = Math.max(0, a[k] + d);
  });
  a.goals = a.normalGoals + a.penaltyGoals;
  a.rewardLedgerTotal = ledger.reduce((s, e) => s + toNum(e.points), 0);
  a.rewardRedeemed = ledger.filter((e) => e.type === 'redeem' || e.type === 'redeem-reversal').reduce((s, e) => s - toNum(e.points), 0);
  a.rewardBalance = a.rewardEarned + a.rewardLedgerTotal;
  a.winRate = a.matches ? Math.round((a.wins / a.matches) * 100) : 0;
  return a;
}

export const SORT_OPTIONS = [
  { key: 'rewardBalance', label: 'Reward Points' },
  { key: 'wins', label: 'Wins' },
  { key: 'goals', label: 'Goals' },
  { key: 'matches', label: 'Matches' },
];
// rows: [{ p: player, s: stats }]  -> sorted copy with .rank (ties share a rank)
export function rankRows(rows, key) {
  const sorted = [...rows].sort(
    (a, b) =>
      toNum(b.s[key]) - toNum(a.s[key]) ||
      b.s.wins - a.s.wins ||
      b.s.goals - a.s.goals ||
      b.s.matches - a.s.matches ||
      String(a.p.name).localeCompare(String(b.p.name))
  );
  let rank = 0;
  let prev = null;
  sorted.forEach((r, i) => {
    const v = toNum(r.s[key]);
    if (v !== prev) { rank = i + 1; prev = v; }
    r.rank = rank;
  });
  return sorted;
}

// ---------- rewards ----------
export function eligibleTiers(balance, tiers) {
  return (tiers || []).filter((t) => t.points <= balance).sort((a, b) => a.points - b.points);
}

// ---------- shared HTML: full auction record of one match ----------
export function logText(e) {
  const team = e.teamName ? `<b>${esc(e.teamName)}</b>` : '';
  switch (e.type) {
    case 'captain':
      return `${team} captain set: <b>${esc(e.playerName)}</b> (start ${toNum(e.startingPoints)} + bonus ${toNum(e.bonusPoints)})`;
    case 'pick':
      return `${team} bought <b>${esc(e.playerName)}</b> for <b>${toNum(e.points)}</b> pts`;
    case 'undo-pick':
      return `${team} pick cancelled: ${esc(e.playerName)} (${toNum(e.points)} pts returned)`;
    case 'auction-complete':
      return 'Auction marked complete';
    case 'auction-reopen':
      return 'Auction re-opened';
    default:
      return esc(e.note || e.type || '');
  }
}

export function budgetGridHtml(t) {
  const cell = (label, val, cls = '') => `<div class="bcell ${cls}"><span>${label}</span><b>${val}</b></div>`;
  return `<div class="budget-grid">
    ${cell('Starting', toNum(t.startingPoints))}
    ${cell('Bonus', toNum(t.bonusPoints))}
    ${cell('Total', toNum(t.totalBeforeCap))}
    ${cell('Max usable', toNum(t.usablePoints))}
    ${cell('Excess', toNum(t.excessPoints), toNum(t.excessPoints) > 0 ? 'warn' : '')}
    ${cell('Spent', toNum(t.spentPoints))}
    ${cell('Remaining', toNum(t.remainingPoints), 'good')}
  </div>`;
}

export function auctionHtml(m, opts = {}) {
  const teams = (m.teams || [])
    .map((t) => {
      const picks = (t.picks || [])
        .map(
          (p, i) => `<li class="pick-row"><span class="pick-no">${i + 1}</span><span class="pick-name">${esc(p.playerName)}${t.viceCaptainId && t.viceCaptainId === p.playerId ? ' <span class="chip captain">VC</span>' : ''}</span><span class="pick-pts">${nonNeg(p.points)} pts</span></li>`
        )
        .join('');
      return `<div class="auc-team" style="--tc:${esc(t.color || '#00ff6a')}">
        <div class="auc-team-head">
          <div><h4>${esc(t.name)}</h4><p class="muted">Captain: <b>${t.captainName ? esc(t.captainName) : 'not selected'}</b>${t.viceCaptainName ? ` · Vice: <b>${esc(t.viceCaptainName)}</b>` : ''}${t.colorName ? ` · ${esc(t.colorName)}` : ''}</p></div>
          ${m.status === 'completed' && m.result ? `<span class="chip ${resultFor(m, (m.teams || []).indexOf(t)) === 'win' ? 'win' : ''}">${resultFor(m, (m.teams || []).indexOf(t)) || ''}</span>` : ''}
        </div>
        ${budgetGridHtml(t)}
        <ul class="pick-list">${picks || '<li class="muted small">No players picked.</li>'}</ul>
      </div>`;
    })
    .join('');
  const log = (m.auctionLog || [])
    .map((e) => `<li><time>${e.ts ? new Date(e.ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''}</time><span>${logText(e)}</span></li>`)
    .join('');
  return `<div class="auc-teams">${teams}</div>
    ${opts.log === false ? '' : `<details class="auc-log"><summary>Auction log (${(m.auctionLog || []).length} entries)</summary><ol class="log-list">${log || '<li class="muted small">Nothing recorded yet.</li>'}</ol></details>`}`;
}

// ---------- fees & expenses of one match ----------
// fees[playerId] = { status: 'paid' | 'pending' | 'unconfirmed', discount, redeemedPoints }
// (older records used paid: true/false — still understood)
export function feeStatus(f) {
  const x = f || {};
  if (x.status === 'paid' || x.status === 'pending' || x.status === 'unconfirmed') return x.status;
  return x.paid ? 'paid' : 'unconfirmed';
}
export const FEE_LABELS = { paid: 'Paid', pending: 'Pending', unconfirmed: 'Not confirmed' };
export function financeOf(m) {
  const roster = buildRoster(m);
  const fee = nonNeg(m.entryFee);
  let expected = 0, collected = 0, discounts = 0, paidCount = 0, pendingCount = 0, unconfirmedCount = 0;
  roster.forEach((r) => {
    const f = (m.fees || {})[r.playerId] || {};
    const disc = Math.min(nonNeg(f.discount), fee);
    const due = fee - disc;
    const st = feeStatus(f);
    expected += due;
    discounts += disc;
    if (st === 'paid') { collected += due; paidCount++; }
    else if (st === 'pending') pendingCount++;
    else unconfirmedCount++;
  });
  const expenses = (m.expenses || []).reduce((s, e) => s + nonNeg(e.amount), 0);
  return { players: roster.length, fee, expected, collected, outstanding: expected - collected, discounts, expenses, net: collected - expenses, paidCount, pendingCount, unconfirmedCount };
}
export const feeLabel = (m, sym = '₹') => (m.entryFee === null || m.entryFee === undefined || m.entryFee === '' ? 'Not set' : money(m.entryFee, sym));
export const scoreKnown = (m) => m.scoreUnknown !== true;
