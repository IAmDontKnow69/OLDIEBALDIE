const { Client, GatewayIntentBits, Partials, Collection, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const storage = require('./config/storage');
const { deployGuildCommands } = require('./utils/commandDeployer');

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
  // Deploy guild commands for development
  if (GUILD_ID) {
    await deployGuildCommands(GUILD_ID, client.commands.map(c => c.data));
    console.log('Deployed guild commands to', GUILD_ID);
  }

  // TODO: start background services like faceit polling, reminders
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = client.commands.get(interaction.commandName);
      if (!cmd) return;
      await cmd.execute(interaction, client);
    }

    // String select menu / modal / button handlers are inside commands where needed
  } catch (err) {
    console.error('interaction handler error', err);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: 'There was an error while executing this command.', ephemeral: true });
    } else {
      await interaction.reply({ content: 'There was an error while executing this command.', ephemeral: true });
    }
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  // Reaction partials handling
  try {
    if (reaction.partial) await reaction.fetch();
    if (user.partial) await user.fetch();
    // TODO: delegate to matchManager
  } catch (err) {
    console.error('Failed to process reaction add', err);
  }
});

client.login(TOKEN);
