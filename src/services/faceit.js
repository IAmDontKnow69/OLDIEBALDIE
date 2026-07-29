const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();
const FACEIT_API_KEY = process.env.FACEIT_API_KEY;

if (!FACEIT_API_KEY) {
  // allow deploy without key; runtime will require key for actual requests
}

module.exports = {
  getMatch: async (matchId) => {
    if (!FACEIT_API_KEY) throw new Error('FACEIT_API_KEY not set');
    const url = `https://open.faceit.com/data/v4/matches/${encodeURIComponent(matchId)}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${FACEIT_API_KEY}` } });
    if (!res.ok) throw new Error(`FACEIT API error: ${res.status}`);
    return res.json();
  },
  getMatchStats: async (matchId) => {
    if (!FACEIT_API_KEY) throw new Error('FACEIT_API_KEY not set');
    const url = `https://open.faceit.com/data/v4/matches/${encodeURIComponent(matchId)}/stats`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${FACEIT_API_KEY}` } });
    if (!res.ok) throw new Error(`FACEIT API error: ${res.status}`);
    return res.json();
  }
};
