// The one model-facing boundary between the generic provider contract and the
// provider-specific integrations. The generic variant is the baseline. The
// deliberately richer xAI variant replaces it as a whole instead of adding
// fragments elsewhere in the prompt; the Claude variant keeps it and adds how
// that runtime carries the conversation and the reply.

import { HISTORY_REPLY_LABEL } from '../claudeAgent/claudeUserContent.js';
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
        + 'Use it only for X; use search_web and read_page for the ordinary web.'
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

function _claudeGuidance() {
  return [
    ..._genericGuidance(),
    'Your reply reaches the chat only through the StructuredOutput tool: when you are ready to answer, call it '
      + 'directly with the final reply instead of writing the reply as plain text first.',
    'The chat so far arrives inside `<conversation-history>`, oldest first; the entries labelled '
      + `\`${HISTORY_REPLY_LABEL}\` are your own earlier replies.`
  ];
}

/** Build the provider block of the profile's prompt variant. */
function buildProviderGuidance(profile, toolNames) {
  switch (profile?.promptVariant) {
  case PROMPT_VARIANT.XAI: return _xaiGuidance(toolNames);
  case PROMPT_VARIANT.CLAUDE: return _claudeGuidance();
  default: return _genericGuidance();
  }
}

export { buildProviderGuidance };
