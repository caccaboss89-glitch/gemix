const PDFDocument = require('pdfkit');
const { getRomeTime } = require('../utils/time');

/**
 * Parse a text line into segments with bold/italic flags.
 * Handles **bold**, *italic*, and ***bold+italic*** markers.
 */
function parseInlineSegments(text) {
  const segments = [];
  // Match ***bold+italic***, **bold**, or *italic*
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

/**
 * Render a line of text with inline **bold** and *italic* formatting.
 */
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
 * Generate a PDF buffer from title and content text.
 * @param {string} title
 * @param {string} content
 * @returns {Promise<Buffer>}
 */
function generatePdf(title, content) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).font('Helvetica-Bold').text(title, { align: 'center' });
    doc.moveDown(1);

    doc.fontSize(12).font('Helvetica');
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.trim() === '---' || line.trim() === '***' || line.trim() === '___') {
        doc.moveDown(0.3);
        const x = doc.x;
        const y = doc.y;
        doc.moveTo(x, y).lineTo(doc.page.width - doc.page.margins.right, y).lineWidth(0.5).strokeColor('#999999').stroke();
        doc.moveDown(0.3);
        doc.strokeColor('#000000').lineWidth(1);
      } else if (line.startsWith('# ')) {
        doc.moveDown(0.5).fontSize(18).font('Helvetica-Bold');
        renderInlineMarkdown(doc, line.slice(2));
        doc.fontSize(12).font('Helvetica');
      } else if (line.startsWith('## ')) {
        doc.moveDown(0.4).fontSize(15).font('Helvetica-Bold');
        renderInlineMarkdown(doc, line.slice(3));
        doc.fontSize(12).font('Helvetica');
      } else if (line.startsWith('### ')) {
        doc.moveDown(0.3).fontSize(13).font('Helvetica-Bold');
        renderInlineMarkdown(doc, line.slice(4));
        doc.fontSize(12).font('Helvetica');
      } else if (line.startsWith('#### ')) {
        doc.moveDown(0.2).fontSize(12).font('Helvetica-Bold');
        renderInlineMarkdown(doc, line.slice(5));
        doc.fontSize(12).font('Helvetica');
      } else if (/^\s*[-*]\s/.test(line)) {
        const indent = line.match(/^(\s*)/)[1].length;
        const text = line.replace(/^\s*[-*]\s+/, '');
        doc.font('Helvetica').fontSize(12);
        renderInlineMarkdown(doc, `${'  '.repeat(indent)}• ${text}`);
      } else if (/^\s*\d+\.\s/.test(line)) {
        const match = line.match(/^(\s*)(\d+\.)\s+(.*)/);
        const indent = match[1].length;
        doc.font('Helvetica').fontSize(12);
        renderInlineMarkdown(doc, `${'  '.repeat(indent)}${match[2]} ${match[3]}`);
      } else {
        doc.font('Helvetica').fontSize(12);
        renderInlineMarkdown(doc, line);
      }
    }

    doc.moveDown(2);
    doc.fontSize(8).fillColor('#999999').text(`Generato da GemiX — ${getRomeTime()}`, { align: 'center' });

    doc.end();
  });
}

module.exports = { generatePdf };
