import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  // Shared CI runners occasionally stall a whole VM for a moment, which shows up as one long task.
  // One retry absorbs that; a real regression still fails both attempts. Local runs never retry.
  retries: process.env.CI ? 1 : 0,
  // In CI, the github reporter turns failures into annotations visible on the run page.
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
});
