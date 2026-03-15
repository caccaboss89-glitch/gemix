const PDFDocument = require('pdfkit');

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

    // Title
    doc.fontSize(20).font('Helvetica-Bold').text(title, { align: 'center' });
    doc.moveDown(1);

    // Content - handle line breaks and basic formatting
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
        doc.text(`  • ${line.slice(2)}`);
      } else {
        doc.text(line);
      }
    }

    // Footer
    doc.moveDown(2);
    doc.fontSize(8).fillColor('#999999').text(`Generato da GemiX — ${new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}`, { align: 'center' });

    doc.end();
  });
}

module.exports = { generatePdf };
