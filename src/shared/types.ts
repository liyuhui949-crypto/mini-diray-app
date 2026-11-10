/**
 * 领域类型。主进程与渲染进程共享，禁止依赖 Electron / Node / DOM。
 */

/** 本地日历日期，格式固定为 `YYYY-MM-DD`（索引语义，不使用 UTC 日期） */
export type LocalDate = string

export type AttachmentKind = 'image' | 'audio' | 'video' | 'file'

/** 加密附件的元数据；二进制本身永远不经过 IPC */
export interface Attachment {
  /** UUID v4，同时是 `attachment://<id>` 与 `attachments/<uuid>.mdat` 的文件名 */
  id: string
  /** 原始文件名，仅用于展示，绝不参与拼接路径 */
  name: string
  mime: string
  kind: AttachmentKind
  /** 明文字节数 */
  size: number
  /** 明文 SHA-256（十六进制） */
  sha256: string
  /** MDAT 分块大小，默认 1 MiB */
  chunkSize: number
  totalChunks: number
  createdAt: string
}

export interface DiaryEntry {
  /** 唯一键，`YYYY-MM-DD` */
  date: LocalDate
  title: string
  /** Markdown 源码 */
  body: string
  /** 小写、去重、不含 '#' */
  tags: string[]
  attachments: Attachment[]
  /** 由 countWords(title + body) 计算并缓存 */
  wordCount: number
  createdAt: string
  updatedAt: string
}

/** 批注：与正文平行的第二条记录流，只增不改不删 */
export interface Annotation {
  /** 'n' + 库内单调递增序号 */
  id: string
  /** 所属日期，也是文件名 */
  date: LocalDate
  /** '' = 整篇批注（这一天没有正文可引用）；否则 ≤90 字符原文引文 */
  quote: string
  /** 自定义 tag（仅批注作用域），'' 允许 */
  tag: string
  /** 纯文本，不限长度 */
  body: string
  /** 展示用创建时刻 'MM-DD HH:mm' */
  at: string
  /** epoch ms，排序依据 */
  createdAt: number
}

export interface VaultData {
  schemaVersion: number
  vaultId: string
  createdAt: string
  updatedAt: string
  entries: DiaryEntry[]
  /** 已分配的批注序号；旧库没有该字段时从文件里推算 */
  annotationSeq?: number
  /** 每个日期批注文件的 SHA-256，用于发现历史批注被篡改 */
  annotationDigests?: Record<string, string>
}

/** 解锁后返回给渲染进程的明文镜像；不含任何密钥 */
export interface VaultSnapshot {
  schemaVersion: number
  revision: number
  vaultId: string
  entries: DiaryEntry[]
  /** 按日期分组的批注 */
  annotations: Record<string, Annotation[]>
}

export type VaultStatus = 'missing' | 'locked' | 'unlocked'

export type ThemeMode = 'system' | 'light' | 'dark'

/** 0 = 关闭空闲自动锁定 */
export type AutoLockMinutes = 0 | 5 | 15 | 30 | 60

export interface Preferences {
  version: 1
  theme: ThemeMode
  hideTitle: boolean
  allowFutureEntries: boolean
  autoLockMinutes: AutoLockMinutes
  /** 当前日记库目录（绝对路径）；仅本机有效，不写入迁移包 */
  diaryDir: string
  lastOpenedDate: LocalDate | null
  lastImportDir: string | null
  lastExportDir: string | null
  sidebarCollapsed?: boolean
  /** 条目列表宽度（px），缺省 312 */
  listWidth?: number
  annotationCollapsed?: boolean
  /** 附件库点击可预览附件时的默认行为：直接看附件，还是看所属日记 */
  attachmentPreviewMode?: 'attachment' | 'entry'
  /** Git 同步仓库地址（HTTPS）；null = 未配置 */
  syncRepo?: string | null
  /** Git 分支，默认 main */
  syncBranch?: string
  /** Git 代理，如 http://127.0.0.1:7890；null = 直连 */
  syncProxy?: string | null
  /** 上次同步成功时间（ISO） */
  syncLastAt?: string | null
  /** 上次同步结果 */
  syncLastResult?: 'ok' | 'error' | null
  /** 上次同步失败的简短原因 */
  syncLastMessage?: string | null
}

/** 迁移包内可移植的偏好子集（不含机器相关字段） */
export type PortablePreferences = Pick<
  Preferences,
  'theme' | 'hideTitle' | 'allowFutureEntries' | 'autoLockMinutes'
>

export type ImportFormat = 'dayOneJson' | 'jrnlJson' | 'miniDiaryJson' | 'dayOneTxt'

export type ExportFormat = 'miniDiaryJson' | 'markdown' | 'pdf' | 'dayOneTxt'

export interface EntryDraft {
  date: LocalDate
  title: string
  body: string
  tags: string[]
  attachments: Attachment[]
}

export interface ImportWarning {
  date?: LocalDate
  message: string
}

export interface ImportSummary {
  format: ImportFormat
  entryCount: number
  mergedCount: number
  newCount: number
  firstDate: LocalDate | null
  lastDate: LocalDate | null
  warnings: ImportWarning[]
}

export interface MigrationSummary {
  appVersion: string
  createdAt: string
  entryCount: number
  attachmentCount: number
  annotationCount?: number
  totalAttachmentBytes: number
  firstDate: LocalDate | null
  lastDate: LocalDate | null
  hasPreferences: boolean
}

export type MigrationMode = 'replace' | 'merge'

export interface JobProgress {
  jobId: string
  kind: 'attachment' | 'migration-export' | 'migration-import' | 'import' | 'export'
  /** 0..1 */
  ratio: number
  /** 当前步骤的人类可读描述 */
  label: string
  bytesDone?: number
  bytesTotal?: number
}

export interface JobDonePayload {
  jobId: string
  kind: JobProgress['kind']
  path?: string
  summary?: unknown
}

export interface JobErrorPayload {
  jobId: string
  kind: JobProgress['kind']
  message: string
}

export type MenuCommand =
  | 'new-entry'
  | 'go-today'
  | 'search'
  | 'open-preferences'
  | 'open-stats'
  | 'import-entry'
  | 'export-entry'
  | 'migration-export'
  | 'migration-import'
  | 'toggle-sidebar'
  | 'insert-attachment'

export type ThemeSource = 'system' | 'light' | 'dark'

export interface BootstrapInfo {
  prefs: Preferences
  vaultStatus: VaultStatus
  /** 实际生效的主题（已解析 system） */
  theme: ThemeSource
  version: string
  platform: string
  dev: boolean
}

/** 未被任何日记引用的遗留附件（没有 entry 元数据，只有 .mdat） */
export interface OrphanAttachment {
  id: string
  size: number
  kind: AttachmentKind
}

export interface StorageStats {
  entryCount: number
  attachmentCount: number
  attachmentBytes: number
  orphanCount: number
  orphanBytes: number
  vaultBytes: number
}
