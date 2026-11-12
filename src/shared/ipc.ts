import type { ZodType } from 'zod'

import type {
  Annotation,
  Attachment,
  OrphanAttachment,
  BootstrapInfo,
  DiaryEntry,
  EntryDraft,
  ExportFormat,
  ImportFormat,
  ImportSummary,
  JobDonePayload,
  JobErrorPayload,
  JobProgress,
  MenuCommand,
  MigrationMode,
  MigrationSummary,
  Preferences,
  StorageStats,
  ThemeSource,
  VaultSnapshot
} from './types'
import type { SyncMissingAttachment, SyncStatus, SyncTestResult } from './sync'
import type { ErrorPayload } from './errors'
import {
  ANNOTATION_BODY_MAX_LENGTH,
  entryDraftSchema,
  exportFormatSchema,
  importFormatSchema,
  localDateSchema,
  migrationModeSchema,
  passwordSchema,
  preferencesSchema,
  uuidSchema
} from './schemas'
import { z } from 'zod'

/** 主进程 → 渲染进程事件 */
export const EVENTS = {
  flushRequest: 'app:flush-request',
  vaultLocked: 'vault:locked',
  prefsChanged: 'prefs:changed',
  themeChanged: 'theme:changed',
  menuCommand: 'menu:command',
  jobProgress: 'job:progress',
  jobDone: 'job:done',
  jobError: 'job:error',
  openPackage: 'migration:open-package',
  attachmentsChanged: 'attachments:changed',
  vaultReset: 'vault:reset',
  syncApplied: 'sync:applied'
} as const

export type EventChannel = (typeof EVENTS)[keyof typeof EVENTS]

export interface EventPayloads {
  'app:flush-request': { reason: 'lock' | 'quit' | 'switch'; token: string }
  'vault:locked': { reason: 'manual' | 'screen-lock' | 'suspend' | 'idle' | 'fatal' }
  'prefs:changed': Preferences
  'theme:changed': { theme: ThemeSource; source: 'system' | 'preference' }
  'menu:command': MenuCommand
  'job:progress': JobProgress
  'job:done': JobDonePayload
  'job:error': JobErrorPayload
  'migration:open-package': { path: string }
  'attachments:changed': { missing: number }
  'vault:reset': { status: 'missing' }
  'sync:applied': VaultSnapshot
}

