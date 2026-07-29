const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('staff-ui').setDescription('Open the staff control panel'),
  execute: async (interaction) => {
    // permission check: admin or configured staff role
    const config = interaction.client.serverConfig || {};
    const staffRoleId = config.ROLE_STAFF;
    const isAdmin = interaction.member.permissions.has('Administrator');
    const isStaff = staffRoleId && interaction.member.roles.cache.has(staffRoleId);
    if (!isAdmin && !isStaff) {
      return interaction.reply({ content: 'You do not have permission to use this command.', flags: 64 });
    }

    // current configured roles (human readable)
    const mainName = config.ROLE_MAIN_TEAM ? (interaction.guild.roles.cache.get(config.ROLE_MAIN_TEAM)?.name || config.ROLE_MAIN_TEAM) : '_not set_';
    const benchName = config.ROLE_SUBS_BENCH ? (interaction.guild.roles.cache.get(config.ROLE_SUBS_BENCH)?.name || config.ROLE_SUBS_BENCH) : '_not set_';
    const staffName = config.ROLE_STAFF ? (interaction.guild.roles.cache.get(config.ROLE_STAFF)?.name || config.ROLE_STAFF) : '_not set_';
    const catName = config.CATEGORY_MATCHDAY_ID ? (interaction.guild.channels.cache.get(config.CATEGORY_MATCHDAY_ID)?.name || config.CATEGORY_MATCHDAY_ID) : '_not set_';

    const desc = `Use this panel to manage fixtures, schedule matches, and configure server roles.\n\nRoles status:\n• Main Team Role: ${mainName}\n• Subs Bench Role: ${benchName}\n• Staff Role: ${staffName}\n• Matchday Category: ${catName}\n\nAdd a FACEIT team to import upcoming fixtures automatically. Fixtures will be auto-posted 7 days before the match, or staff can post them manually.`;

    const embed = new EmbedBuilder()
      .setTitle('OLDIEBALDIE Staff Control Panel')
      .setDescription(desc)
      .setColor(0x00AE86);

    const logo = process.env.TEAM_LOGO_URL;
    if (logo) embed.setThumbnail(logo);

    // combine control buttons into one row (max components per message constraints)
    const controlRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('schedule_faceit_match').setLabel('Schedule').setStyle(ButtonStyle.Primary).setEmoji('🗓️'),
      new ButtonBuilder().setCustomId('add_faceit_team').setLabel('Add Team').setStyle(ButtonStyle.Primary).setEmoji('🧾'),
      new ButtonBuilder().setCustomId('browse_matches').setLabel('Matches').setStyle(ButtonStyle.Secondary).setEmoji('📅'),
      new ButtonBuilder().setCustomId('ping_unresponsive').setLabel('Ping').setStyle(ButtonStyle.Secondary).setEmoji('📣'),
      new ButtonBuilder().setCustomId('cancel_match').setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji('❌')
    );

    // role select menus (kept under a "Roles" section — still shown in the same panel so user can pick multiple)
    const roles = interaction.guild.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => ({ label: r.name.substring(0, 100), value: r.id }));
    const roleOptions = roles.slice(0, 25); // Discord limit
    const mainSelect = new StringSelectMenuBuilder().setCustomId('select_role_main').setPlaceholder(`Main Team Role: ${mainName}`).addOptions(roleOptions);
    const benchSelect = new StringSelectMenuBuilder().setCustomId('select_role_bench').setPlaceholder(`Subs Bench Role: ${benchName}`).addOptions(roleOptions);
    const staffSelect = new StringSelectMenuBuilder().setCustomId('select_role_staff').setPlaceholder(`Staff Role: ${staffName}`).addOptions(roleOptions);

    // category select (channels of type category)
    const categories = interaction.guild.channels.cache.filter(c => c.type === 4).map(c => ({ label: c.name.substring(0, 100), value: c.id }));
    const catOptions = categories.slice(0, 25);
    const catSelect = new StringSelectMenuBuilder().setCustomId('select_role_category').setPlaceholder(`Matchday Category: ${catName}`).addOptions(catOptions);

    const rows = [
      controlRow,
      new ActionRowBuilder().addComponents(mainSelect),
      new ActionRowBuilder().addComponents(benchSelect),
      new ActionRowBuilder().addComponents(staffSelect),
      new ActionRowBuilder().addComponents(catSelect),
    ];

    await interaction.reply({ embeds: [embed], components: rows, flags: 64 });
  }
};
