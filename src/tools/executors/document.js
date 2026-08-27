// src/tools/executors/document.js
//
// Product-specific document generation executor bindings.

import { generateFormalRequestPdf } from '../formalRequestPdf.js';
import { stageToolOutput } from '../workspace/toolOutput.js';
import {
  buildAdminNotificationNote,
  notifyAdminDetailed
} from '../../utils/adminNotifier.js';
import { sanitizeFilename } from '../../utils/text.js';
import { resolveWorkspaceId } from '../../utils/workspaceId.js';

async function _generateFormalRequestPdf({ args, userCtx }) {
  try {
    const formalPdfBuffer = await generateFormalRequestPdf({
      fullName: args.fullName,
      title: args.title,
      motivation: args.motivation,
      requesterSignature: args.requesterSignature,
      legalSignature: args.legalSignature
    });
    const formalFileName = `Richiesta_${sanitizeFilename(args.title || 'formale')}.pdf`;
    const staged = await stageToolOutput(resolveWorkspaceId(userCtx), formalFileName, formalPdfBuffer);
    return {
      success: true,
      path: staged.display,
      message: `Formal request PDF generated successfully and saved as "${staged.display}". `
        + 'Open it with read_file to check its content, or pass that path to send it.'
    };
  } catch (err) {
    const notification = await notifyAdminDetailed('Formal PDF Tool', `Failed to generate PDF: ${err.message}`);
    return {
      success: false,
      error: `Error generating formal request PDF: ${err.message}${buildAdminNotificationNote(notification)}`
    };
  }
}

const DOCUMENT_TOOL_EXECUTORS = Object.freeze({
  generate_formal_request_pdf: _generateFormalRequestPdf
});

export { DOCUMENT_TOOL_EXECUTORS };
