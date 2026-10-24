// src/scheduler/usageReportMonitor.js
//
// Monthly GemiX usage report for the admin, sent on the 1st of each month like
// the music wrap. It charts the last 30 complete UTC days still in the PM2
// stdout logs, saves the image to data/usage-reports/ and sends it privately to
// the admin. Only after a successful send are the rotated GemiX logs deleted, so
// the logs are removed once a month and never before they have been reported.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pkg from 'whatsapp-web.js';
import sharp from 'sharp';
import constants from '../config/constants.js';
import { ACTIVE_MEMBERS } from '../config/members.js';
import { createLogger } from '../utils/logger.js';
import { get as getSystemState, update as updateSystemState } from '../utils/systemState.js';

const { MessageMedia } = pkg;
const log = createLogger('UsageReport');

const PM2_LOG_DIR = path.join(os.homedir(), '.pm2', 'logs');
const REPORT_DIR = path.join(constants.DATA_DIR, 'usage-reports');
const REPORT_WINDOW_DAYS = 30;
const LOG_FILE_RE = /^GemiX-out(__[^/\\]+)?\.log$/;
const ROTATED_LOG_RE = /^GemiX-(out|error)__[^/\\]+\.log$/;
// pm2 `time: true` prefixes every line with an ISO UTC timestamp.
const LINE_RE = /^(\d{4}-\d{2}-\d{2})T[\d:.]+: (.*)$/;
const COST_RE = /~\$([\d.]+) API-equivalent/;
const DAY_MS = 86_400_000;

const WIDTH = 1600;
const HEIGHT = 960;
const FONT = 'DejaVu Sans, Arial, sans-serif';
const COLORS = { messages: '#4C78A8', turns: '#F58518', cost: '#54A24B' };
const COLUMNS = [
  { left: 70, right: 760 },
  { left: 860, right: 1550 }
];
const ROWS = [
  { top: 110, bottom: 400 },
  { top: 560, bottom: 850 }
];

function _emptyDay() {
  return { messages: 0, turns: 0, costUsd: 0 };
}

