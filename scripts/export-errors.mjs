// Writes <dir>/cli-errors.json, every error code the CLI raises itself, and <dir>/cli-warnings.json,
// every warning it prints, each as [{ "code", "title" }], for the docs' errors page.
// Run it as `npm run export-errors -- <dir>`: that builds dist/ first, which this reads.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LOCAL_ERROR_CODES, LOCAL_WARNING_CODES } from '../dist/errors.js';

const dir = process.argv[2];
if (dir === undefined || dir.trim() === '') {
  process.stderr.write('Usage: npm run export-errors -- <dir>\n');
  process.exit(2);
}
const target = resolve(dir);
mkdirSync(target, { recursive: true });
for (const [name, codes] of [
  ['cli-errors.json', LOCAL_ERROR_CODES],
  ['cli-warnings.json', LOCAL_WARNING_CODES],
]) {
  const file = join(target, name);
  writeFileSync(file, `${JSON.stringify(codes, null, 2)}\n`);
  process.stdout.write(`Wrote ${codes.length} codes to ${file}\n`);
}
