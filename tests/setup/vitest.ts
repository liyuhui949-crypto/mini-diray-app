import { vi } from 'vitest'
import '@testing-library/jest-dom/vitest'

// 单元测试不需要真实日志文件：用一个轻量桩替代 electron-log/main
export const logStub = {
  transports: { file: { level: '', maxSize: 0 }, console: { level: '' } },
  errorHandler: { startCatching: () => undefined },
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}
