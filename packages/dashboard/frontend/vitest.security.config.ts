import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/lifecycle.test.mjs'],
    maxWorkers: 2,
    fileParallelism: false,
  },
});
