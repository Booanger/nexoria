import dotenv from 'dotenv';
dotenv.config();

export const config = {
  token: process.env.DISCORD_TOKEN?.trim(),
  clientId: process.env.CLIENT_ID?.trim(),
  databasePath: process.env.DATABASE_PATH?.trim() || 'data/nexoria.sqlite',
  allowedGuilds: process.env.ALLOWED_GUILDS
    ? process.env.ALLOWED_GUILDS.split(',').map(id => id.trim()).filter(Boolean)
    : [],
  discordDebug: process.env.DISCORD_DEBUG === 'true'
};

if (!config.token) {
  console.warn('⚠️ UYARI: DISCORD_TOKEN .env dosyasında bulunamadı!');
}
if (!config.clientId) {
  console.warn('⚠️ UYARI: CLIENT_ID .env dosyasında bulunamadı!');
}
