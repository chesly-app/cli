#!/usr/bin/env node
import { run } from './cli.js';

// A reader that stops early (`chesly whoami | head -1`) is not an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

process.exitCode = await run(process.argv.slice(2));
