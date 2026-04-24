// src/tools/musicStats.js
const { fetchExternal } = require('../utils/fetch');

const STATS_URL = 'https://raw.githubusercontent.com/caccaboss89-glitch/MusicBot/main/data/stats.json';

/**
 * Fetch and summarize music bot stats from GitHub.
 * Extracts only essential data to minimize token usage.
 * @returns {Promise<string>} Formatted stats summary
 */
async function readMusicStats() {
  const res = await fetchExternal(STATS_URL, {
    headers: { 'User-Agent': 'GemiX-MusicStats/1.0' },
  }, 'Music Stats');

  if (!res.ok) {
    throw new Error(`Failed to fetch music stats: HTTP ${res.status}`);
  }

  const data = await res.json();
  return formatStats(data);
}

/**
 * Format raw stats.json into a concise summary string.
 * @param {object} data - Parsed stats.json
 * @returns {string} Formatted summary
 */
function formatStats(data) {
  const users = data.users || {};
  const global = data.global || {};

  // --- Per-user stats ---
  const userEntries = Object.entries(users);
  let totalListeningMs = 0;
  let totalServerAdds = 0;
  let totalPersonalAdds = 0;

  // Accumulate global song plays from all users for global top 5
  const globalSongMap = {};

  const userSummaries = userEntries.map(([, u]) => {
    const ms = u.listeningTimeMs || 0;
    totalListeningMs += ms;
    totalServerAdds += u.serverPlaylistAdds || 0;
    totalPersonalAdds += u.personalPlaylistAdds || 0;

    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);

    const songPlays = u.songPlays || {};
    const songs = Object.values(songPlays);
    const totalSongs = songs.reduce((sum, s) => sum + (s.count || 0), 0);

    // Accumulate into global map
    for (const s of songs) {
      const key = s.url || s.title;
      if (!globalSongMap[key]) {
        globalSongMap[key] = { title: s.title, count: 0 };
      }
      globalSongMap[key].count += s.count || 0;
    }

    // Top 5 songs for this user
    const top5 = songs.sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 5);
    const top5Str = top5.map((s, i) => `  ${i + 1}. ${s.title} (${s.count}x)`).join('\n');

    return `👤 ${u.global_name || u.username} (@${u.username})\n` +
      `   Ascolto: ${hours}h ${minutes}m | Canzoni: ${totalSongs}\n` +
      `   Aggiunte playlist server: ${u.serverPlaylistAdds || 0} | Personali: ${u.personalPlaylistAdds || 0}\n` +
      `   Top 5 canzoni:\n${top5Str}`;
  });

  // --- Global top 5 ---
  // Prefer global.songPlays if available, else use aggregated from users
  let globalTop5;
  if (global.songPlays && Object.keys(global.songPlays).length > 0) {
    globalTop5 = Object.values(global.songPlays)
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .slice(0, 5);
  } else if (global.topSongs && global.topSongs.length > 0) {
    globalTop5 = global.topSongs.slice(0, 5);
  } else {
    globalTop5 = Object.values(globalSongMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }

  const globalTop5Str = globalTop5
    .map((s, i) => `  ${i + 1}. ${s.title} (${s.count}x)`)
    .join('\n');

  // --- Global summary ---
  const totalHours = Math.floor(totalListeningMs / 3600000);
  const totalMinutes = Math.floor((totalListeningMs % 3600000) / 60000);

  let output = '🎵 STATISTICHE MUSIC BOT\n\n';

  output += '📊 GLOBALI:\n';
  output += `  Canzoni avviate: ${global.songsStarted || 'N/D'}\n`;
  output += `  Canzoni completate: ${global.songsCompleted || 'N/D'}\n`;
  output += `  Utenti attivi: ${userEntries.length}\n`;
  output += `  Ore di musica totali: ${totalHours}h ${totalMinutes}m\n`;
  output += `  Aggiunte playlist server: ${totalServerAdds}\n`;
  output += `  Aggiunte playlist personali: ${totalPersonalAdds}\n`;

  if (globalTop5.length > 0) {
    output += `\n🏆 TOP 5 CANZONI GLOBALI:\n${globalTop5Str}\n`;
  }

  output += '\n👥 UTENTI:\n\n';
  output += userSummaries.join('\n\n');

  if (data.lastUpdated) {
    output += `\n\n📅 Ultimo aggiornamento: ${data.lastUpdated}`;
  }

  return output;
}

module.exports = { readMusicStats };
