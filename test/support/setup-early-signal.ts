// Preload for the CLI process test only. Signal as soon as handlers exist,
// before asynchronous SDK initialization can finish; no production override.
process.on('newListener', (event) => {
  if (event === 'SIGTERM') queueMicrotask(() => process.emit('SIGTERM'));
});
