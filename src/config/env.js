require('dotenv').config();

module.exports = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
  GEMINI_MODEL: process.env.GEMINI_MODEL,
  QWEN_MODEL: process.env.QWEN_MODEL,
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
  XAI_API_KEY: process.env.XAI_API_KEY,
  XAI_TTS_VOICE: process.env.XAI_TTS_VOICE,
  SEARXNG_URL: process.env.SEARXNG_URL,
  BOT_TOKEN: process.env.BOT_TOKEN,
  GUILD_ID: process.env.GUILD_ID,
  BOT_EMAIL: process.env.BOT_EMAIL,
  BOT_PASS: process.env.BOT_PASS,
  MUSIC_WRAP_PASSWORD: process.env.MUSIC_WRAP_PASSWORD,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_REPO: process.env.GITHUB_REPO,
};
