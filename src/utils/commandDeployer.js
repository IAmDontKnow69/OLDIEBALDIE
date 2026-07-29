// Utility to deploy commands to a guild for fast iteration
const { REST, Routes } = require('discord.js');
require('dotenv').config();
const TOKEN = process.env.DISCORD_TOKEN;
const rest = new REST({ version: '10' }).setToken(TOKEN);

async function deployGuildCommands(guildId, commandsData) {
  if (!TOKEN || !guildId) return;
  try {
    await rest.put(Routes.applicationGuildCommands((await rest.get('/oauth2/applications/@me')).id, guildId), { body: commandsData });
  } catch (err) {
    console.warn('Failed to deploy guild commands', err?.message || err);
  }
}

module.exports = { deployGuildCommands };
