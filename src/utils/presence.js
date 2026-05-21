// src/utils/presence.js
const { createLogger } = require('./logger');

const log = createLogger('Presence');

// WhatsApp clears typing/recording state automatically after ~25s of silence.
// We refresh well below that threshold to leave headroom for slow `sendState*`
// roundtrips (which can take several seconds when the WA Web client is busy).
const REFRESH_INTERVAL_MS = 10_000;
// Per-update timeout: if a sendState* call hangs longer than this, abort and
// let the next tick try again, otherwise the indicator can stall for tens of
// seconds while the previous update is still pending.
const UPDATE_TIMEOUT_MS = 4_000;

function _withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(promise)
      .then((v) => { clearTimeout(timer); resolve(v); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Manages WhatsApp presence state (typing/recording) with auto-refresh.
 * Required because WhatsApp clears these states automatically after ~25s.
 */
class WhatsAppPresence {
  constructor(chat) {
    this.chat = chat;
    this.currentState = null; // 'typing' | 'recording' | null
    this.intervalId = null;
    this._isRefreshing = false;
  }

  /**
   * Start the presence indicator with auto-refresh.
   * @param {'typing'|'recording'} type
   */
  async start(type = 'typing') {
    if (!this.chat) return;

    // If already running with the same state, do nothing
    if (this.intervalId && this.currentState === type) return;

    this.currentState = type;

    // Initial update
    await this._update();

    // Setup refresh interval (WhatsApp auto-clears after ~25-30s)
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = setInterval(async () => {
      if (this._isRefreshing) return;
      await this._update();
    }, REFRESH_INTERVAL_MS);
    if (this.intervalId && typeof this.intervalId.unref === 'function') {
      this.intervalId.unref();
    }
  }

  /**
   * Switch to recording state.
   */
  async setRecording() {
    await this.start('recording');
  }

  /**
   * Switch to typing state.
   */
  async setTyping() {
    await this.start('typing');
  }

  /**
   * Stop the indicator and clear the state on WhatsApp.
   */
  async stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    const wasActive = this.currentState !== null;
    this.currentState = null;

    if (wasActive && this.chat) {
      try {
        if (typeof this.chat.clearState === 'function') {
          await _withTimeout(this.chat.clearState(), UPDATE_TIMEOUT_MS, 'clearState');
        }
      } catch (err) {
        log.warn(`Failed to clear presence state: ${err.message}`);
      }
    }
  }

  async _update() {
    if (!this.chat || !this.currentState) return;
    this._isRefreshing = true;
    try {
      if (this.currentState === 'recording') {
        if (typeof this.chat.sendStateRecording === 'function') {
          await _withTimeout(this.chat.sendStateRecording(), UPDATE_TIMEOUT_MS, 'sendStateRecording');
        } else if (typeof this.chat.sendState === 'function') {
          await _withTimeout(this.chat.sendState('recording'), UPDATE_TIMEOUT_MS, 'sendState(recording)');
        }
      } else {
        if (typeof this.chat.sendStateTyping === 'function') {
          await _withTimeout(this.chat.sendStateTyping(), UPDATE_TIMEOUT_MS, 'sendStateTyping');
        } else if (typeof this.chat.sendState === 'function') {
          await _withTimeout(this.chat.sendState('typing'), UPDATE_TIMEOUT_MS, 'sendState(typing)');
        }
      }
    } catch (err) {
      log.warn(`Failed to send presence state (${this.currentState}): ${err.message}`);
    } finally {
      this._isRefreshing = false;
    }
  }
}

module.exports = { WhatsAppPresence };
