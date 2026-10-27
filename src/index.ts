#!/usr/bin/env node
import { run } from './cli.js';
import { unfinishedKeychainCalls } from './keychain.js';

// A reader that stops early (`chesly whoami | head -1`) is not an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

process.exitCode = await run(process.argv.slice(2));

// A keychain call that timed out can still be running in native code, and Node would wait for it
// before exiting. Leave once stdout and stderr are flushed: process.exit() drops pending pipe writes.
if (unfinishedKeychainCalls() > 0) {
  let streams = 2;
  const flushed = () => {
    if (--streams === 0) process.exit();
  };
  process.stdout.write('', flushed);
  process.stderr.write('', flushed);
}
