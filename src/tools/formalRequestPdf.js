const PDFDocument = require('pdfkit');
const { getRomeTime } = require('../utils/time');

/**
 * Parse inline markdown (**bold**, *italic*, ***both***).
 */
function parseInlineSegments(text) {
  const segments = [];
  const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*)/g;
  let last = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) {
      segments.push({ text: text.slice(last, match.index), bold: false, italic: false });
    }
    if (match[2] !== undefined) {
      segments.push({ text: match[2], bold: true, italic: true });
    } else if (match[3] !== undefined) {
      segments.push({ text: match[3], bold: true, italic: false });
    } else if (match[4] !== undefined) {
      segments.push({ text: match[4], bold: false, italic: true });
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    segments.push({ text: text.slice(last), bold: false, italic: false });
  }
  return segments;
}

function getFontName(bold, italic) {
  if (bold && italic) return 'Helvetica-BoldOblique';
  if (bold) return 'Helvetica-Bold';
  if (italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

function renderInlineMarkdown(doc, text) {
  const segments = parseInlineSegments(text);
  if (segments.length === 0) {
    doc.text('');
    return;
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    doc.font(getFontName(seg.bold, seg.italic)).text(seg.text, { continued: !isLast });
  }
}

/**
 * Render motivation text: bold, italic, lists, numbered lists.
 * Heading markers (# ## etc.) are stripped — section headers are predefined.
 */
function renderMotivation(doc, content) {
  const lines = content.split('\n');
  for (const line of lines) {
    // Strip heading markers (non consentiti nelle richieste formali)
    const cleanLine = line.replace(/^#{1,6}\s+/, '');

    if (cleanLine.trim() === '---' || cleanLine.trim() === '***' || cleanLine.trim() === '___') {
      doc.moveDown(0.3);
      const x = doc.x;
      const y = doc.y;
      doc.moveTo(x, y).lineTo(doc.page.width - doc.page.margins.right, y).lineWidth(0.5).strokeColor('#999999').stroke();
      doc.moveDown(0.3);
      doc.strokeColor('#000000').lineWidth(1);
    } else if (/^\s*[-*]\s/.test(cleanLine)) {
      const indent = cleanLine.match(/^(\s*)/)[1].length;
      const text = cleanLine.replace(/^\s*[-*]\s+/, '');
      doc.font('Helvetica').fontSize(11);
      renderInlineMarkdown(doc, `${'  '.repeat(indent)}• ${text}`);
    } else if (/^\s*\d+\.\s/.test(cleanLine)) {
      const match = cleanLine.match(/^(\s*)(\d+\.)\s+(.*)/);
      const indent = match[1].length;
      doc.font('Helvetica').fontSize(11);
      renderInlineMarkdown(doc, `${'  '.repeat(indent)}${match[2]} ${match[3]}`);
    } else {
      doc.font('Helvetica').fontSize(11);
      renderInlineMarkdown(doc, cleanLine);
    }
  }
}

/**
 * Render a section header with underline.
 */
function renderSectionHeader(doc, title) {
  doc.moveDown(0.8);
  doc.fontSize(13).font('Helvetica-Bold').text(title, { underline: true });
  doc.moveDown(0.3);
}

/**
 * Generate a formal request PDF per Art. 6 of the Statuto Albertino.
 * Sections are predefined and standardized.
 * @param {object} params
 * @param {string} params.fullName - Nome e Cognome del richiedente
 * @param {string} params.title - Titolo della Richiesta
 * @param {string} params.motivation - Motivazione dettagliata
 * @param {string} params.requesterSignature - Firma del richiedente
 * @param {string} [params.legalSignature] - Firma/visto del legale
 * @returns {Promise<Buffer>}
 */
function generateFormalRequestPdf({ fullName, title, motivation, requesterSignature, legalSignature }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Intestazione ──
    doc.fontSize(22).font('Helvetica-Bold').text('RICHIESTA FORMALE', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#666666')
      .text('ai sensi dell\'Art. 6 dello Statuto Albertino', { align: 'center' });
    doc.fillColor('#000000');
    doc.moveDown(0.5);

    // Separatore
    const lx = doc.x;
    doc.moveTo(lx, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .lineWidth(1).strokeColor('#333333').stroke();
    doc.strokeColor('#000000').lineWidth(1);
    doc.moveDown(0.5);

    // ── Sezione: Nome e Cognome ──
    renderSectionHeader(doc, 'NOME E COGNOME');
    doc.fontSize(11).font('Helvetica').text(fullName);

    // ── Sezione: Titolo della Richiesta ──
    renderSectionHeader(doc, 'TITOLO DELLA RICHIESTA');
    doc.fontSize(11).font('Helvetica').text(title);

    // ── Sezione: Motivazione ──
    renderSectionHeader(doc, 'MOTIVAZIONE');
    renderMotivation(doc, motivation);

    // ── Sezione: Data e Orario di Creazione ──
    renderSectionHeader(doc, 'DATA E ORARIO DI CREAZIONE');
    doc.fontSize(11).font('Helvetica').text(getRomeTime());

    // ── Sezione: Firma del Richiedente ──
    renderSectionHeader(doc, 'FIRMA DEL RICHIEDENTE');
    doc.fontSize(11).font('Helvetica').text(requesterSignature || '________________________');

    // ── Sezione: Firma/Visto del Legale ──
    renderSectionHeader(doc, 'FIRMA/VISTO DEL LEGALE');
    doc.fontSize(11).font('Helvetica').text(legalSignature || '________________________');

    // ── Footer ──
    doc.moveDown(2);
    doc.moveTo(lx, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .lineWidth(0.5).strokeColor('#999999').stroke();
    doc.moveDown(0.5);
    doc.fontSize(8).fillColor('#999999')
      .text(`Documento generato da GemiX — Divisione Legale — ${getRomeTime()}`, { align: 'center' });

    doc.end();
  });
}

module.exports = { generateFormalRequestPdf };
