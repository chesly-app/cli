import { vi } from 'vitest';
import { run } from '../src/cli.js';
import type { Io } from '../src/output.js';

/**
 * Runs the CLI to its end under fake timers. Reading and writing files is real I/O, so the next timer
 * may not exist yet when the due ones have run: time keeps moving on until the run settles.
 * (Not in helpers.ts: the keychain mock's factory imports that, and this imports the CLI.)
 */
export async function runToEnd(args: readonly string[], io: Io): Promise<number> {
  let settled = false;
  const exit = run(args, io).finally(() => {
    settled = true;
  });
  await vi.waitFor(
    async () => {
      await vi.runAllTimersAsync();
      if (!settled) throw new Error('The command is still running.');
    },
    { timeout: 4_000, interval: 1 },
  );
  return exit;
}
