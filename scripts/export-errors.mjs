// Writes <dir>/cli-errors.json: every error code the CLI raises itself, with its fixed title
// ([{ "code", "title" }]), which the docs' errors page lists beside the API's codes.
// Run it as `npm run export-errors -- <dir>`: that builds dist/ first, which this reads.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LOCAL_ERROR_CODES } from '../dist/errors.js';

const dir = process.argv[2];
if (dir === undefined || dir.trim() === '') {
  process.stderr.write('Usage: npm run export-errors -- <dir>\n');
  process.exit(2);
}
const target = resolve(dir);
mkdirSync(target, { recursive: true });
const file = join(target, 'cli-errors.json');
writeFileSync(file, `${JSON.stringify(LOCAL_ERROR_CODES, null, 2)}\n`);
process.stdout.write(`Wrote ${LOCAL_ERROR_CODES.length} codes to ${file}\n`);
