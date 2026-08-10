import {
  Client,
  DiscordjsErrorCodes,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  version as discordJsVersion
} from 'discord.js';
import { config } from './config.js';
import * as createContent from './commands/createContent.js';
import { eventStore } from './eventStore.js';
import { handleInteraction } from './handlers/interactionHandler.js';
import { createHealthServer } from './healthServer.js';

const parsedPort = Number.parseInt(process.env.PORT || '10000', 10);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 10000;
const LOGIN_RETRY_BASE_MS = 30_000;
const LOGIN_RETRY_MAX_MS = 5 * 60_000;

// Initialize Discord Client with basic Guild permissions
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

let discordState = 'starting';
let shuttingDown = false;
let startupTasksCompleted = false;

const healthServer = createHealthServer({
  getDiscordStatus: () => ({
    connected: client.isReady(),
    state: client.isReady() ? 'connected' : discordState
  })
});

healthServer.on('error', (error) => {
  console.error('❌ Render health server hatası:', error);
  void shutdown(1, 'Health server failed');
});

healthServer.listen(PORT, '0.0.0.0', () => {
  console.log(`📡 Render health server 0.0.0.0:${PORT} üzerinde hazır (/health).`);
});

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function retryAfterMs(error) {
  const seconds = Number.parseFloat(
    error?.rawError?.retry_after
      ?? error?.data?.retry_after
      ?? error?.retry_after
  );
  return Number.isFinite(seconds) ? Math.max(1_000, Math.ceil(seconds * 1_000)) : 0;
}

function isInvalidTokenError(error) {
  return error?.code === DiscordjsErrorCodes.TokenInvalid || error?.status === 401;
}

async function shutdown(exitCode, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  discordState = 'stopping';
  console.log(`🛑 Kapatılıyor: ${reason}`);

  try {
    await client.destroy();
  } catch (error) {
    console.error('Discord istemcisi kapatılırken hata oluştu:', formatError(error));
  }

  healthServer.close(() => process.exit(exitCode));
  setTimeout(() => process.exit(exitCode), 5_000).unref();
}

async function loginWithRetry() {
  let attempt = 0;

  while (!shuttingDown && !client.isReady()) {
    try {
      discordState = 'connecting';
      console.log(attempt === 0
        ? '🔌 Discord Gateway bağlantısı başlatılıyor...'
        : `🔄 Discord bağlantısı yeniden deneniyor (deneme ${attempt + 1})...`);
      await client.login(config.token);
      return;
    } catch (error) {
      if (isInvalidTokenError(error)) {
        throw new Error('DISCORD_TOKEN geçersiz veya iptal edilmiş. Render tokenını production botundan yeniden alın.');
      }

      attempt += 1;
      discordState = 'retry_wait';

      const backoffMs = Math.min(
        LOGIN_RETRY_BASE_MS * (2 ** Math.min(attempt - 1, 4)),
        LOGIN_RETRY_MAX_MS
      );
      const delayMs = Math.max(backoffMs, retryAfterMs(error));

      console.warn(
        `⏳ Discord bağlantısı kurulamadı: ${formatError(error)} `
        + `${Math.ceil(delayMs / 1_000)} saniye sonra tekrar denenecek.`
      );
      await wait(delayMs);
    }
  }
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

// Client ready event
client.once(Events.ClientReady, async (readyClient) => {
  discordState = 'connected';
  console.log(`🤖 Discord bağlantısı hazır! Giriş yapan hesap: ${readyClient.user.tag}`);

  if (config.clientId !== readyClient.user.id) {
    console.error(
      `❌ CLIENT_ID (${config.clientId}) bağlı production botuyla (${readyClient.user.id}) eşleşmiyor.`
    );
    await shutdown(1, 'Discord token/Client ID mismatch');
    return;
  }

  if (startupTasksCompleted) return;
  startupTasksCompleted = true;

  try {
    await checkGuildsAccess();
    await registerCommands();
    await eventStore.pruneOldEvents();
  } catch (error) {
    console.error('❌ Discord başlangıç işlemleri tamamlanamadı:', formatError(error));
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

client.on(Events.Error, (error) => {
  console.error('❌ Discord istemci hatası:', formatError(error));
});

client.on(Events.ShardError, (error, shardId) => {
  console.error(`❌ Discord WebSocket hatası (shard ${shardId}):`, formatError(error));
});

client.on(Events.ShardDisconnect, (event, shardId) => {
  if (shuttingDown) return;
  discordState = 'disconnected';
  console.warn(`⚠️ Discord bağlantısı koptu (shard ${shardId}, kod ${event?.code ?? 'bilinmiyor'}).`);
});

client.on(Events.ShardReconnecting, (shardId) => {
  if (shuttingDown) return;
  discordState = 'reconnecting';
  console.warn(`🔄 Discord shard ${shardId} yeniden bağlanıyor...`);
});

client.on(Events.ShardResume, (shardId, replayedEvents) => {
  discordState = 'connected';
  console.log(`✅ Discord shard ${shardId} devam ettirildi (${replayedEvents} olay tekrarlandı).`);
});

if (config.discordDebug) {
  client.on(Events.Debug, (message) => console.log(`[Discord Debug] ${message}`));
}

process.on('unhandledRejection', (reason) => {
  console.error('❌ İşlenmeyen Promise hatası:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Yakalanmayan uygulama hatası:', error);
  void shutdown(1, 'Uncaught exception');
});

process.on('SIGTERM', () => void shutdown(0, 'SIGTERM'));
process.on('SIGINT', () => void shutdown(0, 'SIGINT'));

async function launchBot() {
  const missingVariables = [
    ['DISCORD_TOKEN', config.token],
    ['CLIENT_ID', config.clientId],
    ['SUPABASE_URL', config.supabaseUrl],
    ['SUPABASE_KEY', config.supabaseKey]
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missingVariables.length > 0) {
    console.error(`❌ Eksik environment değişkenleri: ${missingVariables.join(', ')}`);
    await shutdown(1, 'Required environment variables are missing');
    return;
  }

  console.log(`[Startup] Node ${process.version}, discord.js ${discordJsVersion}`);

  try {
    await loginWithRetry();
  } catch (error) {
    console.error('❌ Discord bağlantısı kalıcı olarak başarısız:', formatError(error));
    await shutdown(1, 'Discord login failed');
  }
}

void launchBot();
