/**
 * Capture the fill stream from the replay fixture and write it to replay-expected.json.
 * Run: node --experimental-vm-modules capture-snapshot.mjs
 * Or just use the vitest run output to generate via a test helper.
 *
 * This uses direct ESM imports of the compiled TS via tsx.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// We can't easily import TS files from plain mjs without tsx.
// Instead: write a vitest test that writes the snapshot.
console.log('Use vitest to capture: run the generate-snapshot test');