/** 统一 IPC 结果信封：失败也走 resolve，避免渲染进程拿到带堆栈的异常 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorPayload }

export interface IpcContract {
  'app:bootstrap': { req: void; res: BootstrapInfo }
  'app:flushAck': { req: { token: string }; res: void }
  /** 渲染进程有真实用户输入时上报，用于应用内无操作自动锁定 */
  'activity:ping': { req: void; res: void }
  'app:openDiaryDir': { req: void; res: void }
  'shell:openExternal': { req: { url: string }; res: void }
  'system:openPrivacySettings': { req: { target: 'localNetwork' | 'filesAndFolders' }; res: void }
  'app:copyText': { req: { text: string }; res: void }

  'vault:create': { req: { password: string }; res: VaultSnapshot }
  'vault:unlock': { req: { password: string }; res: VaultSnapshot }
  'vault:snapshot': { req: void; res: VaultSnapshot }
  'vault:lock': { req: void; res: void }
  'vault:changePassword': { req: { currentPassword: string; newPassword: string }; res: void }
  'vault:moveDirectory': { req: { targetDir: string }; res: { diaryDir: string } }
  'vault:reset': { req: { password: string }; res: void }
  'vault:restoreKeyBackup': {
    req: { filePath: string; backupPassword: string }
    res: VaultSnapshot
  }

  'entry:save': {
    req: { entry: EntryDraft }
    res: { revision: number; entry: DiaryEntry | null; savedAt: string }
  }

  /** 批注只增不改：没有 update / delete 通道 */
  'annotation:add': {
    req: { date: string; quote: string; tag: string; body: string }
    res: {
      annotation: Annotation
      annotations: Annotation[]
      revision: number
    }
  }

  'attachment:addFromPath': { req: { sourcePath: string }; res: Attachment }
  'attachment:addFromDialog': { req: void; res: Attachment | null }
  'attachment:addBytes': {
    req: { name: string; mime: string; bytes: Uint8Array }
    res: Attachment
  }
  'attachment:saveAs': { req: { id: string }; res: { path: string | null } }
  'attachment:delete': { req: { id: string }; res: void }
  'attachment:cleanup': {
    req: { dryRun: boolean; ids?: string[] }
    res: { count: number; bytes: number; ids: string[] }
  }
  'attachment:orphans': {
    req: void
    res: { items: OrphanAttachment[] }
  }
  'attachment:cancel': { req: { jobId: string }; res: void }

  'prefs:read': { req: void; res: Preferences }
  'prefs:update': { req: Partial<Preferences>; res: Preferences }

  'dialog:pickDirectory': { req: { purpose: string }; res: { path: string | null } }
  'dialog:openFile': {
    req: { purpose: 'import' | 'migration' | 'key'; format?: ImportFormat }
    res: { path: string | null }
  }

  'migration:export': {
    req: { packagePassword: string; packageKey: string }
    res: { path: string | null; summary: MigrationSummary | null }
  }
  'migration:preview': {
    req: { filePath: string; packagePassword: string; packageKey?: string }
    res: { token: string; summary: MigrationSummary }
  }
  'migration:import': {
    req: { token: string; mode: MigrationMode }
    res: { revision: number; entries: number; attachments: number; merged: number }
  }
  'migration:cancel': { req: { jobId: string }; res: void }

  'import:preview': {
    req: { format: ImportFormat; filePath: string }
    res: { token: string; summary: ImportSummary }
  }
  'import:commit': {
    req: { token: string }
    res: { revision: number; summary: ImportSummary }
  }
  'import:cancel': { req: { token: string }; res: void }

  'export:run': {
    req: { format: ExportFormat; includeAttachments?: boolean; html?: string }
    res: { path: string | null }
  }

  'stats:storage': { req: void; res: StorageStats }

  'sync:status': { req: void; res: SyncStatus }
  'sync:configure': {
    req: { repo: string; branch?: string; proxy?: string | null; token?: string }
    res: SyncStatus
  }
  'sync:setEnabled': { req: { enabled: boolean }; res: SyncStatus }
  'sync:test': { req: void; res: SyncTestResult }
  'sync:push': { req: void; res: { commits: number; changed: number } }
  'sync:pull': { req: void; res: { entries: number; annotations: number } }
  'sync:missingAttachments': { req: void; res: SyncMissingAttachment[] }
  'sync:exportKeyBackup': { req: { password: string }; res: { path: string | null } }

  'attachment:exportPackage': {
    req: { packageKey: string; packagePassword: string }
    res: { path: string | null; count: number; bytes: number }
  }
  'attachment:importPackage': {
    req: { packageKey: string; packagePassword: string }
    res: { imported: number; skipped: number; missing: number }
  }
}

export type IpcChannel = keyof IpcContract

type RequestValidators = {
  [K in IpcChannel]?: (payload: unknown) => IpcContract[K]['req']
}

const optionalString = z.string().min(1).max(4096)

