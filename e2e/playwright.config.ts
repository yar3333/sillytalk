import path from 'path';
import { defineConfig, devices } from '@playwright/test';

// The sillytalk e2e tests. The server is started automatically on port 3211
// (the webServer below) with ISOLATED data folders (SILLYTALK_DATA_DIR) —
// the real chats/characters/users in ~/.config/sillytalk are not touched.
// The working models for the tests come from the real config.json (see
// beforeAll in tests/app.spec.ts), so the backend `npm run build` is needed
// in advance.
const DATA_DIR = path.resolve(__dirname, 'test-data');

export default defineConfig({
  testDir: './tests',
  timeout: 120000,
  expect: { timeout: 30000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  forbidOnly: true,
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: './test-results',
  webServer: {
    command: 'node ../backend/dist/index.js',
    port: 3211,
    timeout: 30000,
    reuseExistingServer: false,
    env: {
      SILLYTALK_DATA_DIR: DATA_DIR,
      SILLYTALK_LISTEN: '127.0.0.1:3211',
    },
  },
  use: {
    baseURL: 'http://localhost:3211',
    trace: 'retain-on-failure',
    video: 'off',
    actionTimeout: 15000,
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
