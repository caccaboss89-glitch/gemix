// src/tools/executors/media.js
//
// Media generation and listening-stat executor bindings.

import { generateImage, generateVideo } from '../imagineGenerator.js';
import { musicCreator } from '../musicCreator.js';
import { readMusicStats } from '../musicStats.js';
import { stageToolOutputsBatch } from '../workspace/toolOutput.js';
import { resolveWorkspaceId } from '../../utils/workspaceId.js';
import { runAccessoryEffect } from '../../utils/accessoryEffect.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('MediaExecutors');

async function _generateImage({ args, userCtx }) {
  if (typeof userCtx.sendIntermediateNotification === 'function') {
    await runAccessoryEffect(
      () => userCtx.sendIntermediateNotification(
        'image_gen',
        '🎨 Sto generando l\'immagine, attendi un attimo...'
      ),
      { label: 'Image progress notification', log }
    );
  }
  return generateImage(args, userCtx);
}

async function _generateVideo({ args, userCtx }) {
  if (typeof userCtx.sendIntermediateNotification === 'function') {
    await runAccessoryEffect(
      () => userCtx.sendIntermediateNotification(
        'video_gen',
        '🎬 Sto generando il video (può richiedere qualche minuto), attendi un attimo...'
      ),
      { label: 'Video progress notification', log }
    );
  }
  return generateVideo(args, userCtx);
}

async function _generateMusic({ args, userCtx }) {
  if (userCtx.presence && typeof userCtx.presence.setRecording === 'function') {
    await runAccessoryEffect(
      () => userCtx.presence.setRecording(),
      { label: 'Music recording presence', log }
    );
  }
  if (!args.prompt) {
    return { success: false, error: 'Missing prompt parameter in tool call arguments.' };
  }

  const musicResult = await musicCreator(args.prompt, userCtx);
  if (!musicResult.attachments || musicResult.attachments.length === 0) {
    return musicResult.toolResult;
  }

  const reservation = musicResult.quotaReservation;
  try {
    const workspaceId = resolveWorkspaceId(userCtx);
    const staged = await stageToolOutputsBatch(
      workspaceId,
      musicResult.attachments.map(att => ({ desiredName: att.name, source: att.buffer }))
    );
    reservation?.commit();
    const paths = staged.map(file => file.display);
    return {
      success: true,
      path: paths[0],
      message: 'Song generated successfully and saved as '
        + `${paths.map(filePath => `"${filePath}"`).join(', ')}. `
        + 'You cannot listen to it yourself, but you can still use it or send it to the user.'
    };
  } finally {
    await reservation?.release();
  }
}

const MEDIA_TOOL_EXECUTORS = Object.freeze({
  generate_image: _generateImage,
  generate_video: _generateVideo,
  generate_music: _generateMusic,
  read_music_stats: () => readMusicStats()
});

export { MEDIA_TOOL_EXECUTORS };
