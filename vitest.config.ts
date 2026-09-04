import { tmpdir } from 'node:os'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
    env: {
      // temp 配下の fixture repo が、実行機の上位ディレクトリ (home 等) に
      // 偶然 .git があるとその repo の一部と判定されてしまう。
      // git の上方探索を temp で止めて、テストを実行機の構成から独立させる。
      GIT_CEILING_DIRECTORIES: tmpdir(),
    },
  },
})
