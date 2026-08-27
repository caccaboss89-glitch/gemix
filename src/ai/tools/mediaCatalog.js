// src/ai/tools/mediaCatalog.js
//
// Media schemas. Image and video advertise only parameters implemented by the
// selected backend; music and listening stats remain GemiX-owned.

import constants from '../../config/constants.js';
import {
  BACKEND as IMAGE_BACKEND,
  FLUX_DEFAULT_SIZE,
  FLUX_MAX_REFERENCES,
  FLUX_SIZES,
  declaredImageBackend
} from '../../media/imageBackends.js';
import { makeTool } from './schema.js';

const FLUX_SIZE_DESCRIPTION = Object.entries(FLUX_SIZES)
  .map(([name, { width, height }]) => `${name}=${width}x${height}`)
  .join(', ');

function _buildXaiImageTool() {
  return makeTool({
    name: 'generate_image',
    description: `Generate an image from a textual prompt, optionally guided by up to ${constants.MAX_REF_IMAGES_FOR_IMAGE} reference images `
      + '(editing, composition, style transfer). The image is saved in your workspace.',
    properties: {
      prompt: {
        type: 'string',
        minLength: 3,
        maxLength: constants.MEDIA_GENERATION_PROMPT_MAX_CHARS,
        description: 'Image description: subject, style, lighting, mood, composition. When passing reference images, refer to them '
          + 'ALWAYS as <IMAGE_0>, <IMAGE_1>, … in array order - never by filename.'
      },
      reference_images: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        maxItems: constants.MAX_REF_IMAGES_FOR_IMAGE,
        description: `Up to ${constants.MAX_REF_IMAGES_FOR_IMAGE}. Each entry: a path in this chat, exactly as you saw it, `
          + 'or a public https URL. Order matters (<IMAGE_0> = first). 1 = edit/transform; 2+ = combine or style transfer. '
          + 'Omit for pure text-to-image.'
      },
      aspect_ratio: {
        type: 'string',
        enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
        description: 'Aspect ratio for pure text-to-image. Omit for automatic. Ignored with reference images (output follows the input image).'
      }
    },
    required: ['prompt']
  });
}

function _buildFluxImageTool() {
  return makeTool({
    name: 'generate_image',
    description: 'Generate an image from a textual prompt. The image is saved in your workspace. '
      + 'A reference image guides the subject and style, but the result is a fresh image built from that '
      + 'guidance, not an edit of the original: do not use it to change one detail of a picture and expect '
      + 'the rest to survive.',
    properties: {
      prompt: {
        type: 'string',
        minLength: 3,
        maxLength: constants.MEDIA_GENERATION_PROMPT_MAX_CHARS,
        description: 'Image description: subject, style, lighting, mood, composition. Describe the whole picture you want, '
          + 'including the parts a reference image already shows.'
      },
      reference_images: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        maxItems: FLUX_MAX_REFERENCES,
        description: 'At most one, as a path in this chat exactly as you saw it. Guides subject and style. Omit for pure text-to-image.'
      },
      size: {
        type: 'string',
        enum: Object.keys(FLUX_SIZES),
        description: `Exact output dimensions: ${FLUX_SIZE_DESCRIPTION}. Default ${FLUX_DEFAULT_SIZE}.`
      }
    },
    required: ['prompt']
  });
}

function buildGenerateImageTool() {
  const backend = declaredImageBackend();
  if (backend === IMAGE_BACKEND.XAI) return _buildXaiImageTool();
  if (backend === IMAGE_BACKEND.CLOUDFLARE) return _buildFluxImageTool();
  return null;
}

const TOOL_GENERATE_VIDEO = makeTool({
  name: 'generate_video',
  description: `Request an approximately ${constants.VIDEO_GEN_DURATION_S}-second video targeting ${constants.VIDEO_GEN_RESOLUTION} from a textual prompt, optionally guided by reference images. It can NOT modify or extend an existing video - only reference IMAGES are accepted. The video is saved in your workspace.`,
  properties: {
    prompt: {
      type: 'string',
      minLength: 3,
      maxLength: constants.MEDIA_GENERATION_PROMPT_MAX_CHARS,
      description: 'Video description: subject, action, camera movement, style, lighting. When passing reference images, refer to them ALWAYS as <IMAGE_0>, <IMAGE_1>, ... in array order - never by filename.'
    },
    reference_images: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      maxItems: constants.MAX_REF_IMAGES_FOR_VIDEO,
      description: `Up to ${constants.MAX_REF_IMAGES_FOR_VIDEO}. Each entry: a path in this chat, exactly as you saw it, `
        + 'or a public https URL. 1 = animate as first frame; 2+ = style/subject guides. Omit for pure text-to-video.'
    },
    aspect_ratio: {
      type: 'string',
      enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'],
      description: 'Aspect ratio. Default 16:9. With a single reference image, omit to respect the input image.'
    }
  },
  required: ['prompt']
});

const TOOL_GENERATE_MUSIC = makeTool({
  name: 'generate_music',
  description: 'Create a music clip of approximately 30 seconds from a prompt. The clip is saved in your workspace.',
  properties: {
    prompt: {
      type: 'string',
      minLength: 5,
      maxLength: constants.MEDIA_GENERATION_PROMPT_MAX_CHARS,
      description: 'Detailed description of style, instruments, and mood.'
    }
  },
  required: ['prompt']
});

const TOOL_READ_MUSIC_STATS = makeTool({
  name: 'read_music_stats',
  description: 'Read the deployment MusicBot\'s current cumulative listening summary: global songs started/completed, '
    + 'total listening time and playlist additions, global top five songs, and the same listening/addition/top-five '
    + 'breakdown for every tracked user. Top five in every case ranks by play count, most played first. '
    + 'The result includes the source\'s last-updated timestamp when available.',
  properties: {}
});

export {
  TOOL_GENERATE_MUSIC,
  TOOL_GENERATE_VIDEO,
  TOOL_READ_MUSIC_STATS,
  buildGenerateImageTool
};
