// src/utils/cloudflareNeurons.js
//
// One ledger for the 10,000 free daily Workers AI neurons.
//
// Speech-to-text and the image fallback draw on the same allowance, so they
// share this counter rather than keeping two optimistic ones that together
// overshoot. The period key is the UTC date: the allowance resets at 00:00 UTC
// and so does the circuit breaker, which survives restarts because the state
// lives in systemState.json.
//
// The reservation is pessimistic. Units are charged before the request goes out
// and refunded only when the request provably never reached Cloudflare — once
// the API has accepted it, the neurons are spent whatever the response says.
//
// Only aggregates are stored: a period key, a running total and the breaker.
// No chat id, filename, transcript or user text ever enters this file, which is
// also why /clear does not touch it.

import { get as getState, update as updateState } from './systemState.js';
import { createLogger } from './logger.js';

const log = createLogger('CfNeurons');

const MODULE = 'cloudflareNeurons';
/** Cloudflare's free daily allowance, shared by every Workers AI model. */
const DAILY_FREE_NEURONS = 10_000;
/** Whisper Large v3 Turbo, measured per minute of audio. */
const STT_NEURONS_PER_MINUTE = 46.63;
/**
 * One 512x512 tile of a FLUX generation. Workers AI bills image models by tile
 * and step and GemiX has not metered a run, so this is a deliberate
 * over-estimate: charging too much only makes the fallback stop early, while
 * charging too little would let it run past the free allowance.
 */
const IMAGE_NEURONS_PER_TILE = 250;

/** Reasons a reservation can be refused. */
const NEURON_DENIAL = {
  /** The remaining allowance is smaller than the request. */
  QUOTA: 'quota',
  /** Cloudflare already answered "out of quota" today. */
  CIRCUIT_OPEN: 'circuit_open'
};

/** UTC day the allowance belongs to. */
function periodKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/** Reset the counters when the stored state belongs to an earlier UTC day. */
function _rollOver(state, period) {
  if (state && state.period === period) {
    return {
      period,
      used: Number(state.used) || 0,
      circuitOpen: state.circuitOpen === true,
      calls: Number(state.calls) || 0
    };
  }
  return { period, used: 0, circuitOpen: false, calls: 0 };
}

/**
 * Neurons one generated image costs, by the tiles its resolution covers.
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
function neuronsForImage(width, height) {
  const w = Number(width) > 0 ? Number(width) : 512;
  const h = Number(height) > 0 ? Number(height) : 512;
  return Math.ceil(w / 512) * Math.ceil(h / 512) * IMAGE_NEURONS_PER_TILE;
}

/** Neurons one audio clip costs, rounded up so the estimate never runs short. */
function neuronsForAudioSeconds(durationSec) {
  const seconds = Number(durationSec);
  if (!Number.isFinite(seconds) || seconds <= 0) return Math.ceil(STT_NEURONS_PER_MINUTE);
  return Math.ceil((seconds / 60) * STT_NEURONS_PER_MINUTE);
}

/**
 * Charge an estimated cost before calling Cloudflare.
 *
 * @param {number} units - estimated neurons
 * @param {string} kind - 'stt' | 'image', for the log line only
 * @returns {Promise<{ ok: true, charged: number, remaining: number }
 *   | { ok: false, reason: string, remaining: number }>}
 */
async function reserveNeurons(units, kind = 'stt') {
  const cost = Math.max(1, Math.ceil(Number(units) || 0));
  let outcome;

  await updateState(MODULE, (current) => {
    const state = _rollOver(current, periodKey());
    if (state.circuitOpen) {
      outcome = { ok: false, reason: NEURON_DENIAL.CIRCUIT_OPEN, remaining: 0 };
      return state;
    }
    const remaining = DAILY_FREE_NEURONS - state.used;
    if (cost > remaining) {
      outcome = { ok: false, reason: NEURON_DENIAL.QUOTA, remaining: Math.max(0, remaining) };
      return state;
    }
    const next = { ...state, used: state.used + cost, calls: state.calls + 1 };
    outcome = { ok: true, charged: cost, remaining: DAILY_FREE_NEURONS - next.used };
    return next;
  });

  if (!outcome.ok) {
    log.warn(`${kind} refused: ${outcome.reason} (${outcome.remaining} neurons left today)`);
  }
  return outcome;
}

/**
 * Give back a charge for a request Cloudflare never received (bad credentials,
 * a connection that never opened, a body that failed to build). Anything the
 * API answered — including an error — stays charged.
 *
 * @param {number} units
 * @returns {Promise<void>}
 */
async function refundNeurons(units) {
  const cost = Math.max(0, Math.ceil(Number(units) || 0));
  if (cost === 0) return;
  await updateState(MODULE, (current) => {
    const state = _rollOver(current, periodKey());
    return { ...state, used: Math.max(0, state.used - cost), calls: Math.max(0, state.calls - 1) };
  });
}

/**
 * Cloudflare said the account is out of quota: stop trying until the UTC reset.
 * @returns {Promise<void>}
 */
async function openQuotaCircuit() {
  await updateState(MODULE, (current) => {
    const state = _rollOver(current, periodKey());
    if (state.circuitOpen) return state;
    log.warn('Cloudflare reported the free quota is exhausted — pausing until 00:00 UTC.');
    return { ...state, circuitOpen: true, used: DAILY_FREE_NEURONS };
  });
}

/**
 * Current allowance, for diagnostics and the Runtime block.
 * @returns {{ period: string, used: number, remaining: number, circuitOpen: boolean, calls: number }}
 */
function readNeuronLedger() {
  const state = _rollOver(getState(MODULE), periodKey());
  return {
    period: state.period,
    used: state.used,
    remaining: Math.max(0, DAILY_FREE_NEURONS - state.used),
    circuitOpen: state.circuitOpen,
    calls: state.calls
  };
}

export {
  DAILY_FREE_NEURONS,
  STT_NEURONS_PER_MINUTE,
  IMAGE_NEURONS_PER_TILE,
  NEURON_DENIAL,
  periodKey,
  neuronsForAudioSeconds,
  neuronsForImage,
  reserveNeurons,
  refundNeurons,
  openQuotaCircuit,
  readNeuronLedger
};
