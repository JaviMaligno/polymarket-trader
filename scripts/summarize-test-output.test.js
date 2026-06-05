#!/usr/bin/env node
/**
 * Unit tests for summarizeTestOutput — collapses the full `pnpm test` log
 * (6.6k lines / 440 KB of pino noise + per-test stdout/stderr) down to the
 * pass/fail summary + any real failures, so it can be embedded in the
 * daily-review Claude prompt without blowing the model context window.
 *
 * Added 2026-06-05 after daily-review #308 filed an auto-stub: the Claude
 * analysis step died with "Prompt is too long" at +17s — the raw
 * test-results.txt (~110k tokens) was being `cat`-ed wholesale into the prompt.
 */
const assert = require('node:assert/strict');
const { summarizeTestOutput } = require('./summarize-test-output.js');

// Minimal ANSI helpers to mirror vitest's coloured output.
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[39m';

const cases = [
  {
    name: 'preserves the vitest "Test Files ... passed" summary line',
    fn: () => {
      const raw = [
        `${DIM} Test Files ${RESET} ${GREEN}102 passed${RESET} | 1 skipped (103)`,
        '{"level":30,"msg":"Direction multiplier updated"}',
      ].join('\n');
      const out = summarizeTestOutput(raw);
      assert.match(out, /Test Files/);
      assert.match(out, /102 passed/);
    },
  },
  {
    name: 'preserves the "Tests ... passed | skipped" line',
    fn: () => {
      const raw = ` Tests  1233 passed | 16 skipped (1249)`;
      assert.match(summarizeTestOutput(raw), /1233 passed/);
    },
  },
  {
    name: 'preserves === section headers ===',
    fn: () => {
      const raw = '=== UNIT TESTS 2026-06-05 11:17 UTC ===\nnoise\n=== INTEGRATION TESTS ===';
      const out = summarizeTestOutput(raw);
      assert.match(out, /=== UNIT TESTS/);
      assert.match(out, /=== INTEGRATION TESTS ===/);
    },
  },
  {
    name: 'drops pino JSON log lines',
    fn: () => {
      const raw = [
        '{"level":30,"time":123,"name":"weighted-average-combiner","msg":"Direction multiplier updated"}',
        ' Tests  5 passed (5)',
      ].join('\n');
      const out = summarizeTestOutput(raw);
      assert.doesNotMatch(out, /Direction multiplier updated/);
      assert.match(out, /5 passed/);
    },
  },
  {
    name: 'drops per-test stdout/stderr noise lines',
    fn: () => {
      const raw = [
        `${DIM}stdout${RESET} | packages/dashboard/src/services/OptimizationScheduler.test.ts > some test`,
        '[OptimizationScheduler] Trial 1 (id=0): empty params — treating as failed trial',
        '[RiskManager] Risk check failed: Error: connection timeout',
        'Failed to execute trade: TypeError: Cannot read properties of undefined (reading \'id\')',
        ' Test Files  1 passed (1)',
      ].join('\n');
      const out = summarizeTestOutput(raw);
      assert.doesNotMatch(out, /OptimizationScheduler\] Trial/);
      assert.doesNotMatch(out, /Failed to execute trade/);
      assert.doesNotMatch(out, /Risk check failed/);
      assert.match(out, /1 passed/);
    },
  },
  {
    name: 'preserves real failures (FAIL lines and ✗/× markers)',
    fn: () => {
      const raw = [
        ' FAIL  packages/dashboard/src/foo.test.ts > does a thing',
        `   ${DIM}✗${RESET} broken assertion`,
        ' Tests  1 failed | 4 passed (5)',
      ].join('\n');
      const out = summarizeTestOutput(raw);
      assert.match(out, /FAIL/);
      assert.match(out, /1 failed/);
    },
  },
  {
    name: 'preserves the Unit:/Integration: status footer',
    fn: () => {
      const raw = 'noise\nUnit: pass, Integration: pass';
      assert.match(summarizeTestOutput(raw), /Unit: pass, Integration: pass/);
    },
  },
  {
    name: 'collapses a large noisy log to a small summary',
    fn: () => {
      const noise = Array.from({ length: 5000 }, (_, i) =>
        `{"level":30,"time":${i},"msg":"Direction multiplier updated"}`).join('\n');
      const raw = [
        '=== UNIT TESTS ===',
        noise,
        ' Test Files  102 passed | 1 skipped (103)',
        ' Tests  1233 passed | 16 skipped (1249)',
        ' Duration  16.72s',
      ].join('\n');
      const out = summarizeTestOutput(raw);
      // Must shrink by at least 50x and stay well under the line cap.
      assert.ok(out.length < raw.length / 50, `expected big shrink, got ${out.length} vs ${raw.length}`);
      assert.match(out, /102 passed/);
      assert.match(out, /1233 passed/);
    },
  },
  {
    name: 'respects a hard line cap even when many lines match',
    fn: () => {
      const manyFails = Array.from({ length: 500 }, (_, i) => ` FAIL  test-${i}.ts > case`).join('\n');
      const out = summarizeTestOutput(manyFails, { maxLines: 120 });
      const lineCount = out.split('\n').filter(Boolean).length;
      assert.ok(lineCount <= 122, `expected <=122 lines (120 + truncation notice), got ${lineCount}`);
      assert.match(out, /truncat/i);
    },
  },
  {
    name: 'empty / undefined input does not throw',
    fn: () => {
      assert.equal(typeof summarizeTestOutput(''), 'string');
      assert.equal(typeof summarizeTestOutput(undefined), 'string');
    },
  },
];

let failed = 0;
for (const c of cases) {
  try {
    c.fn();
    console.log(`  ✓ ${c.name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${c.name}\n    ${err.message}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${cases.length} tests failed`);
  process.exit(1);
}
console.log(`\n${cases.length}/${cases.length} tests passed`);
