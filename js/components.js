// =====================================================================
// VIP FOOTBALL LEAGUE — REUSABLE UI COMPONENTS (HTML templates)
// Pure functions: data in -> HTML text out. No Firebase code here.
// To redesign a player card or match card later, edit it here
// (and the matching CSS classes in css/style.css / css/theme.css).
// =====================================================================
import { esc, escMultiline, safeImg, initials, fmtDate, fmtTime, toNum, scoreKnown, feeLabel } from './lib.js';

export function avatar(p, cls = '') {
  const src = safeImg(p && p.photo);
  return src
    ? `<img class="avatar ${cls}" src="${esc(src)}" alt="${esc(p.name)}" loading="lazy">`
    : `<div class="avatar avatar-ph ${cls}">${esc(initials(p ? p.name : '?'))}</div>`;
}
export const statusChip = (m) => `<span class="chip ${esc(m.status)}">${m.status === 'live' ? 'Live' : esc(m.status)}</span>`;
export const emptyBox = (title, text) => `<div class="empty"><b>${esc(title)}</b>${esc(text)}</div>`;

export const dateLine = (m) => (m.dateMs ? `${fmtDate(m.dateMs)} · <b>${fmtTime(m.dateMs)}</b>` : '<span>Date not recorded</span>');

export function resultText(m) {
  if (m.status !== 'completed') return '';
  if (!m.result) return 'Result not recorded';
  if (m.result.outcome === 'draw') return 'Match drawn';
  const t = (m.teams || [])[m.result.winnerIndex];
  return t ? `${t.name} won` : '';
}

export function scoreBlock(m) {
  if (m.status === 'upcoming') return '<div class="mc-score vs">VS</div>';
  if (!scoreKnown(m)) return '<div class="mc-score vs">–<small>Score not recorded</small></div>';
  const sc = m.scores || [];
  return `<div class="mc-score">${toNum(sc[0])} – ${toNum(sc[1])}<small>${m.status === 'live' ? 'Live' : 'Full time'}</small></div>`;
}

export function teamCol(t) {
  return `<div class="mc-team" style="--tc:${esc(t.color || '#fff')}"><div class="tn">${esc(t.name)}</div><div class="cap">${t.captainName ? 'Capt. ' + esc(t.captainName) : 'Captain TBD'}</div></div>`;
}

export function matchCard(m, sym = '₹') {
  const teams = m.teams || [];
  const sc = m.scores || [];
  const body = teams.length === 2
    ? `<div class="mc-vs">${teamCol(teams[0])}${scoreBlock(m)}${teamCol(teams[1])}</div>`
    : `<div class="mc-list">${teams.map((t, i) => `<div class="row" style="--tc:${esc(t.color)}"><div><b>${esc(t.name)}</b><div class="small muted">${t.captainName ? 'Capt. ' + esc(t.captainName) : 'Captain TBD'}</div></div>${m.status === 'upcoming' || !scoreKnown(m) ? '' : `<span class="mc-score" style="font-size:28px">${toNum(sc[i])}</span>`}</div>`).join('')}</div>`;
  const res = resultText(m);
  return `<a class="card hover match-card ${m.status === 'live' ? 'live-card' : ''}" href="#/match/${esc(m.id)}">
    <div class="mc-top"><span>Match #${esc(m.number)}</span>${statusChip(m)}</div>
    ${body}
    <div class="mc-foot"><span>${dateLine(m)}</span><span>Entry <b>${esc(feeLabel(m, sym))}</b>${m.venue ? ' · ' + esc(m.venue) : ''}</span></div>
    ${res ? `<div class="mc-foot"><b class="${m.result ? 'green' : 'muted'}">${esc(res)}</b></div>` : ''}
  </a>`;
}

export function playerCard(p, s, i = 0) {
  return `<a class="card hover player-card ${p.active === false ? 'inactive' : ''}" data-jersey="${esc(p.jersey ?? '')}" style="animation-delay:${Math.min(i, 20) * 40}ms" href="#/player/${esc(p.id)}">
    ${avatar(p)}
    <div class="pc-name">${esc(p.name)}</div>
    <div class="pc-pos">${esc(p.position || 'Player')}${p.jersey !== undefined && p.jersey !== '' ? ' · #' + esc(p.jersey) : ''}${p.active === false ? ' · Inactive' : ''}</div>
    <div class="mini-stats">
      <div><b>${s.matches}</b><span>Played</span></div><div><b>${s.wins}</b><span>Wins</span></div><div><b>${s.goals}</b><span>Goals</span></div>
    </div>
  </a>`;
}

export function newsCard(n) {
  return `<article class="card news-card">
    <span class="chip">${esc(n.category || 'Announcement')}</span>
    <h3>${esc(n.title)}</h3>
    <p>${escMultiline(n.message)}</p>
    <p class="small muted" style="margin-top:8px">${fmtDate(n.dateMs)} · ${fmtTime(n.dateMs)}</p>
  </article>`;
}

export const statTile = (value, label) => `<div class="stat-tile"><b>${value}</b><span>${esc(label)}</span></div>`;
