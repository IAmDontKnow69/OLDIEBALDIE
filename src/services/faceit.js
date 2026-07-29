const fetch = require('node-fetch');
require('dotenv').config();
const FACEIT_KEY = process.env.FACEIT_API_KEY;

async function _fetch(path) {
  if (!FACEIT_KEY) throw new Error('FACEIT_API_KEY not set');
  const url = `https://open.faceit.com/data/v4${path}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${FACEIT_KEY}` } });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`FACEIT ${res.status}: ${txt}`);
  }
  return res.json();
}

async function getMatch(matchId) {
  return _fetch(`/matches/${matchId}`);
}

async function getMatchStats(matchId) {
  return _fetch(`/matches/${matchId}/stats`);
}

// Fetch upcoming matches for a team. This calls the teams/{team_id}/history endpoint and filters upcoming
async function getTeamMatches(teamId) {
  // Faceit doesn't have a single 'fixtures' endpoint; use team matches endpoint and filter by status
  try {
    const data = await _fetch(`/teams/${teamId}/matches`);
    // data.items or data? Try common shapes
    const items = data.items || data;
    // normalize to array of matches with id and scheduled time and status
    const matches = (items || []).map(m => ({ match_id: m.match_id || m.id || m.match?.match_id, scheduled_at: m.scheduled_at || m.match?.scheduled_at || m.date || m.estimated_start_date, status: m.status || m.lobby ? 'SCHEDULED' : (m.status || 'UNKNOWN'), opponent: (m.teams && (m.teams.faction2?.name || m.teams.opponent)) || m.opponent || (m.factions && (m.factions.faction2?.name || m.factions.faction1?.name)) || 'Unknown' }));
    return matches.filter(x => x.match_id);
  } catch (e) {
    // fallback: try team history
    const data = await _fetch(`/teams/${teamId}/history?game=csgo&offset=0&limit=50`);
    const items = data.items || [];
    const matches = items.map(m => ({ match_id: m.match_id || m.id, scheduled_at: m.scheduled_at || m.date, status: m.status || 'UNKNOWN', opponent: m.opponent || 'Unknown' }));
    return matches.filter(x => x.match_id);
  }
}

module.exports = { getMatch, getMatchStats, getTeamMatches };
