const { ChannelType, PermissionFlagsBits } = require('discord.js');
const storage = require('../config/storage');
const faceit = require('./faceit');
const { formatMatchTime } = require('../utils/formatting');

let clientRef;

async function init(client) {
  clientRef = client;
}

function _makeMention(id) {
  return id ? `<@${id}>` : '@_';
}

function _statusEmoji(status) {
  switch (status) {
    case 'attending': return '🟢';
    case 'not_attending': return '🔴';
    case 'maybe': return '🟡';
    case 'no_response':
    default:
      return '⚪';
  }
}

async function _renderMatchText(match) {
  // fetch server config and role members
  const cfg = (await storage.get('server_config')) || {};
  const guild = await clientRef.guilds.fetch(match.guildId).catch(() => null);

  // Helper to resolve role members into arrays of user mentions, default to stored ids
  let starting5 = match.starting5 || [];
  let bench = match.bench || [];
  let coach = match.coach || [];

  // Build status lines using attendance map
  const att = match.attendance || {};

  const formatList = (arr) => arr.map(id => `${_statusEmoji(att[id] || 'no_response')} <@${id}>`).join('  ');

  const timeStr = formatMatchTime(match.scheduled_at, 'GMT'); // default to GMT in case user tz not known

  const header = `OLDIEBALDIE MATCH\nMatch at ${timeStr} VS ${match.opponent}\nUK TEAM ONLY\n\n`;
  const startingLine = `Starting 5: ${formatList(starting5) || '_none_'}\n\n`;
  const benchLine = `Bench: ${formatList(bench) || '_none_'}\n\n`;
  const coachLine = `Coach: ${formatList(coach) || '_none_'}\n\n`;
  const key = 'Key : 🟢 Attending : 🔴 Not Attending : 🟡 Maybe : ⚪ No response';

  return `${header}${startingLine}${benchLine}${coachLine}${key}`;
}

async function scheduleMatch({ matchInput, notes, requester, channel, guild }) {
  // extract ID
  const matchId = (matchInput || '').trim().split('/').pop();
  const mf = await faceit.getMatch(matchId);
  const scheduled = mf.scheduled_at || mf.estimated_start_date || mf.scheduled_at;
  const opponent = (mf.factions && (mf.factions.faction2?.name || mf.factions.faction1?.name)) || (mf.teams && mf.teams.faction2?.name) || mf.opponent || 'Unknown';

  // Build default roster from roles (if configured)
  const cfg = (await storage.get('server_config')) || {};
  const mainRole = cfg.ROLE_MAIN_TEAM;
  const benchRole = cfg.ROLE_SUBS_BENCH;
  const staffRole = cfg.ROLE_STAFF;

  const guildObj = guild || (requester ? await clientRef.guilds.fetch(requester.guildId).catch(() => null) : null);

  let starting5 = [];
  let bench = [];
  let coach = [];

  if (guildObj && mainRole) {
    try {
      const role = await guildObj.roles.fetch(mainRole);
      const members = role.members.map(m => m.user.id).slice(0, 5);
      starting5 = members;
    } catch (e) { }
  }

  if (guildObj && benchRole) {
    try {
      const role = await guildObj.roles.fetch(benchRole);
      bench = role.members.map(m => m.user.id).filter(id => !starting5.includes(id));
    } catch (e) { }
  }

  if (guildObj && staffRole) {
    try {
      const role = await guildObj.roles.fetch(staffRole);
      coach = role.members.map(m => m.user.id);
    } catch (e) { }
  }

  const matchObj = {
    match_id: matchId,
    scheduled_at: scheduled || new Date().toISOString(),
    opponent: opponent || 'Unknown',
    notes: notes || '',
    guildId: guild.id,
    channelId: channel.id,
    starting5,
    bench,
    coach,
    attendance: {}, // userId -> 'attending'|'not_attending'|'maybe'|'no_response'
    status: mf.status || 'SCHEDULED',
    messageId: null,
    eventId: null,
  };

  // Set initial attendance to no_response
  for (const id of [...starting5, ...bench, ...coach]) matchObj.attendance[id] = 'no_response';

  // Persist
  const matches = (await storage.get('matches')) || {};
  matches[matchId] = matchObj;
  await storage.set('matches', matches);

  // Post public message
  const text = await _renderMatchText(matchObj);
  const posted = await channel.send(text);
  matchObj.messageId = posted.id;
  // seed reactions
  await posted.react('🟢');
  await posted.react('🔴');
  await posted.react('🟡');

  // Create scheduled event and voice channels if category configured
  try {
    const cfg2 = (await storage.get('server_config')) || {};
    const cat = cfg2.CATEGORY_MATCHDAY_ID;
    if (cat) {
      // create matchday voice
      const matchVoice = await guild.channels.create({ name: `🔊 Matchday: VS ${matchObj.opponent}`, type: ChannelType.GuildVoice, parent: cat });
      const fanVoice = await guild.channels.create({ name: `🏟️ Fan Zone: VS ${matchObj.opponent}`, type: ChannelType.GuildVoice, parent: cat });
      // restrict matchVoice to starting5, bench, coach
      const allowIds = [...(matchObj.starting5||[]), ...(matchObj.bench||[]), ...(matchObj.coach||[])];
      for (const id of allowIds) {
        await matchVoice.permissionOverwrites.create(id, { Connect: true, ViewChannel: true });
      }
      await storage.set(`vc_${matchId}`, { matchVoiceId: matchVoice.id, fanVoiceId: fanVoice.id });
    }

    // create guild scheduled event (best-effort)
    try {
      const guildFull = await clientRef.guilds.fetch(matchObj.guildId);
      const event = await guildFull.scheduledEvents.create({
        name: `OLDIEBALDIE VS ${matchObj.opponent}`,
        scheduledStartTime: new Date(matchObj.scheduled_at),
        scheduledEndTime: new Date(new Date(matchObj.scheduled_at).getTime() + 1000 * 60 * 60 * 2),
        privacyLevel: 2, // GUILD_ONLY
        entityType: 2, // VOICE
      });
      matchObj.eventId = event.id;
    } catch (e) {
      console.warn('Failed to create guild event', e?.message || e);
    }
  } catch (e) {
    console.warn('Error creating channels/events', e?.message || e);
  }

  // persist updated
  const matches2 = (await storage.get('matches')) || {};
  matches2[matchId] = matchObj;
  await storage.set('matches', matches2);

  return matchObj;
}

