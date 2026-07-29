require('dotenv').config();
const FACEIT_KEY = process.env.FACEIT_API_KEY;
const { URL } = require('url');
const { fetch } = require('undici');

function isUUID(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function extractFirstUUID(text) {
  const m = text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : null;
}

async function _fetch(path) {
  if (!FACEIT_KEY) throw new Error('FACEIT_API_KEY not set');
  const url = `https://open.faceit.com/data/v4${path}`;
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

async function fetchHtml(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OLDIEBALDIE-bot/1.0)' } });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    console.warn('fetchHtml error', e?.message || e);
    return null;
  }
}

function extractTeamIdFromHtml(html) {
  if (!html) return null;
  // 1) look for explicit team_id or teamId JSON fields
  const jsonUid = (html.match(/"team[_Idid]{2,6}"\s*[:=]\s*"([0-9a-f\-]{36})"/i) || html.match(/"team_id"\s*:\s*"([0-9a-f\-]{36})"/i) || html.match(/"teamId"\s*:\s*"([0-9a-f\-]{36})"/i));
  if (jsonUid && jsonUid[1] && isUUID(jsonUid[1])) return jsonUid[1];

  // 2) find any UUID in the page near the word 'team'
  const idx = html.search(/team/i);
  if (idx !== -1) {
    const slice = html.slice(Math.max(0, idx - 200), idx + 200);
    const uuid = extractFirstUUID(slice);
    if (uuid && isUUID(uuid)) return uuid;
  }

  // 3) fallback: any UUID anywhere
  const any = extractFirstUUID(html);
  if (any && isUUID(any)) return any;

  return null;
}

async function getCanonicalTeamIdFromPage(teamInput) {
  let url = teamInput;
  try {
    if (!url.startsWith('http')) return null;
    const html = await fetchHtml(url);
    if (!html) return null;
    const id = extractTeamIdFromHtml(html);
    return id;
  } catch (e) {
    console.warn('getCanonicalTeamIdFromPage error', e?.message || e);
    return null;
  }
}

async function getTeamInfo(teamInput) {
  let teamId = (teamInput || '').trim();
  try {
    if (teamId.startsWith('http')) {
      try {
        const u = new URL(teamId);
        const parts = u.pathname.split('/').filter(Boolean);
        teamId = parts[parts.length - 1];
      } catch (e) { /* ignore */ }
    }

    try {
      const data = await _fetch(`/teams/${teamId}`);
      return data; // team object
    } catch (e) {
      if (e && e.status === 404) {
        // try to scrape the page for a canonical id
        const canonical = await getCanonicalTeamIdFromPage(teamInput);
        if (canonical && canonical !== teamId) {
          try {
            const data2 = await _fetch(`/teams/${canonical}`);
            return data2;
          } catch (e2) {
            return null;
          }
        }
        return null;
      }
      console.warn('faceit.getTeamInfo error for', teamId, e?.message || e);
      return null;
    }
  } catch (err) {
    console.error('faceit.getTeamInfo unexpected error for', teamInput, err?.message || err);
    return null;
  }
}

async function getMatch(matchId) {
  return _fetch(`/matches/${matchId}`);
}

async function getMatchStats(matchId) {
  return _fetch(`/matches/${matchId}/stats`);
}

// Fetch upcoming matches for a team. Best-effort: try matches endpoint then history, try canonical id via page scraping.
async function getTeamMatches(teamInput) {
  let teamId = (teamInput || '').trim();
  try {
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
        // attempt history with original id
        try {
          const data = await _fetch(`/teams/${teamId}/history?game=csgo&offset=0&limit=50`);
          const items = data.items || [];
          const matches = items.map(m => ({ match_id: m.match_id || m.id, scheduled_at: m.scheduled_at || m.date, status: m.status || 'UNKNOWN', opponent: m.opponent || 'Unknown' }));
          if (matches.length) return matches.filter(x => x.match_id);
        } catch (err2) {
          // continue to next fallback
        }

        // try canonical id scraped from team page (if input was a URL or slug)
        try {
          const canonical = await getCanonicalTeamIdFromPage(teamInput);
          if (canonical && canonical !== teamId) {
            try {
              const data2 = await _fetch(`/teams/${canonical}/matches`);
              const items2 = data2.items || data2;
              const matches2 = (items2 || []).map(m => ({ match_id: m.match_id || m.id || (m.match && m.match.match_id), scheduled_at: m.scheduled_at || (m.match && m.match.scheduled_at) || m.date || m.estimated_start_date, status: m.status || 'UNKNOWN', opponent: (m.teams && (m.teams.faction2?.name || m.teams.faction1?.name)) || m.opponent || 'Unknown' }));
              if (matches2.length) return matches2.filter(x => x.match_id);
            } catch (e3) {
              // try history for canonical id
              try {
                const data3 = await _fetch(`/teams/${canonical}/history?game=csgo&offset=0&limit=50`);
                const items3 = data3.items || [];
                const matches3 = items3.map(m => ({ match_id: m.match_id || m.id, scheduled_at: m.scheduled_at || m.date, status: m.status || 'UNKNOWN', opponent: m.opponent || 'Unknown' }));
                if (matches3.length) return matches3.filter(x => x.match_id);
              } catch (e4) {
                // give up
              }
            }
          }
        } catch (scrapeErr) {
          console.warn('faceit.getTeamMatches: scraping fallback failed', scrapeErr?.message || scrapeErr);
        }

        // nothing found
        return [];
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

module.exports = { getTeamInfo, getMatch, getMatchStats, getTeamMatches, getCanonicalTeamIdFromPage };
