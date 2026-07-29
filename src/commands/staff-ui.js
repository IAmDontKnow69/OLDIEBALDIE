const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('staff-ui').setDescription('Open the staff control panel'),
  execute: async (interaction) => {
    // permission check: admin or configured staff role
    const config = interaction.client.serverConfig || {};
    const staffRoleId = config.ROLE_STAFF;
    const isAdmin = interaction.member.permissions.has('Administrator');
    const isStaff = staffRoleId && interaction.member.roles.cache.has(staffRoleId);
    if (!isAdmin && !isStaff) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('OLDIEBALDIE Staff Control Panel')
      .setDescription('Use this panel to manage fixtures, schedule matches, and configure server roles. Add a FACEIT team to import upcoming fixtures automatically. Fixtures will be auto-posted 7 days before the match, or staff can post them manually.')
      .setColor(0x00AE86)
      .setThumbnail(process.env.TEAM_LOGO_URL || '');

    const scheduleRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('schedule_faceit_match').setLabel('Schedule FACEIT Match').setStyle(ButtonStyle.Primary).setEmoji('🗓️'),
      new ButtonBuilder().setCustomId('add_faceit_team').setLabel('Add FACEIT Team').setStyle(ButtonStyle.Primary).setEmoji('🧾'),
      new ButtonBuilder().setCustomId('show_fixtures').setLabel('View Fixtures').setStyle(ButtonStyle.Secondary).setEmoji('📅')
    );

    const matchesRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('list_matches').setLabel('Matches').setStyle(ButtonStyle.Secondary).setEmoji('📌'),
      new ButtonBuilder().setCustomId('ping_unresponsive').setLabel('Ping Unresponsive').setStyle(ButtonStyle.Secondary).setEmoji('📣'),
      new ButtonBuilder().setCustomId('cancel_match').setLabel('Cancel Match').setStyle(ButtonStyle.Danger).setEmoji('❌')
    );

    const adminRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('configure_roles').setLabel('Configure Roles').setStyle(ButtonStyle.Primary).setEmoji('⚙️')
    );

    // reply immediately (synchronous operations only) so Discord doesn't time out
    await interaction.reply({ embeds: [embed], components: [scheduleRow, matchesRow, adminRow], ephemeral: true });
  }
};
