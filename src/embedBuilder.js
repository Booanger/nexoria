import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { groupSlotsByCategory } from './parser.js';

/**
 * Maps all weapons/roles to a single uniform emoji.
 * @param {string} roleName 
 * @returns {string}
 */
export function getWeaponEmoji(roleName) {
  return '⚔️';
}

/**
 * Builds the visual event Embed.
 * @param {object} event 
 * @returns {EmbedBuilder}
 */
export function buildEventEmbed(event) {
  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${event.title.toUpperCase()}`)
    .setDescription(event.description ? `📝 ${event.description}` : '📝 *No event description provided.*')
    .setColor('#F5A623') // Gold/Amber theme
    .setTimestamp();

  // Leader field
  embed.addFields({ name: '👑 Event Leader', value: `<@${event.leaderId}>`, inline: false });

  // Check if there are any custom categories defined
  const hasCategories = event.slots.some(s => s.category !== null && s.category !== undefined);

  if (!hasCategories) {
    // Simple format: List all roles under a single generic header "📌 Roles"
    let rolesValue = '';
    for (const slot of event.slots) {
      const userMention = slot.userId ? `<@${slot.userId}>` : '';
      rolesValue += `**${slot.name}**: ${userMention}\n`;
      if (slot.build) {
        rolesValue += `└ *${slot.build}*\n`;
      }
    }
    embed.addFields({ name: '📌 Roles', value: rolesValue || '*No roles specified*', inline: false });
  } else {
    // Advanced format: Group by categories
    const grouped = groupSlotsByCategory(event.slots);
    
    for (const [category, slots] of Object.entries(grouped)) {
      let categoryValue = '';
      
      for (const slot of slots) {
        const userMention = slot.userId ? `<@${slot.userId}>` : '';
        categoryValue += `**${slot.name}**: ${userMention}\n`;
        if (slot.build) {
          categoryValue += `└ *${slot.build}*\n`;
        }
      }
      
      const title = category === 'Genel' ? 'Roles' : category;
      embed.addFields({ name: `📌 ${title}`, value: categoryValue || '*Empty*', inline: false });
    }
  }

  // Progress Bar calculation
  const totalSlots = event.slots.length;
  const filledSlots = event.slots.filter(s => s.userId !== null).length;
  
  const size = 12; // Bar width
  const percentage = totalSlots > 0 ? filledSlots / totalSlots : 0;
  const progress = Math.round(size * percentage);
  const emptyProgress = size - progress;

  const progressText = '▰'.repeat(progress);
  const emptyProgressText = '▱'.repeat(emptyProgress);
  const percentText = Math.round(percentage * 100);

  embed.addFields({
    name: '\u200b',
    value: `**${filledSlots}/${totalSlots}** ${progressText}${emptyProgressText} (**${percentText}%**)`,
    inline: false
  });

  return embed;
}

/**
 * Builds interaction action rows (Select Menu + Buttons) for the event.
 * @param {object} event 
 * @returns {ActionRowBuilder[]}
 */
export function buildEventComponents(event) {
  // If there are no slots, we don't need a select menu
  if (!event.slots || event.slots.length === 0) {
    return [];
  }

  // StringSelectMenuBuilder options (Discord limit is 25)
  const selectOptions = event.slots.slice(0, 25).map(slot => {
    let label = slot.name;
    if (slot.category) {
      label = `[${slot.category}] ${label}`;
    }
    
    if (slot.userId) {
      label = `❌ [FILLED] ${label}`;
    }
    
    if (label.length > 80) {
      label = label.substring(0, 77) + '...';
    }
    
    let description = '';
    if (slot.userId) {
      description = `Player: ${slot.username}`;
    } else {
      description = slot.build ? slot.build : 'Select this vacant role.';
    }

    if (description.length > 95) {
      description = description.substring(0, 92) + '...';
    }

    return {
      label: label,
      value: slot.id,
      description: description
    };
  });

  // ActionRow 1: Select Menu
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`event_role_select:${event.id}`)
    .setPlaceholder('🛡️ Select a Role to Join...')
    .addOptions(selectOptions);

  const row1 = new ActionRowBuilder().addComponents(selectMenu);

  // ActionRow 2: Buttons
  const leaveButton = new ButtonBuilder()
    .setCustomId(`event_leave:${event.id}`)
    .setLabel('Leave')
    .setEmoji('🚪')
    .setStyle(ButtonStyle.Danger);

  const settingsButton = new ButtonBuilder()
    .setCustomId(`event_settings:${event.id}`)
    .setLabel('Settings')
    .setEmoji('⚙️')
    .setStyle(ButtonStyle.Primary);

  const row2 = new ActionRowBuilder().addComponents(settingsButton, leaveButton);

  return [row1, row2];
}
