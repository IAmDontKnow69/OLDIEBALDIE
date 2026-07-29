const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const storage = require('../config/storage');

module.exports = {
  data: new SlashCommandBuilder().setName('timezone').setDescription('Set your local timezone'),
  execute: async (interaction) => {
    const options = [
      { label: 'UK / GMT', value: 'GMT' },
      { label: 'CET', value: 'CET' },
      { label: 'EST', value: 'EST' },
      { label: 'CST', value: 'CST' },
      { label: 'PST', value: 'PST' },
    ];

    const menu = new StringSelectMenuBuilder()
      .setCustomId('select_timezone')
      .setPlaceholder('Choose your timezone')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options.map(o => ({ label: o.label, value: o.value })));

    const row = new ActionRowBuilder().addComponents(menu);

    await interaction.reply({ content: 'Select your timezone:', components: [row], ephemeral: true });
  }
};
