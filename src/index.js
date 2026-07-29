const express = require('express');
const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const storage = require('./config/storage');
const { deployGuildCommands } = require('./utils/commandDeployer');
const matchManager = require('./services/matchManager');
const scheduler = require('./services/scheduler');

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
      if (interaction.customId === 'select_timezone') {
        const tz = interaction.values[0];
        await storage.set(`tz_${interaction.user.id}`, tz);
        await interaction.update({ content: `Timezone saved: ${tz}`, components: [], ephemeral: true });
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

      if (id === 'configure_roles') {
        const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
        const modal = new ModalBuilder().setCustomId('modal_configure_roles').setTitle('Configure Server Roles / Category');
        const mainRole = new TextInputBuilder().setCustomId('role_main').setLabel('Main Team Role ID').setStyle(TextInputStyle.Short).setRequired(false);
        const benchRole = new TextInputBuilder().setCustomId('role_bench').setLabel('Subs Bench Role ID').setStyle(TextInputStyle.Short).setRequired(false);
        const staffRole = new TextInputBuilder().setCustomId('role_staff').setLabel('Staff Role ID').setStyle(TextInputStyle.Short).setRequired(false);
        const categoryId = new TextInputBuilder().setCustomId('category_matchday').setLabel('Matchday Category ID').setStyle(TextInputStyle.Short).setRequired(false);
        modal.addComponents(new ActionRowBuilder().addComponents(mainRole), new ActionRowBuilder().addComponents(benchRole), new ActionRowBuilder().addComponents(staffRole), new ActionRowBuilder().addComponents(categoryId));
        await interaction.showModal(modal);
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
