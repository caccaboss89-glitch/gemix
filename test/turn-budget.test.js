// test/turn-budget.test.js
//
// The handler owns one absolute turn deadline and reserves its final slice for
// a no-tools wrap-up. Every nested operation must stop when its parent stops.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TurnBudget,
  createTurnBudgets,
  signalWithTimeout,
  sleepWithin
} from '../src/utils/turnBudget.js';

test('the work budget ends before the root by the configured wrap-up reserve', () => {
  const { root, work } = createTurnBudgets(10_000, 2_000);
  try {
    const reserve = root.deadlineAt - work.deadlineAt;
    assert.ok(reserve >= 1_990 && reserve <= 2_010, `unexpected reserve: ${reserve}ms`);
    assert.equal(root.signal.aborted, false);
    assert.equal(work.signal.aborted, false);
  } finally {
    work.dispose();
    root.dispose();
  }
});

test('a parent abort immediately propagates to every child budget', () => {
  const parent = new AbortController();
  const budget = new TurnBudget(10_000, parent.signal);
  const child = budget.childFor(5_000);
  parent.abort(new DOMException('turn ended', 'AbortError'));
  try {
    assert.equal(budget.signal.aborted, true);
    assert.equal(child.signal.aborted, true);
    assert.equal(child.expired, true);
  } finally {
    child.dispose();
    budget.dispose();
  }
});

test('operation signals and retry sleeps both honour caller cancellation', async () => {
  const parent = new AbortController();
  const operation = signalWithTimeout(parent.signal, 10_000);
  const started = Date.now();
  const sleeping = sleepWithin(10_000, operation);
  parent.abort(new DOMException('turn ended', 'AbortError'));
  await sleeping;
  assert.equal(operation.aborted, true);
  assert.ok(Date.now() - started < 1_000, 'abortable sleep did not stop promptly');
});

test('an operation signal also enforces its own timeout without a parent', async () => {
  const operation = signalWithTimeout(null, 10);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(operation.aborted, true);
  assert.equal(operation.reason?.name, 'TimeoutError');
});
