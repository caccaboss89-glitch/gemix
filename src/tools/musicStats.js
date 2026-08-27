// src/tools/musicStats.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// Fetches public music listening stats from an external MusicBot stats URL
// and returns a compact summary in `message`. Used exclusively by the
// read_music_stats tool. Pure formatting + fetch.

import { fetchExternal  } from '../utils/fetch.js';
import envConfig from '../config/env.js';

/**
 * Fetch and summarize music bot stats from the stats URL.
 * Extracts only essential data to minimize token usage.
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
async function readMusicStats() {
  try {
    const res = await fetchExternal(envConfig.MUSIC_STATS_URL, {
      headers: { 'User-Agent': 'GemiX-MusicStats/1.0' }
    }, 'Music Stats');

    if (!res.ok) {
      return { success: false, error: `Failed to fetch music stats: HTTP ${res.status}` };
    }

    const data = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { success: false, error: 'Failed to fetch music stats: response body is not a JSON object' };
    }
    return formatStats(data);
  } catch (err) {
    // fetchExternal already notifyAdmin'd on network failure; return so
    // executeTool's outer catch does not notify again.
    return { success: false, error: err.message };
  }
}

/**
 * Format raw stats JSON into a concise summary object for executeTool.
 * @param {object} data - Parsed stats payload
 * @returns {{ success: true, message: string }}
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

    return `${u.global_name || u.username} (@${u.username})\n` +
      `  Listening: ${hours}h ${minutes}m | Songs: ${totalSongs}\n` +
      `  Server playlist adds: ${u.serverPlaylistAdds || 0} | Personal: ${u.personalPlaylistAdds || 0}\n` +
      `  Top 5 songs:\n${top5Str}`;
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

  let output = 'MUSIC BOT STATISTICS\n\n';

  output += 'GLOBAL:\n';
  output += `  Songs started: ${global.songsStarted ?? 'N/A'}\n`;
  output += `  Songs completed: ${global.songsCompleted ?? 'N/A'}\n`;
  output += `  Active users: ${userEntries.length}\n`;
  output += `  Total music hours: ${totalHours}h ${totalMinutes}m\n`;
  output += `  Server playlist adds: ${totalServerAdds}\n`;
  output += `  Personal playlist adds: ${totalPersonalAdds}\n`;

  if (globalTop5.length > 0) {
    output += `\nGLOBAL TOP 5 SONGS:\n${globalTop5Str}\n`;
  }

  output += '\nUSERS:\n\n';
  output += userSummaries.join('\n\n');

  if (data.lastUpdated) {
    output += `\n\nLast updated: ${data.lastUpdated}`;
  }

  return { success: true, message: output };
}

export { formatStats, readMusicStats };
