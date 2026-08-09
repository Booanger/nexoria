import { Client, GatewayIntentBits, REST, Routes, MessageFlags, Events, version as discordJsVersion } from 'discord.js';
import { config } from './config.js';
import * as createContent from './commands/createContent.js';
import { handleInteraction } from './handlers/interactionHandler.js';
import { createHealthServer } from './healthServer.js';

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const DISCORD_READY_TIMEOUT_MS = 45_000;
const DISCORD_RECONNECT_TIMEOUT_MS = 90_000;
const DISCORD_API_TIMEOUT_MS = 15_000;

// Initialize Discord Client with basic Guild permissions
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

let discordState = 'starting';
let connectionDeadline = null;
let shuttingDown = false;
let startupTasksCompleted = false;

const healthServer = createHealthServer({
  getDiscordStatus: () => ({
    ready: client.isReady(),
    state: client.isReady() ? 'connected' : discordState
  })
});

healthServer.on('error', (error) => {
  console.error('❌ HTTP health server hatası:', error);
  void shutdown(1, 'HTTP health server failed');
});

healthServer.listen(PORT, () => {
  console.log(`📡 Health server ${PORT} portunda dinleniyor (/health).`);
});

function clearConnectionDeadline() {
  if (connectionDeadline) {
    clearTimeout(connectionDeadline);
    connectionDeadline = null;
  }
}

function setConnectionDeadline(timeoutMs, reason) {
  clearConnectionDeadline();
  connectionDeadline = setTimeout(() => {
    if (!client.isReady()) {
      console.error(`❌ Discord ${reason}; ${timeoutMs / 1000} saniye içinde hazır olmadı. Süreç yeniden başlatılıyor.`);
      void shutdown(1, `Discord ${reason}`);
    }
  }, timeoutMs);
}

async function shutdown(exitCode, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  discordState = 'stopping';
  clearConnectionDeadline();
  console.log(`🛑 Kapatılıyor: ${reason}`);

  if (client.token) {
    try {
      client.destroy();
    } catch (error) {
      console.error('Discord istemcisi kapatılırken hata oluştu:', error);
    }
  }

  healthServer.close();
  setTimeout(() => process.exit(exitCode), 5_000).unref();
}

async function fetchDiscordApi(path) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${config.token}` },
    signal: AbortSignal.timeout(DISCORD_API_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`Discord API ${path} isteği HTTP ${response.status} döndürdü.`);
  }

  return response.json();
}

async function verifyDiscordCredentials() {
  discordState = 'validating';
  console.log('🔐 Production Discord tokenı ve gateway erişimi doğrulanıyor...');

  // Sequential requests avoid leaving a second request open when a bad token
  // immediately returns 401 on the first one.
  const botUser = await fetchDiscordApi('/users/@me');
  const gateway = await fetchDiscordApi('/gateway/bot');

  if (config.clientId && botUser.id !== config.clientId) {
    throw new Error('DISCORD_TOKEN başka bir bota ait: Render CLIENT_ID ile token kimliği eşleşmiyor.');
  }

  const remaining = gateway.session_start_limit?.remaining;
  const sessionInfo = Number.isInteger(remaining) ? `, kalan gateway oturumu: ${remaining}` : '';
  console.log(`✅ Discord tokenı doğrulandı: ${botUser.username}${sessionInfo}`);
}

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

// Client ready event (also fires after a full gateway reconnection)
client.on(Events.ClientReady, async (readyClient) => {
  discordState = 'connected';
  clearConnectionDeadline();
  console.log(`🤖 Discord bağlantısı hazır! Giriş yapan hesap: ${readyClient.user.tag}`);

  if (startupTasksCompleted) return;
  startupTasksCompleted = true;

  try {
    await checkGuildsAccess();
    await registerCommands();
  } catch (error) {
    console.error('❌ Discord başlangıç işlemleri başarısız oldu:', error);
  }
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

// Discord Client Error & Reconnection Handling
client.on('error', (error) => {
  console.error('❌ Discord client hatası:', error);
});

client.on('shardError', (error) => {
  console.error('❌ Discord WebSocket (shard) hatası:', error);
});

client.on('shardDisconnect', (event, shardId) => {
  if (shuttingDown) return;
  discordState = 'disconnected';
  console.warn(`⚠️ Discord bağlantısı koptu (Shard: ${shardId}, Kod: ${event?.code}). Yeniden bağlanmaya çalışılıyor...`);
  setConnectionDeadline(DISCORD_RECONNECT_TIMEOUT_MS, 'yeniden bağlantısı zaman aşımına uğradı');
});

client.on('shardReconnecting', (shardId) => {
  if (shuttingDown) return;
  discordState = 'reconnecting';
  console.warn(`🔄 Discord shard ${shardId} yeniden bağlanıyor...`);
});

client.on('shardResume', (shardId, replayedEvents) => {
  if (shuttingDown) return;
  discordState = 'connected';
  clearConnectionDeadline();
  console.log(`✅ Discord shard ${shardId} bağlantısı devam ettirildi (${replayedEvents} olay tekrarlandı).`);
});

if (process.env.DISCORD_DEBUG === 'true') {
  client.on('debug', (message) => console.log(`[Discord Debug] ${message}`));
}

process.on('unhandledRejection', (reason) => {
  console.error('❌ İşlenmeyen Promise hatası:', reason);
  void shutdown(1, 'Unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  console.error('❌ Yakalanmayan uygulama hatası:', error);
  void shutdown(1, 'Uncaught exception');
});

process.on('SIGTERM', () => void shutdown(0, 'SIGTERM'));
process.on('SIGINT', () => void shutdown(0, 'SIGINT'));

async function launchBot() {
  if (!config.token) {
    console.error('❌ DISCORD_TOKEN bulunamadığı için bot başlatılamadı!');
    await shutdown(1, 'DISCORD_TOKEN is missing');
    return;
  }

  discordState = 'connecting';
  console.log(`[Startup] Node ${process.version}, discord.js ${discordJsVersion}`);

  try {
    await verifyDiscordCredentials();
  } catch (error) {
    console.error('❌ Discord production kimlik/ağ doğrulaması başarısız:', error.message);
    await shutdown(1, 'Discord credential verification failed');
    return;
  }

  discordState = 'connecting';
  console.log('🔌 Discord bağlantısı başlatılıyor...');
  setConnectionDeadline(DISCORD_READY_TIMEOUT_MS, 'ilk bağlantısı zaman aşımına uğradı');
  client.login(config.token).catch((error) => {
    console.error('❌ Discord login başarısız oldu! Token veya ağ hatası:', error.message);
    void shutdown(1, 'Discord login failed');
  });
}

void launchBot();
