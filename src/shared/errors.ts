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
  | 'PACKAGE_KEY_REQUIRED'
  | 'PACKAGE_VERSION_UNSUPPORTED'
  | 'GIT_NOT_FOUND'
  | 'GIT_AUTH_FAILED'
  | 'GIT_NETWORK'
  | 'GIT_PROXY'
  | 'GIT_DNS'
  | 'SYNC_NOT_CONFIGURED'
  | 'SYNC_DISABLED'
  | 'SYNC_CONFLICT'
  | 'SYNC_BUSY'
  | 'SYNC_VAULT_MISMATCH'
  | 'SYNC_MIRROR_CORRUPT'
  | 'ATTACHMENT_PACKAGE_INVALID'
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
  PACKAGE_KEY_REQUIRED: copy.errors.packageKeyRequired,
  PACKAGE_VERSION_UNSUPPORTED: copy.errors.packageVersionUnsupported,
  GIT_NOT_FOUND: '没有找到系统 git，请先安装 Git 并重新打开应用',
  GIT_AUTH_FAILED: 'Git 认证失败，请检查访问令牌是否有效',
  GIT_NETWORK: '无法连接 Git 仓库，请检查网络或代理',
  GIT_PROXY: '无法连接 Git 代理，请确认代理已开启',
  GIT_DNS: '无法解析仓库域名，请检查网络或 DNS',
  SYNC_NOT_CONFIGURED: '还没有配置 Git 同步仓库',
  SYNC_DISABLED: 'Git 同步已关闭；开启后才会运行 git 或联网',
  SYNC_CONFLICT: '远端有新的同步内容，请先点「拉取」，再点「推送」',
  SYNC_BUSY: '另一个同步任务正在进行，请稍候',
  SYNC_VAULT_MISMATCH: '这个仓库属于另一个日记库，不能直接同步',
  SYNC_MIRROR_CORRUPT: '同步镜像已损坏，请重新拉取或重建镜像',
  ATTACHMENT_PACKAGE_INVALID: '附件包无效或已损坏',
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

