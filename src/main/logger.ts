import log from 'electron-log/main'

import { AppError } from '@shared/errors'

/**
 * 日志只记录技术事实：不含密码、密钥、正文、附件内容与文件名。
 * 迁移/加密相关调用一律只传 jobId、数量、字节数。
 */

let initialized = false

export function initLogger(isDev: boolean): void {
  if (initialized) return
  initialized = true
  log.transports.file.level = isDev ? 'debug' : 'info'
  log.transports.console.level = isDev ? 'debug' : 'warn'
  log.transports.file.maxSize = 2 * 1024 * 1024
  log.errorHandler.startCatching({ showDialog: false })
}

function describe(error: unknown): string {
  if (error instanceof AppError) return `${error.code}`
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return 'unknown error'
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    log.debug(message, ...args)
  },
  info(message: string, ...args: unknown[]): void {
    log.info(message, ...args)
  },
  warn(message: string, ...args: unknown[]): void {
    log.warn(message, ...args)
  },
  error(message: string, error?: unknown): void {
    log.error(message, error ? describe(error) : '')
  }
}
