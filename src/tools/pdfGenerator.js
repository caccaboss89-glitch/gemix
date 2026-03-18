const PDFDocument = require('pdfkit');
const { getRomeTime } = require('../utils/time');

/**
 * Parse markdown inline formatting and apply to pdfkit document.
 * Supports: **bold**, *italic*, ***bold-italic***
 */
function renderMarkdownLine(doc, line) {
  // Pattern per riconoscere markdown inline: **bold**, *italic*, ***bold-italic***
  const parts = [];
  let regex = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|[^*_]+)/g;
  let match;
  
  while ((match = regex.exec(line)) !== null) {
    const text = match[1];
    if (text.startsWith('***') && text.endsWith('***')) {
      // Bold italic
      parts.push({ text: text.slice(3, -3), bold: true, italic: true });
    } else if (text.startsWith('**') && text.endsWith('**')) {
      // Bold
      parts.push({ text: text.slice(2, -2), bold: true, italic: false });
    } else if ((text.startsWith('*') && text.endsWith('*')) || (text.startsWith('_') && text.endsWith('_'))) {
      // Italic
      parts.push({ text: text.slice(1, -1), bold: false, italic: true });
    } else {
      // Normale
      parts.push({ text, bold: false, italic: false });
    }
  }
  
  if (parts.length === 0) {
    doc.text(line);
    return;
  }
  
  // Renderizza inline parts sulla stessa riga
  let x = doc.x;
  let y = doc.y;
  
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    let font = 'Helvetica';
    if (part.bold && part.italic) font = 'Helvetica-BoldOblique';
    else if (part.bold) font = 'Helvetica-Bold';
    else if (part.italic) font = 'Helvetica-Oblique';
    
    doc.font(font).text(part.text, x, y, { lineBreak: false });
    x = doc.x;
  }
  
  doc.moveDown();
}

/**
 * Generate a PDF buffer from title and content text.
 * Supporta markdown: **bold**, *italic*, # heading, ## subheading, - lista
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
      if (line.startsWith('# ')) {
        doc.moveDown(0.5).fontSize(16).font('Helvetica-Bold').text(line.slice(2));
        doc.fontSize(12).font('Helvetica');
      } else if (line.startsWith('## ')) {
        doc.moveDown(0.3).fontSize(14).font('Helvetica-Bold').text(line.slice(3));
        doc.fontSize(12).font('Helvetica');
      } else if (line.startsWith('- ')) {
        renderMarkdownLine(doc, `  • ${line.slice(2)}`);
      } else if (line.trim() === '') {
        doc.moveDown(0.3);
      } else {
        renderMarkdownLine(doc, line);
      }
    }

    doc.moveDown(2);
    doc.fontSize(8).fillColor('#999999').text(`Generato da GemiX — ${getRomeTime()}`, { align: 'center' });

    doc.end();
  });
}

module.exports = { generatePdf };
