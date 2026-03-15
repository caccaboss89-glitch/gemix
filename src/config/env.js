require('dotenv').config();

module.exports = {
  API_KEY: process.env.API_KEY,
  API_BASE_URL: process.env.API_BASE_URL || 'https://api.aimlapi.com/v1',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'google/gemini-3-flash-preview',
  GROK_MODEL: process.env.GROK_MODEL || 'x-ai/grok-4-1-fast-reasoning',
  SERPAPI_KEY: process.env.SERPAPI_KEY,
  BOT_TOKEN: process.env.BOT_TOKEN,
  GUILD_ID: process.env.GUILD_ID,
  BOT_EMAIL: process.env.BOT_EMAIL,
  BOT_PASS: process.env.BOT_PASS,
};
