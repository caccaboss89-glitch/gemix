// src/media/neuronLedger.js
//
// The shared budget behind every Cloudflare Workers AI call (spec §11.2).
//
// Workers AI bills in "neurons" and the free plan grants 10,000 a day across
// the whole account. Whisper and FLUX draw on the same pool, so neither can be
// metered on its own: a day of heavy transcription is a day with fewer images,
// and the only way to know that before the request is to count both here.
//
// Prices come from the live probe recorded in the spec, not from the archive
// branch, whose 250-neurons-per-tile figure was wrong by an order of magnitude:
//
//   FLUX  26.05 neurons per 512x512 output tile + 5.37 per input tile
//         (a 512² image is ~26; a 1024² image is ~104)
//   Whisper is billed per audio second, so its cost is estimated from duration
//
// The count is an estimate, deliberately. Cloudflare is the authority on what
// was actually spent; this exists to refuse the call that would obviously blow
// the budget and to fall back cleanly instead of collecting 429s.

import fs from 'fs';
import path from 'path';
import constants from '../config/constants.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('NeuronLedger');

/** Free-plan daily allowance, shared by every model on the account. */
const DAILY_NEURONS = 10_000;

/** Neurons per 512x512 tile of generated image, and per tile of input image. */
const NEURONS_PER_OUTPUT_TILE = 26.05;
const NEURONS_PER_INPUT_TILE = 5.37;

/** Whisper large-v3-turbo, per second of audio (Workers AI published rate). */
const NEURONS_PER_AUDIO_SECOND = 0.0929;

/**
 * Headroom kept free. The count is an estimate and Cloudflare's is the real
 * one, so spending the last neuron by our own arithmetic is how a request gets
 * refused mid-flight instead of falling back cleanly.
 */
const RESERVE_NEURONS = 200;

const LEDGER_FILE = path.join(constants.DATA_DIR, 'neuron_ledger.json');

/** UTC day, because that is the boundary Cloudflare resets on. */
function _today(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function _load() {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf-8'));
    if (raw && typeof raw === 'object' && typeof raw.day === 'string') return raw;
  } catch { /* first run, or a corrupted file we are about to replace */ }
  return { day: _today(), spent: 0, calls: 0 };
}

function _save(state) {
  try {
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(state));
  } catch (err) {
    // A ledger that cannot be written must not stop a generation: the worst
    // case is that Cloudflare enforces the limit itself, with a 429.
    log.warn(`Cannot persist the neuron ledger: ${err.message}`);
  }
}

/** The state for today, rolling the day over when it has changed. */
function _state(now = Date.now()) {
  const state = _load();
  const day = _today(now);
  if (state.day !== day) return { day, spent: 0, calls: 0 };
  return state;
}

/** Tiles a WxH image occupies, at Cloudflare's 512x512 tile size. */
function tilesFor(width, height) {
  return Math.max(1, Math.ceil((width || 512) / 512) * Math.ceil((height || 512) / 512));
}

/**
 * Estimated cost of one image generation.
 * @param {{width?: number, height?: number, inputImages?: number}} opts
 * @returns {number}
 */
function estimateImageNeurons({ width = 512, height = 512, inputImages = 0 } = {}) {
  const outputTiles = tilesFor(width, height);
  // An input reference is charged per tile too, at its own lower rate; we do not
  // know its dimensions before upload, so one tile each is the honest floor.
  return outputTiles * NEURONS_PER_OUTPUT_TILE + inputImages * NEURONS_PER_INPUT_TILE;
}

/** Estimated cost of transcribing a clip of this length. */
function estimateSttNeurons(durationSec) {
  return Math.max(1, Number(durationSec) || 0) * NEURONS_PER_AUDIO_SECOND;
}

/** What is left today, after the reserve. */
function remainingNeurons(now = Date.now()) {
  const state = _state(now);
  return Math.max(0, DAILY_NEURONS - RESERVE_NEURONS - state.spent);
}

/**
 * Whether a call of this estimated cost fits in what is left.
 * @returns {{ ok: boolean, remaining: number, estimated: number, reason?: string }}
 */
function canAfford(estimated, now = Date.now()) {
  const remaining = remainingNeurons(now);
  if (estimated <= remaining) return { ok: true, remaining, estimated };
  return {
    ok: false,
    remaining,
    estimated,
    reason: 'The free Cloudflare Workers AI allowance for today is spent '
      + `(${Math.round(remaining)} of ${DAILY_NEURONS} neurons left, this call needs about `
      + `${Math.round(estimated)}). It resets at 00:00 UTC.`
  };
}

/** Record what a call is believed to have cost. */
function recordSpend(estimated, now = Date.now()) {
  const state = _state(now);
  state.spent = Math.round((state.spent + Math.max(0, estimated)) * 100) / 100;
  state.calls += 1;
  _save(state);
  return state.spent;
}

/** Today's figures, for the Runtime block and for diagnostics. */
function ledgerSnapshot(now = Date.now()) {
  const state = _state(now);
  return {
    day: state.day,
    spent: state.spent,
    calls: state.calls,
    remaining: remainingNeurons(now),
    dailyLimit: DAILY_NEURONS
  };
}

/** Reset today's count. Tests, and the operator command that follows a mis-count. */
function resetLedger(now = Date.now()) {
  _save({ day: _today(now), spent: 0, calls: 0 });
}

export {
  DAILY_NEURONS,
  LEDGER_FILE,
  NEURONS_PER_AUDIO_SECOND,
  NEURONS_PER_INPUT_TILE,
  NEURONS_PER_OUTPUT_TILE,
  RESERVE_NEURONS,
  canAfford,
  estimateImageNeurons,
  estimateSttNeurons,
  ledgerSnapshot,
  recordSpend,
  remainingNeurons,
  resetLedger,
  tilesFor
};
