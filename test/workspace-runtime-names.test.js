import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

import workspaceRuntime from '../src/sandbox/workspaceRuntime.js';
import { _ownedResourceIsOrphan, admitWorkspaceRequest } from '../src/sandbox/workspaceRuntime.js';
import constants from '../src/config/constants.js';
import { workspaceIdToSlug } from '../src/utils/workspaceId.js';

test('long workspace ids keep a collision-resistant suffix', () => {
  const prefix = `user:${'same-prefix-'.repeat(10)}`;
  const first = workspaceIdToSlug(`${prefix}one`);
  const second = workspaceIdToSlug(`${prefix}two`);
  assert.ok(first.length <= 63);
  assert.ok(second.length <= 63);
  assert.notEqual(first, second);
});

test('container and private-network names preserve workspace and boot uniqueness', () => {
  const workspaceId = `user:${'very-long-'.repeat(12)}@c.us`;
  const containerA = workspaceRuntime.workspaceContainerName(workspaceId, 'aaaaaa');
  const containerB = workspaceRuntime.workspaceContainerName(workspaceId, 'bbbbbb');
  const networkA = workspaceRuntime.workspaceNetworkName(workspaceId, 'aaaaaa');
  const otherNetwork = workspaceRuntime.workspaceNetworkName(`${workspaceId}-other`, 'aaaaaa');
  for (const name of [containerA, containerB, networkA, otherNetwork]) assert.ok(name.length <= 63, name);
  assert.notEqual(containerA, containerB);
  assert.notEqual(networkA, otherNetwork);
  const options = workspaceRuntime.workspaceNetworkCreateOptions(workspaceId, networkA);
  assert.equal(options.Name, networkA);
  assert.equal(options.Internal, true);
  assert.equal(options.Labels['gemix.workspaceId'], workspaceId);
  assert.equal(options.Labels['gemix.ownerPid'], String(process.pid));
});

test('orphan cleanup preserves resources owned by another live process', async () => {
  const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  try {
    assert.equal(_ownedResourceIsOrphan({}), true);
    assert.equal(_ownedResourceIsOrphan({ 'gemix.ownerPid': String(process.pid) }), true);
    assert.equal(_ownedResourceIsOrphan({ 'gemix.ownerPid': String(child.pid) }), false);
  } finally {
    child.kill();
    await exited;
  }
});


test('the sandbox ceiling only ever refuses a container that does not exist yet', () => {
  const cap = constants.SANDBOX_MAX_CONTAINERS;
  const request = (over) => ({ pooled: false, activeCount: over });

  // Below the ceiling every chat is served.
  assert.equal(admitWorkspaceRequest(request(0)), true);
  assert.equal(admitWorkspaceRequest(request(cap - 1)), true);

  // At and past it, a chat with no container of its own is turned away.
  assert.equal(admitWorkspaceRequest(request(cap)), false);
  assert.equal(admitWorkspaceRequest(request(cap + 1)), false);

  // A chat that already holds one keeps it: sessions are never cut in half,
  // and reclaiming a slot does not add to the total.
  assert.equal(admitWorkspaceRequest({ pooled: true, activeCount: cap }), true);

  // Identity cannot bypass the total host ceiling.
  assert.equal(admitWorkspaceRequest({ pooled: false, activeCount: cap, isAdmin: true }), false);
});
