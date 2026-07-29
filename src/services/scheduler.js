// scheduler: add fixtures auto-posting when within 7 days and hourly check
const storage = require('../config/storage');

let pollIntervalHandle = null;
let reminderIntervalHandle = null;
let fixturesIntervalHandle = null;

function _inSevenDays(ts) {
  const now = Date.now();
  const target = new Date(ts).getTime();
  const diff = target - now;
  return diff <= 7 * 24 * 60 * 60 * 1000 && diff > 0;
}

function start(client, matchManager) {
  // existing FACEIT poll every 60s (left as-is)
  pollIntervalHandle = setInterval(async () => {
    try {
      const matches = (await storage.get('matches')) || {};
      for (const mid of Object.keys(matches)) {
        const m = matches[mid];
        try {
          const faceit = require('./faceit');
          const mf = await faceit.getMatch(mid);
          const newSched = mf.scheduled_at || m.scheduled_at;
          if (newSched && newSched !== m.scheduled_at) {
            m.scheduled_at = newSched;
            try {
              const ch = await client.channels.fetch(m.channelId);
              const msg = await ch.messages.fetch(m.messageId);
              const timeStr = new Date(m.scheduled_at).toUTCString();
              await msg.edit(`OLDIEBALDIE MATCH\nMatch at ${timeStr} VS ${m.opponent} (Rescheduled)`);
              await ch.send(`Match ${m.match_id} has been rescheduled.`);
            } catch (e) { console.warn('failed to update rescheduled message', e?.message || e); }
            await storage.set('matches', matches);
          }

          if (mf.status === 'FINISHED' && m.status !== 'FINISHED') {
            m.status = 'FINISHED';
            await storage.set('matches', matches);
            try {
              const stats = await faceit.getMatchStats(mid);
              const ch = await client.channels.fetch(m.channelId);
              let report = `Match ${m.match_id} finished. Stats: \n`;
              report += JSON.stringify(stats).slice(0, 1900);
              await ch.send(report);
            } catch (e) { console.warn('failed to fetch/post match stats', e?.message || e); }

            try {
              const vc = await storage.get(`vc_${mid}`);
              if (vc) {
                const guild = await client.guilds.fetch(m.guildId);
                if (vc.matchVoiceId) {
                  const ch = guild.channels.cache.get(vc.matchVoiceId) || await guild.channels.fetch(vc.matchVoiceId).catch(()=>null);
                  if (ch) await ch.delete().catch(()=>{});
                }
                if (vc.fanVoiceId) {
                  const ch2 = guild.channels.cache.get(vc.fanVoiceId) || await guild.channels.fetch(vc.fanVoiceId).catch(()=>null);
                  if (ch2) await ch2.delete().catch(()=>{});
                }
              }
            } catch (e) { console.warn('failed cleanup after finished', e?.message || e); }
          }

        } catch (e) {
          console.warn('faceit poll error for', mid, e?.message || e);
        }
      }
    } catch (e) { console.error('poll loop error', e); }
  }, 60 * 1000);

  // Reminder every 2 hours (existing)
  reminderIntervalHandle = setInterval(async () => {
    try {
      const matches = (await storage.get('matches')) || {};
      for (const mid of Object.keys(matches)) {
        const m = matches[mid];
        for (const [uid, status] of Object.entries(m.attendance)) {
          if (status === 'no_response') {
            try {
              const u = await client.users.fetch(uid);
              await u.send(`Reminder: please respond to the match ${m.match_id} VS ${m.opponent}.`);
            } catch (e) { console.warn('failed to DM reminder', e?.message || e); }
          }
        }
      }
    } catch (e) { console.error('reminder loop error', e); }
  }, 1000 * 60 * 60 * 2);

  // Fixtures autodeploy checker every hour
  fixturesIntervalHandle = setInterval(async () => {
    try {
      const fixtures = (await storage.get('fixtures')) || {};
      for (const key of Object.keys(fixtures)) {
        const fx = fixtures[key];
        if (!fx.posted && fx.scheduled_at && _inSevenDays(fx.scheduled_at)) {
          try {
            // schedule via matchManager using faceit match id
            await matchManager.scheduleMatch({ matchInput: fx.match_id, notes: fx.notes || '', requester: { id: 'system' }, channel: fx.preferredChannel ? await client.channels.fetch(fx.preferredChannel) : await client.channels.fetch(fx.channelId), guild: fx.guildId ? await client.guilds.fetch(fx.guildId) : null });
            fx.posted = true;
            await storage.set('fixtures', fixtures);
            console.log('Auto-posted fixture', fx.match_id);
          } catch (e) { console.warn('failed to auto-post fixture', fx.match_id, e?.message || e); }
        }
      }
    } catch (e) { console.error('fixtures loop error', e); }
  }, 1000 * 60 * 60);
}

module.exports = { start };
