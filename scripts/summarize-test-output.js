#!/usr/bin/env node
/**
 * summarize-test-output — collapse a full `pnpm test` log down to its
 * pass/fail summary plus any real failures, so the daily-review workflow can
 * embed test state in the Claude prompt without overflowing the model context.
 *
 * Background: daily-review #308 (2026-06-05) filed an auto-stub because the
 * Claude analysis step died with "Prompt is too long" at +17s. The raw
 * test-results.txt was 6,623 lines / 439 KB (~110k tokens) — dominated by pino
 * log lines and per-test stdout/stderr from *passing* simulated-error tests —
 * and was `cat`-ed wholesale into the prompt. The prompt only needs the test
 * VERDICT (counts + failures), not the firehose. This keeps a few hundred
 * relevant lines; the full log still ships as a CI artifact for debugging.
 *
 * Usage (CLI):  node scripts/summarize-test-output.js test-results.txt
 *               cat test-results.txt | node scripts/summarize-test-output.js
 */

// Strip ANSI escape sequences (colour codes vitest emits) so matching is robust.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

// Lines worth keeping. Matched against the ANSI-stripped, trimmed line.
const KEEP = [
  /^={3,}.*={3,}$/,                       // === SECTION HEADERS ===
  /\bTest Files\b/,                        // vitest "Test Files  N passed"
  /^Tests\b/,                              // vitest "Tests  N passed | M skipped"
  /\bTests\s+\d/,                          //   (with leading indent)
  /\bDuration\b/,                          // vitest "Duration  16.72s"
  /\bFAIL\b/,                              // failing file marker
  /\bfailed\b/,                            // "N failed", "tests failed"
  /^Unit:\s/,                              // workflow status footer
  /\bIntegration:\s/,                      // workflow status footer
  /^[✗×❯⎯]/,                               // failure markers / error rule lines
  /^\s*[✗×]/,                              // indented failure markers
  /AssertionError|Expected:|Received:/,    // assertion failure bodies
];

// Lines to always drop even if they happen to match a KEEP pattern — pino JSON
// logs and per-test stdout/stderr from passing tests are pure noise.
const DROP = [
  /^\{.*"level":\s*\d+.*\}$/,              // pino JSON log line
  /^(stdout|stderr)\s*\|/,                 // vitest per-test stream header
  /Direction multiplier updated/,
  /Failed to execute trade/,
  /Risk check failed|TRADING HALTED|Position check failed/,
  /\[OptimizationScheduler\]/,
  /\[SignalSigmaCache\]/,
  /\[AutoExecutor\]/,
  /treating as failed trial/,             // simulated-failure test stdout (not a real test failure)
];

function summarizeTestOutput(raw, { maxLines = 200 } = {}) {
  if (!raw || typeof raw !== 'string') return '';
  const kept = [];
  let truncated = false;

  for (const original of raw.split('\n')) {
    const line = original.replace(ANSI, '');
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (DROP.some((re) => re.test(trimmed))) continue;
    if (!KEEP.some((re) => re.test(trimmed))) continue;

    if (kept.length >= maxLines) {
      truncated = true;
      break;
    }
    kept.push(line.replace(/\s+$/, ''));
  }

  if (truncated) {
    kept.push(`... [truncated — ${maxLines}-line cap reached; full log in CI artifacts]`);
  }
  return kept.join('\n');
}

module.exports = { summarizeTestOutput };

// CLI entry point.
if (require.main === module) {
  const fs = require('node:fs');
  const file = process.argv[2];
  let raw = '';
  try {
    raw = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  } catch (err) {
    console.error(`summarize-test-output: cannot read input: ${err.message}`);
    process.exit(0); // Fail soft — never block the review on a missing log.
  }
  process.stdout.write(summarizeTestOutput(raw) + '\n');
}
