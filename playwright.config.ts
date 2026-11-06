import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  // In CI, the github reporter turns failures into annotations visible on the run page.
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
});
