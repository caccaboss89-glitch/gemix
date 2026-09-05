async function settleWithDeadline(tasks, timeoutMs) {
  const settled = Promise.allSettled(tasks.map(task => Promise.resolve().then(task)));
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true, results: [] }), timeoutMs);
  });
  try {
    return await Promise.race([
      settled.then(results => ({ timedOut: false, results })),
      deadline
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export { settleWithDeadline };
