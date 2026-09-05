import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import constants from '../src/config/constants.js';
import { deleteTaskFile, modifyTaskFile } from '../src/utils/taskStore.js';

test('task deletion waits for an in-flight mutation and removes its result', async (t) => {
  const fileId = `task_store_wipe_${process.pid}_${Date.now()}`;
  const filePath = path.join(constants.TASKS_DIR, `${fileId}.json`);
  t.after(() => { try { fs.unlinkSync(filePath); } catch { /* already absent */ } });
  let releaseMutation;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { releaseMutation = resolve; });
  const mutation = modifyTaskFile(fileId, async () => {
    markStarted();
    await gate;
    return { tasks: [{ id: 'late' }] };
  });

  await started;
  const deletion = deleteTaskFile(fileId);
  releaseMutation();
  await mutation;
  assert.equal(await deletion, true);
  assert.equal(fs.existsSync(filePath), false);
});

test('removing the last task propagates unlink failures other than ENOENT', async () => {
  const fileId = `task_store_unlink_${process.pid}_${Date.now()}`;
  const filePath = path.join(constants.TASKS_DIR, `${fileId}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ tasks: [{ id: 'one' }] }));
  const originalUnlink = fs.promises.unlink;
  fs.promises.unlink = async (target) => {
    if (target === filePath) {
      const err = new Error('blocked');
      err.code = 'EACCES';
      throw err;
    }
    return originalUnlink(target);
  };

  try {
    await assert.rejects(
      modifyTaskFile(fileId, async () => ({ tasks: [] })),
      /Cannot remove empty task file/
    );
    assert.equal(fs.existsSync(filePath), true);
  } finally {
    fs.promises.unlink = originalUnlink;
    try { fs.unlinkSync(filePath); } catch { /* test cleanup */ }
  }
});
