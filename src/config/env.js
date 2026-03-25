require('dotenv').config();

module.exports = {
  API_KEY: process.env.API_KEY,
  API_BASE_URL: process.env.API_BASE_URL,
  GEMINI_MODEL: process.env.GEMINI_MODEL,
  GROK_MODEL: process.env.GROK_MODEL,
  SERPAPI_KEY: process.env.SERPAPI_KEY,
  BOT_TOKEN: process.env.BOT_TOKEN,
  GUILD_ID: process.env.GUILD_ID,
  BOT_EMAIL: process.env.BOT_EMAIL,
  BOT_PASS: process.env.BOT_PASS,
  XAI_API_KEY: process.env.XAI_API_KEY,
};
