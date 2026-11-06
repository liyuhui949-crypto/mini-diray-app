// electron-log/main 的测试替身：logger.ts 只用到这些接口
const transports = {
  file: { level: 'info', maxSize: 0 },
  console: { level: 'warn' }
}

const logger = {
  transports,
  errorHandler: { startCatching: () => undefined },
  debug: (...args: unknown[]) => void args,
  info: (...args: unknown[]) => void args,
  warn: (...args: unknown[]) => void args,
  error: (...args: unknown[]) => void args
}

export default logger
