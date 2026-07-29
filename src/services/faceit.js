require('dotenv').config();
const FACEIT_KEY = process.env.FACEIT_API_KEY;

async function _fetch(path) {
  if (!FACEIT_KEY) throw new Error('FACEIT_API_KEY not set');
  const url = `https://open.faceit.com/data/v4${path}`;
  // prefer global fetch (Node 18+). If not available, dynamically import node-fetch
  let fetchFn = globalThis.fetch;
  if (!fetchFn) {
    const nf = await import('node-fetch');
    fetchFn = nf.default || nf;
  }
  const res = await fetchFn(url, { headers: { 'Authorization': `Bearer ${FACEIT_KEY}` } });
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

async function getTeamMatches(teamId) {
  try {
    const data = await _fetch(`/teams/${teamId}/matches`);
    const items = data.items || data;
    const matches = (items || []).map(m => ({ match_id: m.match_id || m.id || (m.match && m.match.match_id), scheduled_at: m.scheduled_at || (m.match && m.match.scheduled_at) || m.date || m.estimated_start_date, status: m.status || 'UNKNOWN', opponent: (m.teams && (m.teams.faction2?.name || m.teams.faction1?.name)) || m.opponent || (m.factions && (m.factions.faction2?.name || m.factions.faction1?.name)) || 'Unknown' }));
    return matches.filter(x => x.match_id);
  } catch (e) {
    const data = await _fetch(`/teams/${teamId}/history?game=csgo&offset=0&limit=50`);
    const items = data.items || [];
    const matches = items.map(m => ({ match_id: m.match_id || m.id, scheduled_at: m.scheduled_at || m.date, status: m.status || 'UNKNOWN', opponent: m.opponent || 'Unknown' }));
    return matches.filter(x => x.match_id);
  }
}

module.exports = { getMatch, getMatchStats, getTeamMatches };
