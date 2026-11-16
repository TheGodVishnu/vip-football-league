// =====================================================================
// VIP FOOTBALL LEAGUE — INITIAL DATA (supplied by the league owner)
//   * 20 registered players
//   * Match 1 as a permanent historical record
// Pure data builder: it writes nothing by itself. The admin panel's
// "Load initial league data" button saves it to Firestore.
// Nothing here is invented: no score, date, winner, photo, position or
// jersey number was supplied, so those stay empty / "not recorded".
// =====================================================================
import { calcBudget, aggregatePlayer, toNum } from './lib.js';

export const INITIAL_PLAYERS = [
  'Vishnu', 'Dev', 'Mayank', 'Prince', 'Manav Jr', 'Himansu', 'Raaj', 'Aryan', 'Adarsh', 'Vipin',
  'Goldey', 'Rahul', 'Gaurang', 'Lakkhan', 'Manav', 'Govind', 'Preet', 'Kashyap', 'Aniket', 'Aayush',
];
// Registered, entry fee / payment currently PENDING. Everyone else: not confirmed (never assumed paid).
export const PENDING_PAYMENT = ['Aniket', 'Aayush'];

export const slug = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const MATCH1_ID = 'match-1';

// "Himanshu" in the auction sheet = registered player "Himansu" (one identity).
const AUCTION_NAME_FIX = { Himanshu: 'Himansu' };

const MATCH1 = {
  teams: [
    {
      name: 'Adrash', colorName: 'Blue', color: '#3da9ff', captain: 'Adarsh', vice: 'Vishnu',
      picks: [['Vishnu', 38], ['Dev', 35], ['Aniket', 5], ['Mayank', 39], ['Goldey', 5], ['Vipin', 5], ['Aayush', 5], ['Lakkhan', 5]],
    },
    {
      name: 'Kashyap', colorName: 'Red', color: '#ff3b4e', captain: 'Kashyap', vice: 'Manav',
      picks: [['Manav', 29], ['Rahul', 10], ['Govind', 12], ['Aryan', 5], ['Raaj', 5], ['Himanshu', 14], ['Preet', 19], ['Gaurang', 13]],
    },
  ],
  // normal, penalty
  goals: { Preet: [0, 2], Gaurang: [0, 1], Rahul: [1, 0], Vishnu: [1, 0] },
};

export function buildSeed({ now = Date.now(), maxBudget = 150 } = {}) {
  const idOf = (name) => `${slug(AUCTION_NAME_FIX[name] || name)}`;
  const players = INITIAL_PLAYERS.map((name) => ({
    id: slug(name),
    data: {
      name, jersey: '', position: '', photo: '', active: true, rewardLedger: [],
      payment: PENDING_PAYMENT.includes(name) ? 'pending' : 'unconfirmed',
      source: 'initial-data', createdAt: now,
    },
  }));
  const known = new Set(players.map((p) => p.id));

  const log = [{ ts: null, type: 'note', note: 'Historical record entered from the supplied auction sheet (original times were not recorded).' }];
  const teams = MATCH1.teams.map((t, i) => {
    const picks = t.picks.map(([n, pts], k) => {
      const id = idOf(n);
      if (!known.has(id)) throw new Error(`Seed error: ${n} is not a registered player`);
      const pk = { playerId: id, playerName: AUCTION_NAME_FIX[n] || n, points: pts, order: k + 1, ts: null };
      if (AUCTION_NAME_FIX[n]) pk.originalName = n;
      return pk;
    });
    const spent = picks.reduce((s, p) => s + p.points, 0);
    // 150 is the provisional per-team budget supplied by the owner (kept configurable).
    const b = calcBudget({ startingPoints: maxBudget, bonusPoints: 0, spentPoints: spent }, maxBudget);
    const team = {
      name: t.name, colorName: t.colorName, color: t.color,
      captainId: idOf(t.captain), captainName: t.captain,
      viceCaptainId: idOf(t.vice), viceCaptainName: AUCTION_NAME_FIX[t.vice] || t.vice,
      ...b, picks,
    };
    log.push({ ts: null, type: 'captain', teamIndex: i, teamName: t.name, playerId: team.captainId, playerName: t.captain, startingPoints: b.startingPoints, bonusPoints: 0, totalBeforeCap: b.totalBeforeCap, usablePoints: b.usablePoints, excessPoints: b.excessPoints });
    picks.forEach((p) => log.push({ ts: null, type: 'pick', teamIndex: i, teamName: t.name, playerId: p.playerId, playerName: p.playerName, points: p.points }));
    return team;
  });

  const match = {
    id: MATCH1_ID,
    data: {
      number: 1, dateMs: null, venue: '', entryFee: null, status: 'completed', auctionStatus: 'completed',
      teams, scores: [0, 0], scoreUnknown: true, result: null, resultUnknown: true,
      pool: players.map((p) => p.id), fees: {}, expenses: [], auctionLog: log,
      auctionSettings: { startingPoints: maxBudget, maxBudget }, source: 'historical', createdAt: now,
      notes: [
        'Historical match. The date, final score and winner were not supplied, so they are shown as “not recorded”.',
        'Team ADRASH (Blue) is captained by Adarsh. The team name on the poster is spelled ADRASH.',
        'The auction sheet spelled one player “Himanshu”; the registered player is Himansu (same person).',
        'Listed auction spends cover the bought players only and do not include any captain purchase value.',
        'The 150-point budget per team is provisional and can be changed in Settings.',
      ],
    },
  };
  PENDING_PAYMENT.forEach((n) => { match.data.fees[slug(n)] = { status: 'pending', paid: false }; });

  const pms = [];
  teams.forEach((t, i) => {
    const row = (playerId, playerName, isCaptain, auctionPoints) => {
      const g = MATCH1.goals[playerName] || [0, 0];
      pms.push({
        id: `${MATCH1_ID}_${playerId}`,
        data: {
          matchId: MATCH1_ID, matchNumber: 1, matchDateMs: null, matchStatus: 'completed',
          playerId, playerName, teamIndex: i, teamName: t.name, isCaptain, isVice: !isCaptain && t.viceCaptainId === playerId,
          auctionPoints, result: null, normalGoals: g[0], penaltyGoals: g[1], goals: g[0] + g[1], rewardPointsEarned: 0,
          budget: isCaptain ? { startingPoints: t.startingPoints, bonusPoints: t.bonusPoints, totalBeforeCap: t.totalBeforeCap, usablePoints: t.usablePoints, excessPoints: t.excessPoints, spentPoints: t.spentPoints, remainingPoints: t.remainingPoints, maxBudget: t.maxBudget } : null,
        },
      });
    };
    row(t.captainId, t.captainName, true, 0);
    t.picks.forEach((p) => row(p.playerId, p.playerName, false, p.points));
  });

  const stats = players.map((p) => ({
    id: p.id,
    data: { ...aggregatePlayer(pms.filter((x) => x.data.playerId === p.id).map((x) => x.data), [], {}), playerId: p.id, updatedAt: now },
  }));
  return { players, match, pms, stats };
}

export const seedTotals = (seed) => ({
  normal: seed.pms.reduce((s, x) => s + toNum(x.data.normalGoals), 0),
  penalty: seed.pms.reduce((s, x) => s + toNum(x.data.penaltyGoals), 0),
});
