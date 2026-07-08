import { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('create-content')
  .setDescription('Creates a new MMO and Albion Online event using templates.');

/**
 * Executes the /create-content command by showing a modal to the user.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction 
 */
export async function execute(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('event_create_modal')
    .setTitle('Create New Event');

  const titleInput = new TextInputBuilder()
    .setCustomId('modal_event_title')
    .setLabel('Event Title')
    .setPlaceholder('e.g. T6 STATIC, ZvZ, Hellgate 5v5')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const descInput = new TextInputBuilder()
    .setCustomId('modal_event_desc')
    .setLabel('Event Description')
    .setPlaceholder('Event time, meeting location, hub city, and other details...')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000);

  const templateInput = new TextInputBuilder()
    .setCustomId('modal_event_template')
    .setLabel('Roles')
    .setPlaceholder('#Tanks\nMace > Cleric cowl\n#Healers\nHallowfall\n#DPS\nLight Crossbow')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(2000);

  // Each text input must be in its own ActionRow
  const row1 = new ActionRowBuilder().addComponents(titleInput);
  const row2 = new ActionRowBuilder().addComponents(descInput);
  const row3 = new ActionRowBuilder().addComponents(templateInput);

  modal.addComponents(row1, row2, row3);

  // Show the modal to the user
  await interaction.showModal(modal);
}
