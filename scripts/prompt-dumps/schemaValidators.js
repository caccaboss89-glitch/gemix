import constants from '../../src/config/constants.js';
import { getCapabilities } from '../../src/config/platformCapabilities.js';
import { PROMPT_VARIANT, resolveProviderProfile } from '../../src/ai/providers/providerProfile.js';
import { CASES } from './cases.js';
import { ISSUES } from './validationIssues.js';
import { containsXaiOnlyMaterial } from './validationText.js';

const IMPL_LEAK_PATTERNS = [
  { re: /input_file/i, label: 'input_file' },
  { re: /input_image/i, label: 'input_image' },
  { re: /numbered lines/i, label: 'numbered lines' },
  { re: /server-side via public/i, label: 'server-side via public' },
  { re: /display-only/i, label: 'display-only' },
  { re: /raw file bytes/i, label: 'raw file bytes' },
  { re: /tmpfile\.link/i, label: 'tmpfile.link' },
  { re: /attached server-side/i, label: 'attached server-side' },
  { re: /returns inline in the tool result/i, label: 'returns inline in the tool result' },
  { re: /injected into the current turn/i, label: 'injected into the current turn' },
  { re: /Added to the current turn/i, label: 'Added to the current turn' },
  { re: /render_inline_citation/i, label: 'legacy render_inline_citation' },
  { re: /\[\[[^\]]*\]\]\(https?:/i, label: 'legacy inline source marker' }
];

function validateNoImplLeaks(text, caseId, scope) {
  for (const { re, label } of IMPL_LEAK_PATTERNS) {
    if (re.test(text)) ISSUES.push({ caseId, msg: `${scope} leaks implementation detail: ${label}` });
  }
}

function validateToolDumpLeaks(dump, caseId) {
  const toolsStart = dump.indexOf('--- TOOLS');
  if (toolsStart < 0) return;
  const toolText = dump.slice(toolsStart);
  validateNoImplLeaks(toolText, caseId, 'tool schema');
  if (toolText.includes('[function] schedule_tasks')
      && (!/wall-clock time unchanged/.test(toolText)
        || !/Do not convert the hour/.test(toolText)
        || !/do not add Z or a UTC offset/.test(toolText))) {
    ISSUES.push({
      caseId,
      msg: 'schedule_tasks must tell the model to copy wall-clock time unchanged and leave timezone conversion to the backend'
    });
  }

  const ctx = CASES[Number(caseId)]?.ctx;
  if (!ctx) return;
  const hasBugReport = toolText.includes('[function] bug_report');
  if (Boolean(ctx.userIdentity?.isAdmin) === hasBugReport) {
    ISSUES.push({ caseId, msg: 'bug_report availability does not match administrator status' });
  }
  if (toolText.includes('[function] generate_formal_request_pdf')) {
    const hasLegalSignature = /legalSignature/.test(toolText);
    if (Boolean(ctx.userIdentity?.isLegal) !== hasLegalSignature) {
      ISSUES.push({ caseId, msg: 'legalSignature field does not match legal advisor status' });
    }
  }
  const generic = resolveProviderProfile().promptVariant === PROMPT_VARIANT.GENERIC;
  if (generic && containsXaiOnlyMaterial(toolText)) {
    ISSUES.push({ caseId, msg: 'generic provider tool schema leaks xAI-only material' });
  }
  const nativeX = toolText.match(/\[native\] (\{[^\n]+"type":"x_search"[^\n]+\})/);
  if (!nativeX) return;
  let schema;
  try { schema = JSON.parse(nativeX[1]); } catch { schema = null; }
  if (!schema
      || Object.hasOwn(schema, 'limit')
      || schema?.enable_image_understanding !== true
      || schema?.enable_video_understanding !== true) {
    ISSUES.push({ caseId, msg: 'native x_search dump must omit the obsolete limit and keep both media-understanding flags' });
  }
}

function validateResponseFormat(dump, caseId) {
  const fmtStart = dump.indexOf('--- STRUCTURED OUTPUT');
  if (fmtStart < 0) return;
  const fmtEnd = dump.indexOf('\n--- AUDIT APPENDIX', fmtStart);
  const fmt = fmtEnd >= 0 ? dump.slice(fmtStart, fmtEnd) : dump.slice(fmtStart);
  const hasVoice = /voice \(boolean, required\)/.test(fmt);
  const hasSpokenDesc = /natural spoken words/.test(fmt);
  const hasTitle = /conversation_title \(string, required\)/.test(fmt);
  const ctx = CASES[Number(caseId)]?.ctx;
  const expectsVoice = Boolean(ctx && getCapabilities(ctx).voiceReply);
  const expectsTitle = ctx?.platform === constants.PLATFORM_DISCORD;

  if (expectsVoice) {
    if (!hasVoice) ISSUES.push({ caseId, msg: 'WA dedicated case missing voice schema field' });
    if (!hasSpokenDesc) ISSUES.push({ caseId, msg: 'voice case missing natural spoken-word instructions' });
  } else {
    if (hasVoice) ISSUES.push({ caseId, msg: 'non-voice case must not expose voice schema field' });
    if (hasSpokenDesc) {
      ISSUES.push({ caseId, msg: 'non-voice case must not expose spoken-word instructions in response schema' });
    }
  }
  if (expectsTitle) {
    if (!hasTitle) ISSUES.push({ caseId, msg: 'Discord text.format must require conversation_title' });
  } else if (hasTitle) {
    ISSUES.push({ caseId, msg: 'non-Discord case must not expose conversation_title schema field' });
  }
  if (!/schema: object additionalProperties=false required=\[[^\]]*response[^\]]*attachments/.test(fmt)) {
    ISSUES.push({ caseId, msg: 'structured reply dump must expose its closed object and required fields' });
  }
}

export { validateNoImplLeaks, validateResponseFormat, validateToolDumpLeaks };
