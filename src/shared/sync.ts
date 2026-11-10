import type { AttachmentKind, LocalDate } from './types'

export type SyncTab = 'git' | 'data'

type SyncLastResult = 'ok' | 'error' | null

/** 同步窗口顶部状态；不含 token */
export interface SyncStatus {
  /** 总开关；关闭时不运行 git、不联网 */
  enabled: boolean
  /** 仓库地址已配置 */
  configured: boolean
  /** 本机是否找得到系统 git */
  gitAvailable: boolean
  gitVersion: string | null
  repo: string | null
  branch: string
  proxy: string | null
  /** 钥匙串里是否已有 token */
  tokenSaved: boolean
  /** 本地领先远端的提交数 */
  ahead: number
  /** 远端领先本地的提交数 */
  behind: number
  /** 是否已建立 upstream */
  tracking: boolean
  /** 工作区是否有未提交的镜像改动 */
  dirty: boolean
  lastSyncAt: string | null
  lastResult: SyncLastResult
  /** 上次失败的简短原因（成功时为 null） */
  lastMessage: string | null
}

export interface SyncMissingAttachment {
  id: string
  name: string
  date: LocalDate
  size: number
  kind: AttachmentKind
}

export interface SyncTestResult {
  latencyMs: number
  message: string
}
