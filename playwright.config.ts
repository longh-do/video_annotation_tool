import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  reporter: 'list',
  use: {
    // The installed Google Chrome: it decodes H.264 and supports requestVideoFrameCallback,
    // which frame-accurate marking depends on.
    channel: 'chrome',
  },
});
