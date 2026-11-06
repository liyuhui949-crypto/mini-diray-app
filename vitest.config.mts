import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer/src'),
      'electron-log/main': resolve(__dirname, 'tests/setup/electron-log-stub.ts')
    }
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx', 'tests/component/**/*.test.tsx'],
    environment: 'node',
    setupFiles: [resolve(__dirname, 'tests/setup/vitest.ts')],
    restoreMocks: true,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/shared/**/*.ts', 'src/main/vault/**/*.ts', 'src/main/attachments/**/*.ts', 'src/main/core/**/*.ts'],
      thresholds: {
        lines: 0,
        functions: 0
      }
    }
  }
})
