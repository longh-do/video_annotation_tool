import { defineConfig } from '@playwright/test';
import { E2E_PORT } from './tests/e2e/port.ts';

export default defineConfig({
  testDir: 'tests/e2e',
  reporter: 'list',
  // Video decoding is timing-sensitive: one browser at a time.
  workers: 1,
  timeout: 120_000,
  use: {
    // The installed Google Chrome: it decodes H.264 and supports requestVideoFrameCallback,
    // which frame-accurate marking depends on.
    channel: 'chrome',
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    // Synthetic barcoded recordings, freshly ingested, with no annotations from earlier runs.
    command: 'node tests/e2e/serve.ts',
    url: `http://127.0.0.1:${E2E_PORT}/api/queue`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