/** 主进程侧入参校验：每个 channel 一个 Zod 解析器 */
export const requestValidators: RequestValidators = {
  'app:flushAck': (payload) =>
    z.object({ token: z.string().min(1).max(64) }).parse(payload) as IpcContract['app:flushAck']['req'],
  'vault:create': (payload) =>
    z.object({ password: passwordSchema }).parse(payload) as IpcContract['vault:create']['req'],
  'vault:unlock': (payload) =>
    z.object({ password: z.string().min(1).max(200) }).parse(payload) as IpcContract['vault:unlock']['req'],
  'vault:changePassword': (payload) =>
    z
      .object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema })
      .parse(payload) as IpcContract['vault:changePassword']['req'],
  'vault:moveDirectory': (payload) =>
    z.object({ targetDir: optionalString }).parse(payload) as IpcContract['vault:moveDirectory']['req'],
  'vault:reset': (payload) =>
    z.object({ password: z.string().min(1).max(200) }).parse(payload) as IpcContract['vault:reset']['req'],
  'vault:restoreKeyBackup': (payload) =>
    z
      .object({
        filePath: optionalString,
        backupPassword: passwordSchema
      })
      .parse(payload) as IpcContract['vault:restoreKeyBackup']['req'],
  'sync:exportKeyBackup': (payload) =>
    z.object({ password: passwordSchema }).parse(payload) as IpcContract['sync:exportKeyBackup']['req'],
  'entry:save': (payload) =>
    z.object({ entry: entryDraftSchema }).parse(payload) as IpcContract['entry:save']['req'],
  'annotation:add': (payload) =>
    z
      .object({
        date: localDateSchema,
        quote: z.string().max(400),
        tag: z.string().max(100),
        body: z.string().min(1).max(ANNOTATION_BODY_MAX_LENGTH)
      })
      .parse(payload) as IpcContract['annotation:add']['req'],
  'attachment:addFromPath': (payload) =>
    z.object({ sourcePath: optionalString }).parse(payload) as IpcContract['attachment:addFromPath']['req'],
  'attachment:addBytes': (payload) =>
    z
      .object({
        name: z.string().min(1).max(255),
        mime: z.string().min(1).max(128),
        bytes: z.instanceof(Uint8Array)
      })
      .parse(payload) as IpcContract['attachment:addBytes']['req'],
  'attachment:saveAs': (payload) =>
    z.object({ id: uuidSchema }).parse(payload) as IpcContract['attachment:saveAs']['req'],
  'attachment:delete': (payload) =>
    z.object({ id: uuidSchema }).parse(payload) as IpcContract['attachment:delete']['req'],
  'attachment:orphans': (payload) =>
    payload as IpcContract['attachment:orphans']['req'],
  'attachment:cleanup': (payload) =>
    z
      .object({ dryRun: z.boolean(), ids: z.array(uuidSchema).optional() })
      .parse(payload) as IpcContract['attachment:cleanup']['req'],
  'attachment:cancel': (payload) =>
    z.object({ jobId: z.string().min(1).max(64) }).parse(payload) as IpcContract['attachment:cancel']['req'],
  'prefs:update': (payload) =>
    preferencesSchema.partial().parse(payload) as IpcContract['prefs:update']['req'],
  'dialog:pickDirectory': (payload) =>
    z.object({ purpose: z.string().max(64) }).parse(payload) as IpcContract['dialog:pickDirectory']['req'],
  'dialog:openFile': (payload) =>
    z
      .object({ purpose: z.enum(['import', 'migration', 'key']), format: importFormatSchema.optional() })
      .parse(payload) as IpcContract['dialog:openFile']['req'],
  'migration:export': (payload) =>
    z
      .object({ packagePassword: passwordSchema, packageKey: z.string().min(20).max(200) })
      .parse(payload) as IpcContract['migration:export']['req'],
  'migration:preview': (payload) =>
    z
      .object({
        filePath: optionalString,
        packagePassword: z.string().min(1).max(200),
        packageKey: z.string().max(200).optional()
      })
      .parse(payload) as IpcContract['migration:preview']['req'],
  'migration:import': (payload) =>
    z
      .object({ token: z.string().min(1), mode: migrationModeSchema })
      .parse(payload) as IpcContract['migration:import']['req'],
  'migration:cancel': (payload) =>
    z.object({ jobId: z.string().min(1).max(64) }).parse(payload) as IpcContract['migration:cancel']['req'],
  'import:preview': (payload) =>
    z
      .object({ format: importFormatSchema, filePath: optionalString })
      .parse(payload) as IpcContract['import:preview']['req'],
  'import:commit': (payload) =>
    z.object({ token: z.string().min(1) }).parse(payload) as IpcContract['import:commit']['req'],
  'import:cancel': (payload) =>
    z.object({ token: z.string().min(1) }).parse(payload) as IpcContract['import:cancel']['req'],
  'export:run': (payload) =>
    z
      .object({
        format: exportFormatSchema,
        includeAttachments: z.boolean().optional(),
        html: z.string().max(80 * 1024 * 1024).optional()
      })
      .parse(payload) as IpcContract['export:run']['req'],
  'shell:openExternal': (payload) =>
    z.object({ url: z.string().url().startsWith('https:') }).parse(payload) as IpcContract['shell:openExternal']['req'],
  'app:copyText': (payload) =>
    z.object({ text: z.string().min(1).max(10_000) }).parse(payload) as IpcContract['app:copyText']['req'],
}

/** 渲染进程可用的桥接 API（由 preload 通过 contextBridge 暴露） */
export interface MiniDiaryApi {
  invoke<K extends IpcChannel>(channel: K, payload: IpcContract[K]['req']): Promise<IpcResult<IpcContract[K]['res']>>
  on<K extends EventChannel>(channel: K, listener: (payload: EventPayloads[K]) => void): () => void
  /** 拖拽文件 → 绝对路径（主进程会再次校验） */
  pathForFile(file: File): string
  platform: string
  version: string
}

/** 供渲染进程使用的类型安全包装：解包 IpcResult，失败时抛 AppError 形状的对象 */
export type Unwrapped<K extends IpcChannel> = IpcContract[K]['res']

export type { ZodType }
