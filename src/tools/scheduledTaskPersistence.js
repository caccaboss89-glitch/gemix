import { modifyTaskFile } from '../utils/taskStore.js';

/** Persist independent task files concurrently, rolling back failures per file. */
async function persistScheduledTaskGroups(pendingWrites, results) {
  await Promise.all([...pendingWrites.entries()].map(async ([fileId, queued]) => {
    try {
      await modifyTaskFile(fileId, async (fileData) => {
        if (fileData && !Array.isArray(fileData.tasks)) {
          throw new Error('Existing task file has an invalid tasks field.');
        }
        const data = fileData || { tasks: [] };
        data.tasks.push(...queued.map(entry => entry.task));
        return data;
      });
    } catch (err) {
      for (const { resultIndex } of queued) {
        results[resultIndex] = {
          success: false,
          error: `Reminder was not saved: ${err.message}`
        };
      }
    }
  }));
}

export { persistScheduledTaskGroups };
