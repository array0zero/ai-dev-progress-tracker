import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { writeFakeGh } from './tests/helpers/fake-gh.js'

// E2E は実 gh を呼ばない。fake gh + 専用 TRACKER_DATA_DIR で `npm start` を起動する。
// この config は runner と各 worker で読み込まれるため、共有パスは runner が env へ確定させ、
// worker は env から読むだけにする (fixtures ファイルの再初期化やロック衝突を避ける)。
if (process.env.E2E_TRACKER_DATA_DIR === undefined) {
  const root = join(tmpdir(), `adpt-e2e-${Date.now()}`)
  const written = writeFakeGh(join(root, 'gh'), { authStatusExitCode: 0, repos: {} })
  process.env.E2E_TRACKER_DATA_DIR = join(root, 'data')
  process.env.E2E_GH_FIXTURES = written.fixturesPath
  process.env.E2E_GH_BIN = written.env.TRACKER_GH_BIN
  process.env.E2E_GH_ARGS = written.env.TRACKER_GH_ARGS
  process.env.E2E_GH_CALLS = written.env.FAKE_GH_CALLS
}

function stringEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4317',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:4317/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...stringEnv(process.env),
      TRACKER_DATA_DIR: process.env.E2E_TRACKER_DATA_DIR ?? '',
      TRACKER_PORT: '4317',
      TRACKER_GH_BIN: process.env.E2E_GH_BIN ?? '',
      TRACKER_GH_ARGS: process.env.E2E_GH_ARGS ?? '',
      FAKE_GH_FIXTURES: process.env.E2E_GH_FIXTURES ?? '',
      FAKE_GH_CALLS: process.env.E2E_GH_CALLS ?? '',
    },
  },
})
