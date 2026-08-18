// src/utils/turnBudget.js
//
// One absolute deadline per turn.
//
// Every individual call already has its own timeout, but nothing bounded their
// sum: a turn that kept hitting slow rounds could run far past any single
// timeout, holding the user's request open long after the reply stopped being
// useful. The handler now opens one budget per turn and every call inside that
// turn derives from it with `childFor`, so a call ends at whichever comes
// first — its own timeout, or what is left of the turn.
//
// Provider-neutral by design: the xAI and OpenAI stacks apply timeouts in
// different ways, and both take a ceiling from the same object rather than each
// keeping its own notion of when the turn is over.

/**
 * An absolute deadline plus the AbortSignal every call, stream, sleep and
 * sub-operation under it shares.
 */
class TurnBudget {
  /**
   * @param {number} totalMs
   * @param {AbortSignal} [parentSignal] - aborting it aborts this budget too
   */
  constructor(totalMs, parentSignal) {
    this.deadlineAt = Date.now() + totalMs;
    this._controller = new AbortController();
    this._timer = setTimeout(() => this._controller.abort(), totalMs);
    this._timer.unref?.();
    if (parentSignal) {
      if (parentSignal.aborted) this._controller.abort();
      else parentSignal.addEventListener('abort', () => this._controller.abort(), { once: true });
    }
  }

  get signal() {
    return this._controller.signal;
  }

  get remainingMs() {
    return Math.max(0, this.deadlineAt - Date.now());
  }

  /** True when there is no budget left to start new work. */
  get expired() {
    return this.remainingMs <= 0 || this._controller.signal.aborted;
  }

  /**
   * A budget for one call inside this turn, ending at whichever comes first:
   * the call's own timeout, or the rest of the turn. Dispose it when the call
   * returns; disposing a child never affects the turn it came from.
   *
   * @param {number} callTimeoutMs
   * @returns {TurnBudget}
   */
  childFor(callTimeoutMs) {
    return new TurnBudget(Math.min(callTimeoutMs, this.remainingMs), this.signal);
  }

  /** Release the timer once the turn is over. */
  dispose() {
    clearTimeout(this._timer);
  }
}

/**
 * The turn budget carried by a context, if there is one.
 *
 * Callers outside a turn — startup preflight, scheduled jobs, tests — have
 * none, and everything downstream has to keep working on its own timeout alone.
 *
 * @param {object} [ctx]
 * @returns {TurnBudget|null}
 */
function turnBudgetFrom(ctx) {
  const budget = ctx?.turnBudget;
  return budget instanceof TurnBudget ? budget : null;
}

/**
 * The timeout one call should use: its own, capped by what is left of the turn.
 *
 * @param {number} callTimeoutMs
 * @param {TurnBudget|null} [budget]
 * @returns {number}
 */
function callTimeoutWithin(callTimeoutMs, budget) {
  return budget ? Math.min(callTimeoutMs, budget.remainingMs) : callTimeoutMs;
}

export { TurnBudget, turnBudgetFrom, callTimeoutWithin };