async function handleReactionAdd(reaction, user, client) {
  // check if reaction is on any match message
  const matches = (await storage.get('matches')) || {};
  for (const mid of Object.keys(matches)) {
    const m = matches[mid];
    if (m.messageId === reaction.message.id) {
      // map emoji to status
      const emoji = reaction.emoji.name;
      let status = 'no_response';
      if (emoji === '🟢') status = 'attending';
      if (emoji === '🔴') status = 'not_attending';
      if (emoji === '🟡') status = 'maybe';
      m.attendance[user.id] = status;

      // If starter and not attending, try auto-promote
      if (m.starting5.includes(user.id) && status === 'not_attending') {
        // find bench candidate: first bench who is attending or no_response
        let promoted = null;
        for (const bId of m.bench) {
          const bStatus = m.attendance[bId] || 'no_response';
          if (bStatus === 'attending' || bStatus === 'no_response') {
            promoted = bId;
            break;
          }
        }
        if (promoted) {
          // swap arrays
          m.bench = m.bench.filter(x => x !== promoted).concat([user.id]);
          m.starting5 = m.starting5.filter(x => x !== user.id).concat([promoted]);
          // set promoted attendance to attending if was no_response
          if (m.attendance[promoted] === 'no_response') m.attendance[promoted] = 'attending';
          m.attendance[user.id] = 'not_attending';

          // notify promoted via DM
          try {
            const u = await client.users.fetch(promoted);
            await u.send(`You have been promoted to Starting 5 for match VS ${m.opponent} (match ${m.match_id}). Please confirm your availability.`);
          } catch (e) { console.warn('failed to DM promoted user', e?.message || e); }
        }
      }

      // persist and re-render
      const matches2 = (await storage.get('matches')) || {};
      matches2[mid] = m;
      await storage.set('matches', matches2);

      try {
        const ch = await client.channels.fetch(m.channelId);
        const msg = await ch.messages.fetch(m.messageId);
        const text = await _renderMatchText(m);
        await msg.edit(text);
      } catch (e) { console.warn('Failed to update match message', e?.message || e); }

      break;
    }
  }
}

async function pingUnresponsive(guildId, channelId) {
  const matches = (await storage.get('matches')) || {};
  // find a match in this channel
  const found = Object.values(matches).find(m => m.channelId === channelId);
  if (!found) return 'No scheduled match found in this channel.';
  const list = [];
  for (const [id, status] of Object.entries(found.attendance)) {
    if (status === 'no_response') list.push(`<@${id}>`);
  }
  if (list.length === 0) return 'No unresponsive players.';
  const sent = await (await clientRef.channels.fetch(channelId)).send(`Ping: ${list.join(' ')} — please respond with a reaction on the match post.`);
  return `Pinged ${list.length} players.`;
}

async function cancelMatchFromChannel(channelId) {
  const matches = (await storage.get('matches')) || {};
  const id = Object.keys(matches).find(k => matches[k].channelId === channelId);
  if (!id) return 'No match found in this channel to cancel.';
  const m = matches[id];
  // update message to CANCELLED
  try {
    const ch = await clientRef.channels.fetch(m.channelId);
    const msg = await ch.messages.fetch(m.messageId);
    await msg.edit(`OLDIEBALDIE MATCH\nCANCELLED`);
  } catch (e) { console.warn('could not edit message on cancel', e?.message || e); }

  // delete voice channels if created
  try {
    const vc = await storage.get(`vc_${id}`);
    if (vc) {
      const guild = await clientRef.guilds.fetch(m.guildId);
      if (vc.matchVoiceId) {
        const ch = guild.channels.cache.get(vc.matchVoiceId) || await guild.channels.fetch(vc.matchVoiceId).catch(()=>null);
        if (ch) await ch.delete().catch(()=>{});
      }
      if (vc.fanVoiceId) {
        const ch2 = guild.channels.cache.get(vc.fanVoiceId) || await guild.channels.fetch(vc.fanVoiceId).catch(()=>null);
        if (ch2) await ch2.delete().catch(()=>{});
      }
    }
  } catch (e) { console.warn('failed to cleanup channels', e?.message || e); }

  // mark cancelled
  m.status = 'CANCELLED';
  matches[id] = m;
  await storage.set('matches', matches);
  return 'Match cancelled and resources cleaned up.';
}

module.exports = { init, scheduleMatch, handleReactionAdd, pingUnresponsive, cancelMatchFromChannel };
