require('dotenv').config();
const FACEIT_KEY = process.env.FACEIT_API_KEY;
const { URL } = require('url');

async function _fetch(path) {
  if (!FACEIT_KEY) throw new Error('FACEIT_API_KEY not set');
  const url = `https://open.faceit.com/data/v4${path}`;
  const { fetch } = require('undici');
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${FACEIT_KEY}` } });
  if (!res.ok) {
    const txt = await res.text();
    const err = new Error(`FACEIT ${res.status}: ${txt}`);
    err.status = res.status;
    err.body = txt;
    throw err;
  }
  return res.json();
}

async function getTeamInfo(teamInput) {
  let teamId = (teamInput || '').trim();
  try {
    if (teamId.startsWith('http')) {
      const u = new URL(teamId);
      const parts = u.pathname.split('/').filter(Boolean);
      teamId = parts[parts.length - 1];
    }
  } catch (e) { /* ignore */ }
  try {
    const data = await _fetch(`/teams/${teamId}`);
    return data; // team object
  } catch (e) {
    if (e && e.status === 404) return null;
    console.warn('faceit.getTeamInfo error for', teamId, e?.message || e);
    return null;
  }
}

async function getMatch(matchId) {
  return _fetch(`/matches/${matchId}`);
}

async function getMatchStats(matchId) {
  return _fetch(`/matches/${matchId}/stats`);
}

// Fetch upcoming matches for a team. Best-effort: try matches endpoint then history, but never throw to caller — return empty array on not found.
async function getTeamMatches(teamInput) {
  // normalize input: allow full URLs or ids
  let teamId = (teamInput || '').trim();
  try {
    // if it's a URL, extract last path segment
    if (teamId.startsWith('http')) {
      try {
        const u = new URL(teamId);
        const parts = u.pathname.split('/').filter(Boolean);
        teamId = parts[parts.length - 1];
      } catch (e) { /* ignore */ }
    }

    // try matches endpoint first
    try {
      const data = await _fetch(`/teams/${teamId}/matches`);
      const items = data.items || data;
      const matches = (items || []).map(m => ({ match_id: m.match_id || m.id || (m.match && m.match.match_id), scheduled_at: m.scheduled_at || (m.match && m.match.scheduled_at) || m.date || m.estimated_start_date, status: m.status || 'UNKNOWN', opponent: (m.teams && (m.teams.faction2?.name || m.teams.faction1?.name)) || m.opponent || (m.factions && (m.factions.faction2?.name || m.factions.faction1?.name)) || 'Unknown' }));
      return matches.filter(x => x.match_id);
    } catch (e) {
      // if 404, try history endpoint as a fallback
      if (e && e.status === 404) {
        try {
          const data = await _fetch(`/teams/${teamId}/history?game=csgo&offset=0&limit=50`);
          const items = data.items || [];
          const matches = items.map(m => ({ match_id: m.match_id || m.id, scheduled_at: m.scheduled_at || m.date, status: m.status || 'UNKNOWN', opponent: m.opponent || 'Unknown' }));
          return matches.filter(x => x.match_id);
        } catch (err2) {
          // log and return empty
          console.warn('faceit.getTeamMatches: team not found or no matches (history fallback):', teamId, err2?.message || err2);
          return [];
        }
      }
      // other errors — log and return empty
      console.warn('faceit.getTeamMatches: matches endpoint failed for', teamId, e?.message || e);
      return [];
    }
  } catch (err) {
    console.error('faceit.getTeamMatches unexpected error for', teamInput, err?.message || err);
    return [];
  }
}

module.exports = { getTeamInfo, getMatch, getMatchStats, getTeamMatches };
