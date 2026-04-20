import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    // Alias workspace packages to their TypeScript source so Vitest can
    // resolve them without a pre-built dist/ directory.
    alias: {
      '@polymarket-trader/backtest': path.resolve(__dirname, 'packages/backtest/src/index.ts'),
      '@polymarket-trader/signals': path.resolve(__dirname, 'packages/signals/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30000,
    hookTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
    },
    // Reduce parallelism for memory constrained environments
    maxConcurrency: 2,
    // In vitest 4, pool options moved to top-level
    sequence: {
      concurrent: false,
    },
  },
});
