const storage = require('../config/storage');
const matchManager = require('./matchManager');
const faceit = require('./faceit');

let pollIntervalHandle = null;
let reminderIntervalHandle = null;

function start(client, matchManagerInstance) {
  // Poll FACEIT every 60s
  pollIntervalHandle = setInterval(async () => {
    try {
      const matches = (await storage.get('matches')) || {};
      for (const mid of Object.keys(matches)) {
        const m = matches[mid];
        try {
          const mf = await faceit.getMatch(mid);
          // check reschedule
          const newSched = mf.scheduled_at || m.scheduled_at;
          if (newSched && newSched !== m.scheduled_at) {
            m.scheduled_at = newSched;
            // update message
            try {
              const ch = await client.channels.fetch(m.channelId);
              const msg = await ch.messages.fetch(m.messageId);
              const { formatMatchTime } = require('../utils/formatting');
              const timeStr = formatMatchTime(m.scheduled_at, 'GMT');
              await msg.edit(`OLDIEBALDIE MATCH\nMatch at ${timeStr} VS ${m.opponent} (Rescheduled)`);
              // ping channel
              await ch.send(`Match ${m.match_id} has been rescheduled.`);
            } catch (e) { console.warn('failed to update rescheduled message', e?.message || e); }
            await storage.set('matches', matches);
          }

          // check status change to FINISHED
          if (mf.status === 'FINISHED' && m.status !== 'FINISHED') {
            m.status = 'FINISHED';
            await storage.set('matches', matches);
            // fetch stats and post report
            try {
              const stats = await faceit.getMatchStats(mid);
              // basic report formatting
              const ch = await client.channels.fetch(m.channelId);
              let report = `Match ${m.match_id} finished. Stats: \n`;
              report += JSON.stringify(stats).slice(0, 1900);
              await ch.send(report);
            } catch (e) { console.warn('failed to fetch/post match stats', e?.message || e); }

            // cleanup voice channels and events
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

  // Reminder every 2 hours
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
}

module.exports = { start };
