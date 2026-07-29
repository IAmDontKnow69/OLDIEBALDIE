    // Button handlers from /staff-ui
    if (interaction.isButton()) {
      const id = interaction.customId;

      // permission check for buttons: ensure only admins or staff role can use
      const cfg = (await storage.get('server_config')) || {};
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
