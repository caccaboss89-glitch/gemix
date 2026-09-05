async function run(operation, args) {
  const kreuzberg = await import('@kreuzberg/node');
  if (operation === 'extractFile') {
    return kreuzberg.extractFile(args.path, args.mime, args.options || {});
  }
  if (operation === 'extractBytes') {
    return kreuzberg.extractBytes(Buffer.from(args.buffer), args.mime);
  }
  if (operation === 'renderPdfPage') {
    return kreuzberg.renderPdfPage(args.path, args.page, args.options || {});
  }
  throw new Error(`Unsupported Kreuzberg process operation: ${operation}`);
}

function reply(message) {
  if (!process.connected) process.exit(1);
  process.send(message, () => process.exit(0));
}

process.once('message', async ({ operation, args }) => {
  try {
    reply({ ok: true, result: await run(operation, args) });
  } catch (err) {
    reply({
      ok: false,
      error: {
        name: err?.name || 'Error',
        message: err?.message || String(err),
        code: err?.code || null,
        stack: err?.stack || null
      }
    });
  }
});
