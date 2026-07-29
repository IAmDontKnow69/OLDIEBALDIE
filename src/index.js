const express = require('express');
const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
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

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = client.commands.get(interaction.commandName);
      if (!cmd) return;
      await cmd.execute(interaction, client);
      return;
    }

    // Handle timezone select menu
    if (interaction.isStringSelectMenu()) {
      // role/category selects and timezone select handling
      if (interaction.customId === 'select_timezone') {
        const tz = interaction.values[0];
        await storage.set(`tz_${interaction.user.id}`, tz);
        await interaction.update({ content: `Timezone saved: ${tz}`, components: [], ephemeral: true });
        return;
      }

      if (interaction.customId.startsWith('select_role_')) {
        const which = interaction.customId.replace('select_role_', ''); // main, bench, staff
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
        await interaction.update({ content: 'Server configuration updated.', components: [], ephemeral: true });
        return;
      }

    }

    // Button handlers from /staff-ui
    if (interaction.isButton()) {
      const id = interaction.customId;

      // permission check for buttons: ensure only admins or staff role can use
      const cfg = client.serverConfig || (await storage.get('server_config')) || {};
      const staffRoleId = cfg.ROLE_STAFF;
      const isAdmin = interaction.member.permissions.has('Administrator');
      const isStaff = staffRoleId && interaction.member.roles.cache.has(staffRoleId);
      if (!isAdmin && !isStaff) {
        return interaction.reply({ content: 'You do not have permission to use this control.', ephemeral: true });
      }

      // Add FACEIT Team -> show modal
      if (id === 'add_faceit_team') {
        const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
        const modal = new ModalBuilder().setCustomId('modal_add_faceit_team').setTitle('Import FACEIT Team Fixtures');
        const teamInput = new TextInputBuilder().setCustomId('faceit_team_id').setLabel('FACEIT Team ID or URL').setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(teamInput));
        await interaction.showModal(modal);
        return;
      }

      // Show Fixtures
      if (id === 'show_fixtures') {
        await interaction.deferReply({ ephemeral: true });
        const fixtures = (await storage.get('fixtures')) || {};
        const guildFixtures = Object.values(fixtures).filter(f => !interaction.guild || f.guildId === interaction.guild.id);
        if (guildFixtures.length === 0) {
          await interaction.editReply({ content: 'No fixtures found.', ephemeral: true });
          return;
        }
        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
        const embed = new EmbedBuilder().setTitle('Upcoming Fixtures').setDescription('Showing up to 10 upcoming fixtures').setColor(0x00AE86);
        guildFixtures.slice(0, 10).forEach(f => {
          embed.addFields({ name: `${f.match_id} — ${f.opponent || 'Unknown'}`, value: `Date: ${f.scheduled_at || 'Unknown'}\nPosted: ${f.posted ? 'Yes' : 'No'}` });
        });
        const components = [];
        // limit buttons to first 5 fixtures to stay within component limits
        for (const f of guildFixtures.slice(0, 5)) {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`post_fixture:${f.match_id}`).setLabel('Post Now').setStyle(ButtonStyle.Primary).setEmoji('📣'),
            new ButtonBuilder().setCustomId(`delete_fixture:${f.match_id}`).setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
          );
          components.push(row);
        }
        await interaction.editReply({ embeds: [embed], components, ephemeral: true });
        return;
      }

      // Post fixture button
      if (id.startsWith('post_fixture:')) {
        await interaction.deferReply({ ephemeral: true });
        const matchId = id.split(':').slice(1).join(':');
        const fixtures = (await storage.get('fixtures')) || {};
        const fx = fixtures[matchId];
        if (!fx) {
          await interaction.editReply({ content: 'Fixture not found', ephemeral: true });
          return;
        }
        try {
          const ch = fx.preferredChannel ? await client.channels.fetch(fx.preferredChannel) : (fx.channelId ? await client.channels.fetch(fx.channelId) : interaction.channel);
          const guild = fx.guildId ? await client.guilds.fetch(fx.guildId) : interaction.guild;
          await matchManager.scheduleMatch({ matchInput: matchId, notes: fx.notes || '', requester: interaction.user, channel: ch, guild });
          fx.posted = true;
          await storage.set('fixtures', fixtures);
          await interaction.editReply({ content: 'Fixture posted successfully', ephemeral: true });
        } catch (e) {
          console.error('post fixture error', e);
          await interaction.editReply({ content: `Failed to post fixture: ${e.message}`, ephemeral: true });
        }
        return;
      }

      // Delete fixture
      if (id.startsWith('delete_fixture:')) {
        const matchId = id.split(':').slice(1).join(':');
        const fixtures = (await storage.get('fixtures')) || {};
        if (fixtures[matchId]) delete fixtures[matchId];
        await storage.set('fixtures', fixtures);
        await interaction.reply({ content: 'Deleted fixture', ephemeral: true });
        return;
      }

      if (id === 'schedule_faceit_match') {
        // Open modal (must respond within 3s)
        const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
        const modal = new ModalBuilder().setCustomId('modal_schedule_match').setTitle('Schedule FACEIT Match');
        const matchInput = new TextInputBuilder().setCustomId('match_id').setLabel('FACEIT Match ID or URL').setStyle(TextInputStyle.Short).setRequired(true);
        const notesInput = new TextInputBuilder().setCustomId('notes').setLabel('Special Notes (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false);
        modal.addComponents(new ActionRowBuilder().addComponents(matchInput), new ActionRowBuilder().addComponents(notesInput));
        await interaction.showModal(modal);
        return;
      }

      if (id === 'list_matches') {
        await interaction.deferReply({ ephemeral: true });
        const matches = (await storage.get('matches')) || {};
        const items = Object.values(matches).slice(0, 20);
        if (items.length === 0) {
          await interaction.editReply({ content: 'No posted matches found.', ephemeral: true });
          return;
        }
        const { EmbedBuilder } = require('discord.js');
        const embed = new EmbedBuilder().setTitle('Posted Matches').setColor(0x00AE86);
        items.forEach(m => embed.addFields({ name: `${m.match_id} — ${m.opponent || 'Unknown'}`, value: `Date: ${m.scheduled_at || 'Unknown'}\nStatus: ${m.status || 'Unknown'}` }));
        await interaction.editReply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (id === 'ping_unresponsive') {
        await interaction.deferReply({ ephemeral: true });
        const result = await matchManager.pingUnresponsive(interaction.guildId, interaction.channelId);
        await interaction.editReply({ content: result, ephemeral: true });
        return;
      }

      if (id === 'cancel_match') {
        await interaction.deferReply({ ephemeral: true });
        const result = await matchManager.cancelMatchFromChannel(interaction.channelId);
        await interaction.editReply({ content: result, ephemeral: true });
        return;
      }

      if (id === 'configure_roles') {
        // present role select menus + category select
        const { ActionRowBuilder, StringSelectMenuBuilder, ChannelType } = require('discord.js');
        const roles = interaction.guild.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => ({ label: r.name.substring(0, 100), value: r.id }));
        const roleChunks = roles.slice(0, 25); // Discord limit
        const mainSelect = new StringSelectMenuBuilder().setCustomId('select_role_main').setPlaceholder('Select Main Team Role').addOptions(roleChunks);
        const benchSelect = new StringSelectMenuBuilder().setCustomId('select_role_bench').setPlaceholder('Select Subs Bench Role').addOptions(roleChunks);
        const staffSelect = new StringSelectMenuBuilder().setCustomId('select_role_staff').setPlaceholder('Select Staff Role').addOptions(roleChunks);
        // categories
        const categories = interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).map(c => ({ label: c.name.substring(0, 100), value: c.id }));
        const catOptions = categories.slice(0, 25);
        const catSelect = new StringSelectMenuBuilder().setCustomId('select_role_category').setPlaceholder('Select Matchday Category').addOptions(catOptions);
        const rows = [
          new ActionRowBuilder().addComponents(mainSelect),
          new ActionRowBuilder().addComponents(benchSelect),
          new ActionRowBuilder().addComponents(staffSelect),
          new ActionRowBuilder().addComponents(catSelect),
        ];
        await interaction.reply({ content: 'Select roles and category to configure (select one per menu).', components: rows, ephemeral: true });
        return;
      }
    }

    // Modal submissions
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_schedule_match') {
        await interaction.deferReply({ ephemeral: true });
        const matchIdRaw = interaction.fields.getTextInputValue('match_id');
        const notes = interaction.fields.getTextInputValue('notes');
        try {
          const match = await matchManager.scheduleMatch({ matchInput: matchIdRaw, notes, requester: interaction.user, channel: interaction.channel, guild: interaction.guild });
          await interaction.editReply({ content: `Scheduled match: ${match.match_id}`, ephemeral: true });
        } catch (err) {
          console.error('schedule match error', err);
          await interaction.editReply({ content: `Failed to schedule match: ${err.message}`, ephemeral: true });
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
        await interaction.reply({ content: 'Server configuration saved.', ephemeral: true });
        return;
      }

      if (interaction.customId === 'modal_add_faceit_team') {
        await interaction.deferReply({ ephemeral: true });
        const teamIdRaw = interaction.fields.getTextInputValue('faceit_team_id');
        const teamId = teamIdRaw.trim().split('/').pop();
        try {
          const found = await faceit.getTeamMatches(teamId);
          if (!found || found.length === 0) {
            await interaction.editReply({ content: 'No fixtures found for that team.', ephemeral: true });
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
                teamId,
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
          await interaction.editReply({ content: `Imported ${added} fixtures for team ${teamId}.`, ephemeral: true });
        } catch (e) {
          console.error('add faceit team error', e);
          await interaction.editReply({ content: `Failed to import fixtures: ${e.message}`, ephemeral: true });
        }
        return;
      }
    }

  } catch (err) {
    console.error('interaction handler error', err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'There was an error while handling this interaction.', ephemeral: true });
      } else {
        await interaction.reply({ content: 'There was an error while handling this interaction.', ephemeral: true });
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
