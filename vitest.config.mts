import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared'), '@worker': resolve('src/worker') },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/worker/**/*.ts', 'src/renderer/lib/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/worker/json.worker.ts'],
      reporter: ['text', 'html'],
    },
  },
});
