import { defineConfig, devices } from '@playwright/test';

const isLinux = process.platform === 'linux';

export default defineConfig({
  testDir: './tests',
  timeout: 30 * 1000,
  expect: { timeout: 5000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 3,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    headless: true,
    actionTimeout: 0,
    trace: 'on-first-retry',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  },
  projects: [
    {
      name: 'Mobile Safari',
      // Linux の場合は Chromium を使う。Mac や Windows では WebKit
      use: {
        ...devices['iPhone 12'],
        browserName: isLinux ? 'chromium' : 'webkit',
      },
    },
    {
      name: 'Google Chrome',
      use: { ...devices['Desktop Chrome'], headless: true },
    },
  ],
});
