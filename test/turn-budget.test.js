// test/turn-budget.test.js
//
// The turn's absolute deadline.
//
// The round loop always had a wall-clock ceiling, but it was only read between
// rounds: it could not cap a call already in flight, and the forced wrap-up ran
// on top of an already-spent budget. These pin the ceiling now being one object
// every call derives from, and that it leaves no timer behind.

import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnBudget, turnBudgetFrom, callTimeoutWithin } from '../src/utils/turnBudget.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('remaining time shrinks and stops at zero', async () => {
  const budget = new TurnBudget(60);
  try {
    assert.ok(budget.remainingMs > 0 && budget.remainingMs <= 60);
    assert.equal(budget.expired, false);
    await sleep(90);
    assert.equal(budget.remainingMs, 0, 'remaining never goes negative');
    assert.equal(budget.expired, true);
  } finally {
    budget.dispose();
  }
});

test('a call gets the smaller of its own timeout and the rest of the turn', () => {
  const budget = new TurnBudget(5_000);
  try {
    // The turn is the tighter of the two here.
    assert.ok(callTimeoutWithin(60_000, budget) <= 5_000);
    // …and the call is, here.
    assert.equal(callTimeoutWithin(100, budget), 100);
    // With no turn at all, the call keeps its own timeout untouched.
    assert.equal(callTimeoutWithin(60_000, null), 60_000);
  } finally {
    budget.dispose();
  }
});

test('a child call never outlives the turn it belongs to', () => {
  const budget = new TurnBudget(1_000);
  const child = budget.childFor(60_000);
  try {
    assert.ok(child.deadlineAt <= budget.deadlineAt, 'the child cannot end after the turn');
    // Disposing the call must not disarm the turn.
    child.dispose();
    assert.equal(budget.expired, false);
  } finally {
    budget.dispose();
  }
});

test('an expired turn aborts a call already in flight', async () => {
  const budget = new TurnBudget(40);
  const child = budget.childFor(60_000);
  try {
    // The child's own timeout is a minute away; it is the turn that ends it.
    const aborted = new Promise(resolve => child.signal.addEventListener('abort', () => resolve(true), { once: true }));
    assert.equal(child.signal.aborted, false);
    assert.equal(await Promise.race([aborted, sleep(500).then(() => false)]), true);
    assert.equal(child.signal.aborted, true);
  } finally {
    child.dispose();
    budget.dispose();
  }
});

test('a call started after the turn is spent is born aborted', async () => {
  const budget = new TurnBudget(20);
  try {
    await sleep(60);
    const child = budget.childFor(60_000);
    try {
      assert.equal(child.signal.aborted, true, 'no call may start on an exhausted turn');
      assert.equal(child.remainingMs, 0);
    } finally {
      child.dispose();
    }
  } finally {
    budget.dispose();
  }
});

test('disposing really disarms the deadline', async () => {
  // The timer is unref'd, so it never holds the process open and counting
  // active handles would prove nothing. What has to be true is that dispose
  // clears it: a budget disposed at the end of a turn must not fire its abort
  // afterwards, or a later call sharing that signal would die for no reason.
  const budget = new TurnBudget(30);
  budget.dispose();
  await sleep(90);
  assert.equal(budget.signal.aborted, false, 'dispose left the deadline armed');
});

test('an undisposed budget does fire, so the test above is not vacuous', async () => {
  const budget = new TurnBudget(30);
  try {
    await sleep(90);
    assert.equal(budget.signal.aborted, true);
  } finally {
    budget.dispose();
  }
});

test('only a real budget on a context counts as one', () => {
  const budget = new TurnBudget(1_000);
  try {
    assert.equal(turnBudgetFrom({ turnBudget: budget }), budget);
    assert.equal(turnBudgetFrom({}), null);
    assert.equal(turnBudgetFrom(null), null);
    // A look-alike must not be mistaken for the real thing: everything
    // downstream relies on the shared signal actually being wired up.
    assert.equal(turnBudgetFrom({ turnBudget: { remainingMs: 5, signal: null } }), null);
  } finally {
    budget.dispose();
  }
});
