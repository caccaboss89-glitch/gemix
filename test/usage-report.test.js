import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectUsageReport,
  renderUsageChartPng,
  renderUsageChartSvg
} from '../src/scheduler/usageReportMonitor.js';

function logDirWith(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('usage report counts messages, turns and cost per UTC day in the window', t => {
  const dir = logDirWith(t, {
    'GemiX-out__2026-10-17_00-00-00.log': [
      '2026-10-16T09:00:00: Incoming message',
      '2026-10-16T09:00:05: [ClaudeEngine]    Claude turn: 1 tool round(s), ~$0.5000 API-equivalent, 900ms',
      '2026-10-16T23:59:59: [WA-DEDICATED] unrelated line',
      '2026-10-15T23:59:59: Incoming message'
    ].join('\n'),
    'GemiX-out.log': [
      '2026-10-18T10:00:00: Incoming message',
      '2026-10-18T10:00:01: Incoming message',
      '2026-10-18T10:00:05: [ClaudeEngine]    Claude turn: 0 tool round(s), ~$0.2500 API-equivalent, 900ms',
      '2026-10-19T08:00:00: Incoming message'
    ].join('\n'),
    'GemiX-error.log': '2026-10-18T10:00:00: Incoming message\n'
  });

  const report = collectUsageReport(dir, { since: '2026-10-16', before: '2026-10-19' });

  assert.deepEqual(report, {
    dates: ['2026-10-16', '2026-10-17', '2026-10-18'],
    messages: [1, 0, 2],
    turns: [1, 0, 1],
    costUsd: [0.5, 0, 0.25]
  });
});

test('usage report returns null when the logs hold no line in the window', t => {
  const dir = logDirWith(t, {
    'GemiX-out.log': '2026-10-19T08:00:00: Incoming message\n'
  });
  assert.equal(collectUsageReport(dir, { since: '2026-09-01', before: '2026-09-30' }), null);
  assert.equal(collectUsageReport(path.join(dir, 'missing'), { since: '2026-09-01', before: '2026-09-30' }), null);
});

test('usage chart renders one PNG holding bar and XY panels', async () => {
  const report = {
    dates: ['2026-10-17', '2026-10-18', '2026-10-19'],
    messages: [11, 0, 14],
    turns: [10, 0, 14],
    costUsd: [0.46, 0, 0.35]
  };

  const svg = renderUsageChartSvg(report);
  assert.equal(svg.match(/\(barre\)/g).length, 2);
  assert.equal(svg.match(/\(linee\)/g).length, 2);
  assert.equal(svg.match(/<polyline/g).length, 3);

  const png = await renderUsageChartPng(report);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});
