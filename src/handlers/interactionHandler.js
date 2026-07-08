import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { eventStore } from '../eventStore.js';
import { parseTemplate, reconstructTemplate } from '../parser.js';
import { buildEventEmbed, buildEventComponents } from '../embedBuilder.js';

/**
 * Main dispatcher for bot interactions.
 * @param {import('discord.js').Interaction} interaction 
 */
export async function handleInteraction(interaction) {
  // 1. Modal Submissions
  if (interaction.isModalSubmit()) {
    const customId = interaction.customId;

    if (customId === 'event_create_modal') {
      await handleEventCreateModal(interaction);
    } else if (customId.startsWith('event_edit_modal:')) {
      await handleEditModalSubmit(interaction);
    }
    return;
  }

  // 2. Button Clicks
  if (interaction.isButton()) {
    const customId = interaction.customId;
    if (customId.startsWith('event_leave:')) {
      await handleLeaveButton(interaction);
    } else if (customId.startsWith('event_settings:')) {
      await handleSettingsButton(interaction);
    } else if (customId.startsWith('control_close:')) {
      await handleControlClose(interaction);
    } else if (customId.startsWith('control_ping:')) {
      await handleControlPing(interaction);
    } else if (customId.startsWith('control_edit_event:')) {
      await handleControlEditEvent(interaction);
    }
    return;
  }

  // 3. Select Menu Selections
  if (interaction.isStringSelectMenu()) {
    const customId = interaction.customId;
    if (customId.startsWith('event_role_select:')) {
      await handleRoleSelect(interaction);
    }
    return;
  }
}

/**
 * Handles modal submit when creating an event.
 */
async function handleEventCreateModal(interaction) {
  await interaction.deferReply();

  const title = interaction.fields.getTextInputValue('modal_event_title');
  const description = interaction.fields.getTextInputValue('modal_event_desc') || '';
  const templateText = interaction.fields.getTextInputValue('modal_event_template');

  const slots = parseTemplate(templateText);

  if (slots.length === 0) {
    return interaction.editReply({ content: '❌ Error: No valid roles or slots could be parsed. Please check your template.' });
  }

  // Get active events by this user from Supabase
  const activeEventsOfUser = await eventStore.getEventsByLeader(interaction.user.id);
  activeEventsOfUser.sort((a, b) => a.createdAt - b.createdAt); // Sorted oldest first

  let autoClosedNotice = '';

  if (activeEventsOfUser.length >= 3) {
    const oldestEvent = activeEventsOfUser[0];
    
    // 1. Delete from database
    await eventStore.deleteEvent(oldestEvent.id);

    // 2. Try to close it visually on Discord
    try {
      const channel = await interaction.client.channels.fetch(oldestEvent.channelId);
      const message = await channel.messages.fetch(oldestEvent.id);
      
      const embed = EmbedBuilder.from(message.embeds[0])
        .setTitle(`🏁 EVENT ENDED: ${oldestEvent.title.toUpperCase()}`)
        .setColor('#7F8C8D') // Neutral gray color
        .setDescription(`⚙️ **This event has been automatically ended because a new event was created.**\n\n*Description: ${oldestEvent.description || 'None'}*`);

      await message.edit({
        embeds: [embed],
        components: []
      });
      autoClosedNotice = `⚠️ Your oldest event **${oldestEvent.title}** has been automatically closed.`;
      console.log(`[EventStore] Auto-closed oldest event: ${oldestEvent.id}`);
    } catch (error) {
      console.warn(`[EventStore] Could not auto-close oldest event message on Discord:`, error.message);
    }
  }

  const event = {
    id: null,
    title,
    description,
    leaderId: interaction.user.id,
    leaderUsername: interaction.user.username,
    slots,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    createdAt: Date.now() // Autosweep timestamp (48h retention)
  };

  // Embed creation
  const embed = buildEventEmbed(event);
  
  // Format response content to include @everyone ping above the embed
  let responseContent = '@everyone';
  if (autoClosedNotice) {
    responseContent = `@everyone\n${autoClosedNotice}`;
  }

  const replyMessage = await interaction.editReply({
    content: responseContent,
    embeds: [embed],
    fetchReply: true
  });

  event.id = replyMessage.id;
  await eventStore.saveEvent(event.id, event);

  const components = buildEventComponents(event);
  await interaction.editReply({
    components: components
  });
}

/**
 * Handles role selection from dropdown menu.
 */
