import { defineConfig } from '@playwright/test';

const baseURL = process.env.NORI_E2E_BASE_URL;
if (baseURL === undefined || baseURL === '') throw new Error('NORI_E2E_BASE_URL must point at a running demo');

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: 'test-results',
  workers: 1,
  retries: 0,
  reporter: [['json', { outputFile: 'report.json' }]],
  use: {
    baseURL,
    channel: 'chrome',
    screenshot: 'off',
    trace: { mode: 'on', snapshots: true, screenshots: false, sources: false },
  },
});
