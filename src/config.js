import dotenv from 'dotenv';
dotenv.config();

export const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID
};

if (!config.token) {
  console.warn('⚠️ UYARI: DISCORD_TOKEN .env dosyasında bulunamadı!');
}
if (!config.clientId) {
  console.warn('⚠️ UYARI: CLIENT_ID .env dosyasında bulunamadı!');
}
