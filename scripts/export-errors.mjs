// Writes, for the docs' errors page, each as a JSON array:
// - <dir>/cli-errors.json: every error code the CLI raises itself, [{ "code", "title" }];
// - <dir>/cli-warnings.json: every warning it prints, [{ "code", "title" }];
// - <dir>/cli-api-codes.json: every code the API answers with, and the exit code the CLI gives it,
//   [{ "code", "status", "title", "exit_code" }].
// Run it as `npm run export-errors -- <dir>`: that builds dist/ first, which this reads.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { API_ERROR_CODES, LOCAL_ERROR_CODES, LOCAL_WARNING_CODES, apiExitCode } from '../dist/errors.js';

const dir = process.argv[2];
if (dir === undefined || dir.trim() === '') {
  process.stderr.write('Usage: npm run export-errors -- <dir>\n');
  process.exit(2);
}
const target = resolve(dir);
mkdirSync(target, { recursive: true });
const apiCodes = API_ERROR_CODES.map((entry) => ({ ...entry, exit_code: apiExitCode(entry.status, entry.code) }));
for (const [name, codes] of [
  ['cli-errors.json', LOCAL_ERROR_CODES],
  ['cli-warnings.json', LOCAL_WARNING_CODES],
  ['cli-api-codes.json', apiCodes],
]) {
  const file = join(target, name);
  writeFileSync(file, `${JSON.stringify(codes, null, 2)}\n`);
  process.stdout.write(`Wrote ${codes.length} codes to ${file}\n`);
}