function _addDays(day, count) {
  return new Date(Date.parse(day) + count * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Count incoming messages, Claude turns and their API-equivalent cost per UTC
 * day, from the PM2 stdout logs in `logDir`, for the days in [since, before).
 * Days with no activity are filled with zeros.
 * @returns {{ dates: string[], messages: number[], turns: number[], costUsd: number[] }|null}
 *   null when the logs hold no line in that range.
 */
function collectUsageReport(logDir, { since, before }) {
  let names;
  try {
    names = fs.readdirSync(logDir);
  } catch {
    return null;
  }

  const byDay = new Map();
  for (const name of names) {
    if (!LOG_FILE_RE.test(name)) continue;
    const text = fs.readFileSync(path.join(logDir, name), 'utf8');
    for (const line of text.split('\n')) {
      const match = LINE_RE.exec(line);
      if (!match || match[1] < since || match[1] >= before) continue;
      const [, day, body] = match;
      const counts = byDay.get(day) || _emptyDay();
      if (body === 'Incoming message') {
        counts.messages++;
      } else if (body.includes('Claude turn:')) {
        counts.turns++;
        const cost = COST_RE.exec(body);
        if (cost) counts.costUsd += Number(cost[1]);
      }
      byDay.set(day, counts);
    }
  }
  if (byDay.size === 0) return null;

  const dates = [];
  for (let day = since; day < before; day = _addDays(day, 1)) dates.push(day);
  const rows = dates.map(day => byDay.get(day) || _emptyDay());
  return {
    dates,
    messages: rows.map(row => row.messages),
    turns: rows.map(row => row.turns),
    costUsd: rows.map(row => row.costUsd)
  };
}

function _panelSvg({ kind, title, dates, series, left, right, top, bottom, format }) {
  const max = Math.max(...series.flatMap(s => s.values), 0) * 1.1 || 1;
  const slot = (right - left) / dates.length;
  const x = i => left + (i + 0.5) * slot;
  const y = v => bottom - (v / max) * (bottom - top);

  const grid = [0, 0.25, 0.5, 0.75, 1].map(fraction => {
    const value = max * fraction;
    return `<line x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}" stroke="#e0e0e0"/>`
      + `<text x="${left - 10}" y="${y(value) + 5}" text-anchor="end">${format(value)}</text>`;
  }).join('');

  let shapes;
  if (kind === 'bar') {
    const barWidth = (slot * 0.8) / series.length;
    shapes = series.map((s, k) => s.values.map((v, i) => {
      const barLeft = left + i * slot + slot * 0.1 + k * barWidth;
      return `<rect x="${barLeft}" y="${y(v)}" width="${barWidth}" height="${bottom - y(v)}" fill="${s.color}"/>`;
    }).join('')).join('');
  } else {
    shapes = series.map(s => {
      const points = s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
      const dots = s.values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="${s.color}"/>`).join('');
      return `<polyline points="${points}" fill="none" stroke="${s.color}" stroke-width="3"/>${dots}`;
    }).join('');
  }

  const legend = series.map((s, i) => `<rect x="${left + i * 220}" y="${top - 42}" width="14" height="14" fill="${s.color}"/>`
    + `<text x="${left + i * 220 + 22}" y="${top - 30}">${s.name}</text>`).join('');
  const labels = dates
    .map((day, i) => ({ day, i }))
    .filter(({ i }) => (dates.length - 1 - i) % 5 === 0)
    .map(({ day, i }) => `<text x="${x(i)}" y="${bottom + 24}" text-anchor="middle">${day.slice(8)}/${day.slice(5, 7)}</text>`)
    .join('');

  return `<text x="${left}" y="${top - 60}" font-size="18" font-weight="bold">${title}</text>`
    + legend + grid + shapes + labels;
}

/**
 * Render the report as one SVG: bar charts on the left, XY line charts on the
 * right, with activity on the top row and API-equivalent cost below.
 */
function renderUsageChartSvg(report) {
  const { dates, messages, turns, costUsd } = report;
  const activity = [
    { name: 'Messaggi ricevuti', color: COLORS.messages, values: messages },
    { name: 'Turni Claude', color: COLORS.turns, values: turns }
  ];
  const cost = [{ name: 'Costo', color: COLORS.cost, values: costUsd }];
  const formatCount = v => String(Math.round(v));
  const formatCost = v => `$${v.toFixed(2)}`;
  const rowSpecs = [
    { series: activity, format: formatCount, label: 'messaggi e turni Claude' },
    { series: cost, format: formatCost, label: 'costo equivalente API (USD)' }
  ];

  const panels = rowSpecs.flatMap((row, r) => COLUMNS.map((column, c) => _panelSvg({
    kind: c === 0 ? 'bar' : 'line',
    title: `${row.label.charAt(0).toUpperCase()}${row.label.slice(1)} (${c === 0 ? 'barre' : 'linee'})`,
    dates,
    series: row.series,
    left: column.left,
    right: column.right,
    top: ROWS[r].top,
    bottom: ROWS[r].bottom,
    format: row.format
  })));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="${FONT}" font-size="14" fill="#333">`
    + `<rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>${panels.join('')}`
    + `<text x="${COLUMNS[0].left}" y="${HEIGHT - 16}" font-size="12" fill="#777">Dati dai log PM2 di GemiX, ${dates.length} giorni UTC completi.</text>`
    + '</svg>';
}

async function renderUsageChartPng(report) {
  return sharp(Buffer.from(renderUsageChartSvg(report))).png().toBuffer();
}

/** Delete the rotated GemiX stdout and stderr logs; the live files stay open. */
function _deleteRotatedGemixLogs(logDir) {
  let removed = 0;
  for (const name of fs.readdirSync(logDir)) {
    if (!ROTATED_LOG_RE.test(name)) continue;
    fs.unlinkSync(path.join(logDir, name));
    removed++;
  }
  return removed;
}

/**
 * Scheduler entry point. Acts only on the 1st of the month (UTC, the day the
 * pm2 log rotation closes) and at most once per month: the report is saved and
 * sent first, then the rotated logs are deleted. A failed send is retried on
 * the next tick; a failed delete is logged and does not trigger another report.
 * @returns {Promise<boolean>} true when the report was sent.
 */
async function checkUsageReport(waClient, opts = {}) {
  if (!waClient) return false;
  const before = new Date().toISOString().slice(0, 10);
  if (before.slice(8) !== '01') return false;
  const month = before.slice(0, 7);
  if (getSystemState('usageReport')?.lastSentMonth === month) return false;

  const admin = ACTIVE_MEMBERS.find(member => member.admin);
  if (!admin?.wa) return false;

  const logDir = opts.logDir || PM2_LOG_DIR;
  const since = _addDays(before, -REPORT_WINDOW_DAYS);
  const report = collectUsageReport(logDir, { since, before });
  if (!report) {
    log.warn(`No GemiX usage lines in the logs for ${since} - ${before}; no report sent.`);
    await updateSystemState('usageReport', current => ({ ...current, lastSentMonth: month }));
    return false;
  }

  const png = await renderUsageChartPng(report);
  const fileName = `gemix-usage-${before}.png`;
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, fileName), png);

  const media = new MessageMedia('image/png', png.toString('base64'), fileName);
  await waClient.sendMessage(admin.wa, media, {
    caption: `Report utilizzo GemiX, ultimi ${REPORT_WINDOW_DAYS} giorni (${since} - ${before}, UTC)`
  });

  try {
    const removed = _deleteRotatedGemixLogs(logDir);
    log.info(`Monthly usage report sent; deleted ${removed} rotated GemiX log file(s).`);
  } catch (err) {
    log.error(`Usage report sent, but deleting the rotated GemiX logs failed: ${err.message}`);
  }
  await updateSystemState('usageReport', current => ({ ...current, lastSentMonth: month }));
  return true;
}

export {
  PM2_LOG_DIR,
  REPORT_DIR,
  REPORT_WINDOW_DAYS,
  checkUsageReport,
  collectUsageReport,
  renderUsageChartPng,
  renderUsageChartSvg
};
