const express = require('express');
const { Client, GatewayIntentBits, Partials, Collection, ChannelType } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const storage = require('./config/storage');
const { deployGuildCommands } = require('./utils/commandDeployer');
const matchManager = require('./services/matchManager');
const scheduler = require('./services/scheduler');
const faceit = require('./services/faceit');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
if (!TOKEN) {
  console.error('DISCORD_TOKEN not set in environment. Exiting.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

client.commands = new Collection();

// Load command modules
const commandsPath = path.join(__dirname, 'commands');
if (fs.existsSync(commandsPath)) {
  const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
  for (const file of commandFiles) {
    const cmd = require(path.join(commandsPath, file));
    if (cmd.data && cmd.execute) {
      client.commands.set(cmd.data.name, cmd);
    }
  }
}

function _renderConfigEmbed(guild, cfg) {
  const { EmbedBuilder } = require('discord.js');
  const embed = new EmbedBuilder().setTitle('Server Role Configuration').setColor(0x00AE86);
  const main = cfg.ROLE_MAIN_TEAM ? (guild.roles.cache.get(cfg.ROLE_MAIN_TEAM)?.name || cfg.ROLE_MAIN_TEAM) : '_not set_';
  const bench = cfg.ROLE_SUBS_BENCH ? (guild.roles.cache.get(cfg.ROLE_SUBS_BENCH)?.name || cfg.ROLE_SUBS_BENCH) : '_not set_';
  const staff = cfg.ROLE_STAFF ? (guild.roles.cache.get(cfg.ROLE_STAFF)?.name || cfg.ROLE_STAFF) : '_not set_';
  const cat = cfg.CATEGORY_MATCHDAY_ID ? (guild.channels.cache.get(cfg.CATEGORY_MATCHDAY_ID)?.name || cfg.CATEGORY_MATCHDAY_ID) : '_not set_';
  embed.addFields(
    { name: 'Main Team Role', value: `${main}`, inline: true },
    { name: 'Subs Bench Role', value: `${bench}`, inline: true },
    { name: 'Staff Role', value: `${staff}`, inline: true },
    { name: 'Matchday Category', value: `${cat}`, inline: true }
  );
  return embed;
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await storage.init();
  // cache server config to avoid storage I/O during interactions
  client.serverConfig = (await storage.get('server_config')) || {};
  await matchManager.init(client);

  // Deploy guild commands
  if (GUILD_ID) {
    const cmds = client.commands.map(c => c.data);
    try {
      await deployGuildCommands(GUILD_ID, cmds);
      console.log('Deployed guild commands to', GUILD_ID);
    } catch (e) {
      console.warn('Could not deploy guild commands:', e.message || e);
    }
  }

  // Start background services
  scheduler.start(client, matchManager);

  console.log('Bot ready');
});

// Helper to build combined list of fixtures+matches sorted by scheduled_at
async function _getCombinedMatches(guildId) {
  const fixtures = (await storage.get('fixtures')) || {};
  const matches = (await storage.get('matches')) || {};
  const combinedMap = {};
  for (const k of Object.keys(fixtures)) combinedMap[k] = { ...fixtures[k], __type: 'fixture' };
  for (const k of Object.keys(matches)) combinedMap[k] = { ...matches[k], __type: 'match' };
  let list = Object.values(combinedMap);
  list = list.filter(i => !guildId || i.guildId === guildId);
  list.sort((a, b) => {
    const ta = a.scheduled_at ? new Date(a.scheduled_at).getTime() : 0;
    const tb = b.scheduled_at ? new Date(b.scheduled_at).getTime() : 0;
    return ta - tb;
  });
  return list;
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = client.commands.get(interaction.commandName);
      if (!cmd) return;
      await cmd.execute(interaction, client);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'select_timezone') {
        const tz = interaction.values[0];
        await storage.set(`tz_${interaction.user.id}`, tz);
        await interaction.update({ content: `Timezone saved: ${tz}`, components: [] });
        return;
      }

      if (interaction.customId.startsWith('select_role_')) {
        const which = interaction.customId.replace('select_role_', ''); // main, bench, staff, category
        const val = interaction.values[0];
        const cfg = (await storage.get('server_config')) || {};
        if (which === 'category') {
          cfg.CATEGORY_MATCHDAY_ID = val;
        } else if (which === 'main') {
          cfg.ROLE_MAIN_TEAM = val;
        } else if (which === 'bench') {
          cfg.ROLE_SUBS_BENCH = val;
        } else if (which === 'staff') {
          cfg.ROLE_STAFF = val;
        }
        await storage.set('server_config', cfg);
        client.serverConfig = cfg;
        // rebuild the same role-select UI but show updated config at top
        const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
        const roles = interaction.guild.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => ({ label: r.name.substring(0, 100), value: r.id }));
        const roleChunks = roles.slice(0, 25);
        const mainSelect = new StringSelectMenuBuilder().setCustomId('select_role_main').setPlaceholder('Select Main Team Role').addOptions(roleChunks);
        const benchSelect = new StringSelectMenuBuilder().setCustomId('select_role_bench').setPlaceholder('Select Subs Bench Role').addOptions(roleChunks);
        const staffSelect = new StringSelectMenuBuilder().setCustomId('select_role_staff').setPlaceholder('Select Staff Role').addOptions(roleChunks);
        const categories = interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).map(c => ({ label: c.name.substring(0, 100), value: c.id }));
        const catOptions = categories.slice(0, 25);
        const catSelect = new StringSelectMenuBuilder().setCustomId('select_role_category').setPlaceholder('Select Matchday Category').addOptions(catOptions);
        const rows = [
          new ActionRowBuilder().addComponents(mainSelect),
          new ActionRowBuilder().addComponents(benchSelect),
          new ActionRowBuilder().addComponents(staffSelect),
          new ActionRowBuilder().addComponents(catSelect),
        ];
        const embed = _renderConfigEmbed(interaction.guild, cfg);
        await interaction.update({ embeds: [embed], components: rows });
        return;
      }
    }

    if (interaction.isButton()) {
      const id = interaction.customId;

      // permission check
      const cfg = client.serverConfig || (await storage.get('server_config')) || {};
      const staffRoleId = cfg.ROLE_STAFF;
      const isAdmin = interaction.member.permissions.has('Administrator');
      const isStaff = staffRoleId && interaction.member.roles.cache.has(staffRoleId);
      if (!isAdmin && !isStaff) {
        return interaction.reply({ content: 'You do not have permission to use this control.', flags: 64 });
      }

      // Add FACEIT Team
      if (id === 'add_faceit_team') {
        const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
        const modal = new ModalBuilder().setCustomId('modal_add_faceit_team').setTitle('Import FACEIT Team Fixtures');
        const teamInput = new TextInputBuilder().setCustomId('faceit_team_id').setLabel('FACEIT Team ID or URL').setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(teamInput));
        await interaction.showModal(modal);
        return;
      }

      // Open combined matches/fixtures viewer (pagination)
      if (id === 'show_fixtures' || id === 'list_matches' || id === 'browse_matches') {
        await _showMatchesPage(interaction, 0);
        return;
      }

      // Page navigation: customId page:<pageIndex>
      if (id.startsWith('page:')) {
        const page = parseInt(id.split(':')[1], 10) || 0;
        await _showMatchesPage(interaction, page);
        return;
      }

      // Select a match to view actions
      if (id.startsWith('select_match:')) {
        const matchId = id.split(':').slice(1).join(':');
        await _showMatchActions(interaction, matchId);
        return;
      }

      // Match action handlers
      if (id.startsWith('match_post:')) {
        await interaction.deferReply({ flags: 64 });
        const matchId = id.split(':').slice(1).join(':');
        const fixtures = (await storage.get('fixtures')) || {};
        const fx = fixtures[matchId] || null;
        try {
          const ch = fx && fx.preferredChannel ? await client.channels.fetch(fx.preferredChannel) : (fx && fx.channelId ? await client.channels.fetch(fx.channelId) : interaction.channel);
          const guild = fx && fx.guildId ? await client.guilds.fetch(fx.guildId) : interaction.guild;
          await matchManager.scheduleMatch({ matchInput: matchId, notes: fx ? fx.notes || '' : '', requester: interaction.user, channel: ch, guild });
          if (fx) { fx.posted = true; fixtures[matchId] = fx; await storage.set('fixtures', fixtures); }
          await interaction.editReply({ content: 'Fixture posted successfully' });
        } catch (e) {
          console.error('match_post error', e);
          await interaction.editReply({ content: `Failed to post fixture: ${e.message}` });
        }
        return;
      }

      if (id.startsWith('match_open:')) {
        const matchId = id.split(':').slice(1).join(':');
        const url = `https://www.faceit.com/en/match/${matchId}`;
        await interaction.reply({ content: `Open Faceit match room: ${url}`, flags: 64 });
        return;
      }

      if (id.startsWith('match_remind:')) {
        await interaction.deferReply({ flags: 64 });
        const matchId = id.split(':').slice(1).join(':');
        const matches = (await storage.get('matches')) || {};
        const fixtures = (await storage.get('fixtures')) || {};
        const item = matches[matchId] || fixtures[matchId];
        if (!item) { await interaction.editReply({ content: 'Match not found' }); return; }
        const notResponded = Object.entries(item.attendance || {}).filter(([uid, status]) => status === 'no_response').map(([uid]) => uid);
        let sent = 0;
        for (const uid of notResponded) {
          try {
            const u = await client.users.fetch(uid);
            await u.send(`Reminder: please respond to the match ${item.match_id} VS ${item.opponent || 'Unknown'}.`);
            sent++;
          } catch (e) { console.warn('failed to DM reminder', e?.message || e); }
        }
        await interaction.editReply({ content: `Sent reminders to ${sent} players.` });
        return;
      }

      if (id.startsWith('match_ping:')) {
        await interaction.deferReply({ flags: 64 });
        const matchId = id.split(':').slice(1).join(':');
        const matches = (await storage.get('matches')) || {};
        const fixtures = (await storage.get('fixtures')) || {};
        const item = matches[matchId] || fixtures[matchId];
        if (!item) { await interaction.editReply({ content: 'Match not found' }); return; }
        const notResponded = Object.entries(item.attendance || {}).filter(([uid, status]) => status === 'no_response').map(([uid]) => `<@${uid}>`);
        if (notResponded.length === 0) { await interaction.editReply({ content: 'No unresponsive players.' }); return; }
        const ch = item.channelId ? await client.channels.fetch(item.channelId) : interaction.channel;
        await ch.send(`Ping: ${notResponded.join(' ')} — please respond with a reaction on the match post.`);
        await interaction.editReply({ content: `Pinged ${notResponded.length} players.` });
        return;
      }

      // other existing handlers
      if (id === 'schedule_faceit_match') {
        const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
        const modal = new ModalBuilder().setCustomId('modal_schedule_match').setTitle('Schedule FACEIT Match');
        const matchInput = new TextInputBuilder().setCustomId('match_id').setLabel('FACEIT Match ID or URL').setStyle(TextInputStyle.Short).setRequired(true);
        const notesInput = new TextInputBuilder().setCustomId('notes').setLabel('Special Notes (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false);
        modal.addComponents(new ActionRowBuilder().addComponents(matchInput), new ActionRowBuilder().addComponents(notesInput));
        await interaction.showModal(modal);
        return;
      }

      if (id === 'configure_roles') {
        // present role select menus (initial view shows current set of roles)
        const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
        const cfg = (await storage.get('server_config')) || {};
        const embed = _renderConfigEmbed(interaction.guild, cfg);
        const roles = interaction.guild.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => ({ label: r.name.substring(0, 100), value: r.id }));
        const roleChunks = roles.slice(0, 25);
        const mainSelect = new StringSelectMenuBuilder().setCustomId('select_role_main').setPlaceholder('Select Main Team Role').addOptions(roleChunks);
        const benchSelect = new StringSelectMenuBuilder().setCustomId('select_role_bench').setPlaceholder('Select Subs Bench Role').addOptions(roleChunks);
        const staffSelect = new StringSelectMenuBuilder().setCustomId('select_role_staff').setPlaceholder('Select Staff Role').addOptions(roleChunks);
        const categories = interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).map(c => ({ label: c.name.substring(0, 100), value: c.id }));
        const catOptions = categories.slice(0, 25);
        const catSelect = new StringSelectMenuBuilder().setCustomId('select_role_category').setPlaceholder('Select Matchday Category').addOptions(catOptions);
        const rows = [
          new ActionRowBuilder().addComponents(mainSelect),
          new ActionRowBuilder().addComponents(benchSelect),
          new ActionRowBuilder().addComponents(staffSelect),
          new ActionRowBuilder().addComponents(catSelect),
        ];
        await interaction.reply({ embeds: [embed], components: rows, flags: 64 });
        return;
      }

      if (id === 'ping_unresponsive') {
        await interaction.deferReply({ flags: 64 });
        const result = await matchManager.pingUnresponsive(interaction.guildId, interaction.channelId);
        await interaction.editReply({ content: result });
        return;
      }

      if (id === 'cancel_match') {
        await interaction.deferReply({ flags: 64 });
        const result = await matchManager.cancelMatchFromChannel(interaction.channelId);
        await interaction.editReply({ content: result });
        return;
      }

    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_schedule_match') {
        await interaction.deferReply({ flags: 64 });
        const matchIdRaw = interaction.fields.getTextInputValue('match_id');
        const notes = interaction.fields.getTextInputValue('notes');
        try {
          const match = await matchManager.scheduleMatch({ matchInput: matchIdRaw, notes, requester: interaction.user, channel: interaction.channel, guild: interaction.guild });
          await interaction.editReply({ content: `Scheduled match: ${match.match_id}` });
        } catch (err) {
          console.error('schedule match error', err);
          await interaction.editReply({ content: `Failed to schedule match: ${err.message}` });
        }
        return;
      }

      if (interaction.customId === 'modal_configure_roles') {
        const role_main = interaction.fields.getTextInputValue('role_main');
        const role_bench = interaction.fields.getTextInputValue('role_bench');
        const role_staff = interaction.fields.getTextInputValue('role_staff');
        const category_matchday = interaction.fields.getTextInputValue('category_matchday');
        const cfg = (await storage.get('server_config')) || {};
        if (role_main) cfg.ROLE_MAIN_TEAM = role_main;
        if (role_bench) cfg.ROLE_SUBS_BENCH = role_bench;
        if (role_staff) cfg.ROLE_STAFF = role_staff;
        if (category_matchday) cfg.CATEGORY_MATCHDAY_ID = category_matchday;
        await storage.set('server_config', cfg);
        // update cached copy
        client.serverConfig = cfg;
        await interaction.reply({ content: 'Server configuration saved.', flags: 64 });
        return;
      }

      if (interaction.customId === 'modal_add_faceit_team') {
        await interaction.deferReply({ flags: 64 });
        const teamIdRaw = interaction.fields.getTextInputValue('faceit_team_id');
        // normalize team id for clearer messages
        let normalized = teamIdRaw.trim();
        try {
          if (normalized.startsWith('http')) {
            const u = new URL(normalized);
            const parts = u.pathname.split('/').filter(Boolean);
            normalized = parts[parts.length - 1];
          }
        } catch (e) { /* ignore */ }

        try {
          const found = await faceit.getTeamMatches(teamIdRaw);
          if (!found || found.length === 0) {
            console.warn('add faceit team: no fixtures found for', { input: teamIdRaw, normalized });
            await interaction.editReply({ content: `No fixtures found for '${teamIdRaw}'. I tried team id '${normalized}' on the Faceit API and found nothing. Please check you pasted the team slug (example: oldiebaldie) or the full team URL (https://www.faceit.com/en/teams/<slug>).` });
            return;
          }
          const fixtures = (await storage.get('fixtures')) || {};
          let added = 0;
          for (const f of found) {
            const mid = f.match_id;
            if (!fixtures[mid]) {
              fixtures[mid] = {
                match_id: mid,
                scheduled_at: f.scheduled_at ? new Date(f.scheduled_at).toISOString() : null,
                opponent: f.opponent || 'Unknown',
                teamId: normalized,
                posted: false,
                guildId: interaction.guild ? interaction.guild.id : null,
                channelId: interaction.channel ? interaction.channel.id : null,
                preferredChannel: null,
                notes: '',
              };
              added++;
            }
          }
          await storage.set('fixtures', fixtures);
          await interaction.editReply({ content: `Imported ${added} fixtures for team ${normalized}.` });
        } catch (e) {
          console.error('add faceit team error', e);
          await interaction.editReply({ content: `Failed to import fixtures: ${e.message}` });
        }
        return;
      }
    }

  } catch (err) {
    console.error('interaction handler error', err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'There was an error while handling this interaction.', flags: 64 });
      } else {
        await interaction.reply({ content: 'There was an error while handling this interaction.', flags: 64 });
      }
    } catch (e) {
      console.error('failed to send error reply', e);
    }
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (reaction.partial) await reaction.fetch();
    if (user.partial) await user.fetch();
    await matchManager.handleReactionAdd(reaction, user, client);
  } catch (err) {
    console.error('Failed to process reaction add', err);
  }
});

// small HTTP health endpoint for Render (and optional webservice)
const app = express();
app.get('/', (req, res) => res.send('OLDIEBALDIE bot running'));
app.get('/healthz', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`Health endpoint listening on ${HOST}:${PORT}`));

client.login(TOKEN);
