// The one model-facing boundary between the generic provider contract and the
// deliberately richer xAI integration. The generic variant is the baseline;
// the xAI variant replaces it as a whole instead of adding fragments elsewhere
// in the prompt.

import { PROMPT_VARIANT } from './providerProfile.js';

function _has(toolNames, name) {
  return toolNames instanceof Set && toolNames.has(name);
}

function _genericGuidance() {
  return [
    'The model provider supplies reasoning, vision, structured replies and calls to the tools listed for this turn. '
      + 'GemiX itself supplies every user-facing feature that appears in those tool schemas; an absent tool means '
      + 'that feature is unavailable in this chat.',
    'Use only capabilities and fields present in the current tool and reply schemas. Never assume a hosted provider '
      + 'tool, provider-only component or unadvertised media service exists.'
  ];
}

function _xaiGuidance(toolNames) {
  const lines = [
    'Regular web search, image search, page reading, file parsing, the workspace, shell execution, delivery and '
      + 'scheduling are still GemiX-owned tools. Do not substitute xAI hosted web search or any provider component '
      + 'for them.'
  ];

  if (_has(toolNames, 'x_search')) {
    lines.push(
      'xAI additionally provides native X search for X posts, accounts, threads and their image or video media. '
        + 'Use it only for X; use search_web and read_page for the ordinary web. When the user wants media from an '
        + 'X result, put the direct CDN URL returned by X search in `attachments`.'
    );
  }

  const generation = [];
  if (_has(toolNames, 'generate_image')) generation.push('image generation');
  if (_has(toolNames, 'generate_video')) generation.push('video generation');
  if (generation.length > 0) {
    lines.push(`The xAI generation tools available in this chat provide ${generation.join(' and ')} exactly as described by those tool schemas.`);
  }

  lines.push('Anything not stated in this block follows the same GemiX-owned contract as every other provider.');
  return lines;
}

/** Build the provider block that replaces, rather than augments, the baseline. */
function buildProviderGuidance(profile, toolNames) {
  return profile?.promptVariant === PROMPT_VARIANT.XAI
    ? _xaiGuidance(toolNames)
    : _genericGuidance();
}

export { buildProviderGuidance };