async function handleRoleSelect(interaction) {
  const eventId = interaction.customId.split(':')[1];
  const event = await eventStore.getEvent(eventId);

  if (!event) {
    return interaction.reply({ content: '❌ Error: This event could not be found in the database.', flags: MessageFlags.Ephemeral });
  }

  const selectedSlotId = interaction.values[0];
  const userId = interaction.user.id;
  const username = interaction.user.username;

  const selectedSlot = event.slots.find(s => s.id === selectedSlotId);
  if (!selectedSlot) {
    return interaction.reply({ content: '❌ Error: Selected role could not be found.', flags: MessageFlags.Ephemeral });
  }

  // If slot is occupied, return error
  if (selectedSlot.userId) {
    if (selectedSlot.userId === userId) {
      return interaction.reply({ content: '⚠️ You are already occupying this role!', flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({
      content: `❌ This role is already taken by <@${selectedSlot.userId}>! Please select a vacant role.`,
      flags: MessageFlags.Ephemeral
    });
  }

  // Remove the user from any other slot they might be occupying in this event
  for (const slot of event.slots) {
    if (slot.userId === userId) {
      slot.userId = null;
      slot.username = null;
    }
  }

  selectedSlot.userId = userId;
  selectedSlot.username = username;

  await eventStore.saveEvent(eventId, event);

  const embed = buildEventEmbed(event);
  const components = buildEventComponents(event);

  await interaction.update({
    embeds: [embed],
    components: components
  });
}

/**
 * Handles leaving an event.
 */
async function handleLeaveButton(interaction) {
  const eventId = interaction.customId.split(':')[1];
  const event = await eventStore.getEvent(eventId);

  if (!event) {
    return interaction.reply({ content: '❌ Error: This event could not be found.', flags: MessageFlags.Ephemeral });
  }

  const userId = interaction.user.id;
  let occupiedAny = false;

  // Remove from main slots
  for (const slot of event.slots) {
    if (slot.userId === userId) {
      slot.userId = null;
      slot.username = null;
      occupiedAny = true;
    }
  }

  if (!occupiedAny) {
    return interaction.reply({ content: '⚠️ You are not registered for this event.', flags: MessageFlags.Ephemeral });
  }

  await eventStore.saveEvent(eventId, event);

  const embed = buildEventEmbed(event);
  const components = buildEventComponents(event);

  await interaction.update({
    embeds: [embed],
    components: components
  });
}

/**
 * Handles the leader settings control panel button.
 */
async function handleSettingsButton(interaction) {
  const eventId = interaction.customId.split(':')[1];
  const event = await eventStore.getEvent(eventId);

  if (!event) {
    return interaction.reply({ content: '❌ Error: This event could not be found.', flags: MessageFlags.Ephemeral });
  }

  if (interaction.user.id !== event.leaderId) {
    return interaction.reply({ content: '❌ Only the **Event Leader** (<@' + event.leaderId + '>) can use the Settings menu!', flags: MessageFlags.Ephemeral });
  }

  const closeBtn = new ButtonBuilder()
    .setCustomId(`control_close:${eventId}`)
    .setLabel('End Event')
    .setEmoji('🏁')
    .setStyle(ButtonStyle.Secondary);

  const pingBtn = new ButtonBuilder()
    .setCustomId(`control_ping:${eventId}`)
    .setLabel('Ping Group')
    .setEmoji('🔔')
    .setStyle(ButtonStyle.Secondary);

  const editEventBtn = new ButtonBuilder()
    .setCustomId(`control_edit_event:${eventId}`)
    .setLabel('Edit Event')
    .setEmoji('⚙️')
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(editEventBtn, pingBtn, closeBtn);

  await interaction.reply({
    content: '⚙️ **Event Control Panel**\nUse the buttons below to end the event, edit details, or ping all registered members.',
    components: [row],
    flags: MessageFlags.Ephemeral
  });
}

/**
 * Handles showing the full edit event modal to the leader.
 */
async function handleControlEditEvent(interaction) {
  const eventId = interaction.customId.split(':')[1];
  const event = await eventStore.getEvent(eventId);

  if (!event) {
    return interaction.reply({ content: '❌ Event not found.', flags: MessageFlags.Ephemeral });
  }

  const modal = new ModalBuilder()
    .setCustomId(`event_edit_modal:${eventId}`)
    .setTitle('Edit Event');

  const titleInput = new TextInputBuilder()
    .setCustomId('modal_edit_title')
    .setLabel('Event Title')
    .setValue(event.title)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const descInput = new TextInputBuilder()
    .setCustomId('modal_edit_desc')
    .setLabel('Event Description')
    .setValue(event.description || '')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000);

  const reconstructedTemplate = reconstructTemplate(event.slots);

  const templateInput = new TextInputBuilder()
    .setCustomId('modal_edit_template')
    .setLabel('Roles')
    .setValue(reconstructedTemplate)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(2000);

  const row1 = new ActionRowBuilder().addComponents(titleInput);
  const row2 = new ActionRowBuilder().addComponents(descInput);
  const row3 = new ActionRowBuilder().addComponents(templateInput);

  modal.addComponents(row1, row2, row3);

  await interaction.showModal(modal);
}

/**
 * Handles the submission of the edit event modal.
 */
async function handleEditModalSubmit(interaction) {
  const eventId = interaction.customId.split(':')[1];
  const event = await eventStore.getEvent(eventId);

  if (!event) {
    return interaction.reply({ content: '❌ Event not found.', flags: MessageFlags.Ephemeral });
  }

  const title = interaction.fields.getTextInputValue('modal_edit_title');
  const description = interaction.fields.getTextInputValue('modal_edit_desc') || '';
  const templateText = interaction.fields.getTextInputValue('modal_edit_template');

  const newSlots = parseTemplate(templateText);
  if (newSlots.length === 0) {
    return interaction.reply({ content: '❌ Error: No roles could be parsed from the template. Edit failed.', flags: MessageFlags.Ephemeral });
  }

  const oldSlots = event.slots;

  // Preserve player assignments by slot matching
  const occupiedOldSlots = oldSlots.filter(s => s.userId !== null);
  for (const oldSlot of occupiedOldSlots) {
    let matchingNewSlot = newSlots.find(s => s.name === oldSlot.name && s.category === oldSlot.category && s.userId === null);
    if (!matchingNewSlot) {
      matchingNewSlot = newSlots.find(s => s.name === oldSlot.name && s.userId === null);
    }

    if (matchingNewSlot) {
      matchingNewSlot.userId = oldSlot.userId;
      matchingNewSlot.username = oldSlot.username;
    }
  }

  event.title = title;
  event.description = description;
  event.slots = newSlots;

  await eventStore.saveEvent(eventId, event);

  const channel = await interaction.client.channels.fetch(event.channelId);
  const message = await channel.messages.fetch(eventId);

  const embed = buildEventEmbed(event);
  const components = buildEventComponents(event);

  await message.edit({
    embeds: [embed],
    components: components
  });

  await interaction.reply({ content: '✅ Event successfully updated. Roster preserved!', flags: MessageFlags.Ephemeral });
}

/**
 * Handles the leader finishing/closing the event.
 */
async function handleControlClose(interaction) {
  const eventId = interaction.customId.split(':')[1];
  const event = await eventStore.getEvent(eventId);

  if (!event) {
    return interaction.reply({ content: '❌ Event already closed or not found.', flags: MessageFlags.Ephemeral });
  }

  await eventStore.deleteEvent(eventId);

  const channel = await interaction.client.channels.fetch(event.channelId);
  const message = await channel.messages.fetch(eventId);

  const embed = EmbedBuilder.from(message.embeds[0])
    .setTitle(`🏁 EVENT ENDED: ${event.title.toUpperCase()}`)
    .setColor('#7F8C8D') // Neutral gray color
    .setDescription(`⚙️ **This event has ended.**\n\n*Description: ${event.description || 'None'}*`);

  await message.edit({
    content: null, // Remove @everyone ping from content when ended
    embeds: [embed],
    components: []
  });

  await interaction.update({
    content: '🏁 Event has ended and registration is closed.',
    components: [],
    flags: MessageFlags.Ephemeral
  });
}

/**
 * Handles the leader pinging all participants.
 */
async function handleControlPing(interaction) {
  const eventId = interaction.customId.split(':')[1];
  const event = await eventStore.getEvent(eventId);

  if (!event) {
    return interaction.reply({ content: '❌ Event not found.', flags: MessageFlags.Ephemeral });
  }

  const userIds = new Set();
  for (const slot of event.slots) {
    if (slot.userId) {
      userIds.add(slot.userId);
    }
  }

  if (userIds.size === 0) {
    return interaction.reply({ content: '⚠️ No players are registered in this event. Ping aborted.', flags: MessageFlags.Ephemeral });
  }

  const mentions = Array.from(userIds).map(id => `<@${id}>`).join(' ');

  const channel = await interaction.client.channels.fetch(event.channelId);
  await channel.send({
    content: `🔔 Gathering for **${event.title.toUpperCase()}**!\nPlayers: ${mentions}\nLeader: <@${event.leaderId}>`
  });

  await interaction.update({
    content: '🔔 Group pinged successfully!',
    components: [],
    flags: MessageFlags.Ephemeral
  });
}
