import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:3107',
    headless: true,
  },
  webServer: {
    command: 'node server/src/index.ts',
    url: 'http://127.0.0.1:3107/health',
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: '3107',
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      LOG_DIR: './logs',
    },
  },
});
