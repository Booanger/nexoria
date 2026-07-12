import { Client, GatewayIntentBits, REST, Routes, MessageFlags } from 'discord.js';
import { config } from './config.js';
import * as createContent from './commands/createContent.js';
import { handleInteraction } from './handlers/interactionHandler.js';
import http from 'http';

// 📡 Keep-alive HTTP server for Render deployment
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running and awake!');
}).listen(PORT, () => {
  console.log(`📡 Keep-alive web server is listening on port ${PORT}`);
});

// Initialize Discord Client with basic Guild permissions
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// Command registry mapping
const commands = new Map();
commands.set(createContent.data.name, createContent);

/**
 * Registers application commands globally to Discord's API.
 */
async function registerCommands() {
  if (!config.token || !config.clientId) {
    console.error('❌ Slash komutları kaydedilemedi: Token veya Client ID eksik.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(config.token);
  const commandJSON = Array.from(commands.values()).map(cmd => cmd.data.toJSON());

  try {
    console.log('🔄 Slash komutları Discord\'a kaydediliyor...');
    await rest.put(
      Routes.applicationCommands(config.clientId),
      { body: commandJSON }
    );
    console.log('✅ Slash komutları başarıyla kaydedildi!');
  } catch (error) {
    console.error('❌ Slash komutları kaydedilirken hata oluştu:', error);
  }
}

/**
 * Verifies if the bot is in any unauthorized server and leaves it.
 */
async function checkGuildsAccess() {
  const allowedGuilds = config.allowedGuilds || [];
  if (allowedGuilds.length === 0) {
    console.log('📡 Access Control: No ALLOWED_GUILDS whitelist configured. The bot will run on any server.');
    return;
  }

  const guilds = client.guilds.cache;
  for (const [guildId, guild] of guilds) {
    if (!allowedGuilds.includes(guildId)) {
      console.warn(`⚠️ Access Control: Bot is on an unauthorized server: ${guild.name} (${guildId}). Leaving...`);
      try {
        await guild.leave();
        console.log(`✅ Access Control: Successfully left unauthorized server: ${guild.name}`);
      } catch (error) {
        console.error(`❌ Access Control: Failed to leave server ${guild.name} (${guildId}):`, error.message);
      }
    }
  }
}

// Client ready event
client.once('clientReady', async () => {
  console.log(`🤖 Bot hazır! Giriş yapan hesap: ${client.user.tag}`);
  await checkGuildsAccess();
  await registerCommands();
});

// Check access when invited to a new server
client.on('guildCreate', async (guild) => {
  const allowedGuilds = config.allowedGuilds || [];
  if (allowedGuilds.length > 0 && !allowedGuilds.includes(guild.id)) {
    console.warn(`⚠️ Access Control: Bot was invited to an unauthorized server: ${guild.name} (${guild.id}). Leaving immediately...`);
    try {
      await guild.leave();
      console.log(`✅ Access Control: Successfully left unauthorized server: ${guild.name}`);
    } catch (error) {
      console.error(`❌ Access Control: Failed to leave server ${guild.name} (${guild.id}):`, error.message);
    }
  } else {
    console.log(`📡 Access Control: Bot joined an authorized server: ${guild.name} (${guild.id})`);
  }
});

// Global interaction listener
client.on('interactionCreate', async (interaction) => {
  try {
    // 1. Handle Slash Commands
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) return;

      console.log(`⚡ Komut çalıştırıldı: /${interaction.commandName} (Kullanıcı: ${interaction.user.tag})`);
      await command.execute(interaction);
      return;
    }

    // 2. Handle Buttons, Select Menus, Modals
    await handleInteraction(interaction);
  } catch (error) {
    console.error('💥 Bir etkileşim işlenirken beklenmedik hata oluştu:', error);
    
    try {
      const errorMsg = '⚠️ Bu işlem sırasında beklenmedik bir hata oluştu.';
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: errorMsg, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      // Catch double-response crashes
    }
  }
});

// Global unhandled promise rejection listener
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Launch Bot
if (config.token) {
  client.login(config.token);
} else {
  console.error('❌ DISCORD_TOKEN bulunamadığı için bot başlatılamadı!');
}
