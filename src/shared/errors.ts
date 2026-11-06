import { copy } from './copy'

export type ErrorCode =
  | 'WRONG_PASSWORD'
  | 'VAULT_NOT_FOUND'
  | 'VAULT_LOCKED'
  | 'VAULT_VERSION_TOO_NEW'
  | 'CORRUPT_VAULT'
  | 'INVALID_INPUT'
  | 'INVALID_DATE'
  | 'NOT_FOUND'
  | 'IO_ERROR'
  | 'PERMISSION_DENIED'
  | 'CANCELLED'
  | 'BUSY'
  | 'NOT_ENOUGH_SPACE'
  | 'UNSUPPORTED'
  | 'UPDATE_UNAVAILABLE'
  | 'UNKNOWN'

const defaultMessages: Record<ErrorCode, string> = {
  WRONG_PASSWORD: copy.errors.wrongPassword,
  VAULT_NOT_FOUND: copy.errors.notFound,
  VAULT_LOCKED: copy.errors.locked,
  VAULT_VERSION_TOO_NEW: copy.errors.vaultVersionTooNew,
  CORRUPT_VAULT: copy.errors.corruptVault,
  INVALID_INPUT: copy.errors.invalidInput,
  INVALID_DATE: '日期不合法',
  NOT_FOUND: '找不到对应的内容',
  IO_ERROR: copy.errors.ioError,
  PERMISSION_DENIED: copy.errors.permission,
  CANCELLED: copy.errors.cancelled,
  BUSY: copy.errors.busy,
  NOT_ENOUGH_SPACE: copy.errors.notEnoughSpace,
  UNSUPPORTED: '不支持的操作',
  UPDATE_UNAVAILABLE: copy.errors.updateUnavailable,
  UNKNOWN: copy.errors.unknown
}

export class AppError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message?: string) {
    super(message ?? defaultMessages[code])
    this.name = 'AppError'
    this.code = code
  }
}

export interface ErrorPayload {
  code: ErrorCode
  message: string
}

/** 把任意异常折叠成可跨 IPC 的安全载荷（不包含堆栈与内部路径） */
export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof Error) {
    return { code: 'UNKNOWN', message: error.message || defaultMessages.UNKNOWN }
  }
  return { code: 'UNKNOWN', message: defaultMessages.UNKNOWN }
}

export function messageForCode(code: ErrorCode): string {
  return defaultMessages[code]
}
