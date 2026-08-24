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
import crypto from 'crypto';
import constants from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import { withKeyedLock } from '../utils/keyedLock.js';

const log = createLogger('NeuronLedger');

/** Free-plan daily allowance, shared by every model on the account. */
const DAILY_NEURONS = 10_000;

/** Neurons per 512x512 tile of generated image, and per tile of input image. */
const NEURONS_PER_OUTPUT_TILE = 26.05;
const NEURONS_PER_INPUT_TILE = 5.37;

/** Whisper large-v3-turbo, per second of audio. An estimate: the ledger is a
 *  guard rail, and Cloudflare's own count is the one that decides. */
const NEURONS_PER_AUDIO_SECOND = 0.0929;

/**
 * Headroom kept free. The count is an estimate and Cloudflare's is the real
 * one, so spending the last neuron by our own arithmetic is how a request gets
 * refused mid-flight instead of falling back cleanly.
 */
const RESERVE_NEURONS = 200;

const LEDGER_FILE = path.join(constants.DATA_DIR, 'neuron_ledger.json');
const RESERVATION_MAX_AGE_MS = 30 * 60 * 1000;
const ledgerLocks = new Map();

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
  const tmp = `${LEDGER_FILE}.tmp`;
  try {
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, LEDGER_FILE);
    return true;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing staged */ }
    log.warn(`Cannot persist the neuron ledger: ${err.message}`);
    return false;
  }
}

/** The state for today, rolling the day over when it has changed. */
function _state(now = Date.now()) {
  const state = _load();
  const day = _today(now);
  if (state.day !== day) return { day, spent: 0, calls: 0, reservations: {} };
  const reservations = {};
  for (const [id, reservation] of Object.entries(state.reservations || {})) {
    const createdAt = Number(reservation?.createdAt);
    const cost = Math.max(0, Number(reservation?.cost) || 0);
    if (!createdAt || now - createdAt > RESERVATION_MAX_AGE_MS) continue;
    reservations[id] = { cost, createdAt };
  }
  return {
    day,
    spent: Math.max(0, Number(state.spent) || 0),
    calls: Math.max(0, Number(state.calls) || 0),
    reservations
  };
}

function _reservedNeurons(state) {
  return Object.values(state.reservations || {})
    .reduce((sum, reservation) => sum + Math.max(0, Number(reservation.cost) || 0), 0);
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
  return Math.max(0, DAILY_NEURONS - RESERVE_NEURONS - state.spent - _reservedNeurons(state));
}

async function _settleReservation(id, commit, now = Date.now()) {
  return withKeyedLock(ledgerLocks, LEDGER_FILE, async () => {
    const state = _state(now);
    const reservation = state.reservations[id];
    if (!reservation) return false;
    delete state.reservations[id];
    if (commit) {
      state.spent = Math.round((state.spent + reservation.cost) * 100) / 100;
      state.calls += 1;
    }
    return _save(state);
  });
}

/**
 * Atomically reserve estimated cost before network work starts. Parallel calls
 * see each other's pending reservations, so only calls that fit can launch.
 */
async function reserveNeurons(estimated, now = Date.now()) {
  const cost = Math.max(0, Number(estimated) || 0);
  return withKeyedLock(ledgerLocks, LEDGER_FILE, async () => {
    const state = _state(now);
    const remaining = Math.max(
      0,
      DAILY_NEURONS - RESERVE_NEURONS - state.spent - _reservedNeurons(state)
    );
    if (cost > remaining) {
      return {
        ok: false,
        remaining,
        estimated: cost,
        reason: 'The free Cloudflare Workers AI allowance for today is spent '
          + `(${Math.round(remaining)} of ${DAILY_NEURONS} neurons left, this call needs about `
          + `${Math.round(cost)}). It resets at 00:00 UTC.`
      };
    }

    const id = crypto.randomUUID();
    state.reservations[id] = { cost, createdAt: now };
    if (!_save(state)) {
      return {
        ok: false,
        remaining,
        estimated: cost,
        reason: 'The local Cloudflare allowance ledger could not be persisted, so this call was not started.'
      };
    }

    let settled = false;
    return {
      ok: true,
      remaining,
      estimated: cost,
      async commit() {
        if (settled) return false;
        settled = await _settleReservation(id, true);
        return settled;
      },
      async release() {
        if (settled) return false;
        settled = await _settleReservation(id, false);
        return settled;
      }
    };
  });
}

/** Today's figures, for the Runtime block and for diagnostics. */
function ledgerSnapshot(now = Date.now()) {
  const state = _state(now);
  return {
    day: state.day,
    spent: state.spent,
    reserved: _reservedNeurons(state),
    calls: state.calls,
    remaining: remainingNeurons(now),
    dailyLimit: DAILY_NEURONS
  };
}

/** Reset today's count. Tests, and the operator command that follows a mis-count. */
function resetLedger(now = Date.now()) {
  _save({ day: _today(now), spent: 0, calls: 0, reservations: {} });
}

export {
  DAILY_NEURONS,
  LEDGER_FILE,
  NEURONS_PER_AUDIO_SECOND,
  NEURONS_PER_INPUT_TILE,
  NEURONS_PER_OUTPUT_TILE,
  RESERVE_NEURONS,
  RESERVATION_MAX_AGE_MS,
  estimateImageNeurons,
  estimateSttNeurons,
  ledgerSnapshot,
  reserveNeurons,
  remainingNeurons,
  resetLedger,
  tilesFor
};
