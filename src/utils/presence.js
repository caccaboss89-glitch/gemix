// src/utils/presence.js
const { createLogger } = require('./logger');

const log = createLogger('Presence');

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
   * Start the presence indicator with auto-refresh every 20 seconds.
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
    }, 20000);
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
          await this.chat.clearState();
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
          await this.chat.sendStateRecording();
        } else {
          // Fallback if method is missing but sendState exists (unlikely in newer versions)
          if (typeof this.chat.sendState === 'function') await this.chat.sendState('recording');
        }
      } else {
        if (typeof this.chat.sendStateTyping === 'function') {
          await this.chat.sendStateTyping();
        } else {
          if (typeof this.chat.sendState === 'function') await this.chat.sendState('typing');
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
