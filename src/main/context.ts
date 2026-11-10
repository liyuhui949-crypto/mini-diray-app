import { BrowserWindow, powerMonitor } from 'electron'

import { EVENTS } from '@shared/ipc'
import type { VaultStatus } from '@shared/types'

import { AttachmentProtocol } from './attachments/protocol'
import { AttachmentStore } from './attachments/store'
import { broadcast } from './broadcast'
import { ExternalImporter } from './import'
import { jobs } from './jobs'
import { SyncService } from './sync/service'
import { logger } from './logger'
import { MigrationImporter } from './migration/import'
import { PreferencesStore } from './preferences'
import { VaultRepository } from './vault/repository'
import { setMainWindowLocked } from './window'
import { cleanupStaleArtifacts } from './vault/rollback'

const IDLE_POLL_MS = 15_000

/**
 * 应用级单例：偏好、日记库、附件仓库、迁移与导入服务。
 * 锁定时统一走 `lock()`：中止任务 → 清空明文 → 广播事件。
 */
export class AppContext {
  readonly preferences: PreferencesStore
  readonly repository: VaultRepository
  readonly attachments: AttachmentStore
  readonly attachmentProtocol: AttachmentProtocol
  readonly externalImport: ExternalImporter
  readonly migrationImport: MigrationImporter
  readonly sync: SyncService
  readonly appVersion: string

  private idleTimer: NodeJS.Timeout | null = null
  private readonly flushWaiters = new Map<string, () => void>()
  private locking: Promise<void> | null = null

  constructor(appVersion: string) {
    this.appVersion = appVersion
    this.preferences = new PreferencesStore()
    this.repository = new VaultRepository({ dir: this.preferences.current.diaryDir })
    this.attachments = new AttachmentStore(
      this.preferences.current.diaryDir,
      () => this.repository.getAttachmentKey()
    )
    this.attachmentProtocol = new AttachmentProtocol(this.repository, this.attachments)
    this.externalImport = new ExternalImporter(this.repository)
    this.migrationImport = new MigrationImporter({
      repository: this.repository,
      store: this.attachments
    })
    this.sync = new SyncService({
      repository: this.repository,
      preferences: this.preferences
    })
  }

  async init(): Promise<void> {
    await this.preferences.load()
    this.applyDiaryDir(this.preferences.current.diaryDir)
    this.attachmentProtocol.register()
    this.startIdleWatcher()

    powerMonitor.on('lock-screen', () => {
      void this.lock('screen-lock')
    })
    powerMonitor.on('suspend', () => {
      void this.lock('suspend')
    })
  }

  get diaryDir(): string {
    return this.preferences.current.diaryDir
  }

  async vaultStatus(): Promise<VaultStatus> {
    return this.repository.statusOnDisk()
  }

  /** 偏好里的目录变化后重建仓库实例（idle → 不丢数据，因为此时必然未解锁） */
  applyDiaryDir(dir: string): void {
    if (this.repository.vaultDir === dir) {
      this.attachments.setDiaryDir(dir)
      return
    }
    this.repository.setDir(dir)
    this.attachments.setDiaryDir(dir)
    void cleanupStaleArtifacts(dir).catch(() => undefined)
  }

  /** 等渲染进程确认已 flush（带超时，避免锁屏被挂住） */
  waitForFlush(token: string, timeoutMs = 1500): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.flushWaiters.delete(token)
        resolve()
      }, timeoutMs)
      this.flushWaiters.set(token, () => {
        clearTimeout(timer)
        this.flushWaiters.delete(token)
        resolve()
      })
    })
  }

  ackFlush(token: string): void {
    this.flushWaiters.get(token)?.()
  }

  async lock(reason: 'manual' | 'screen-lock' | 'suspend' | 'idle' | 'fatal'): Promise<void> {
    if (!this.repository.isUnlocked) {
      broadcast(EVENTS.vaultLocked, { reason })
      setMainWindowLocked(true)
      return
    }
    if (this.locking) {
      await this.locking
      return
    }
    this.locking = (async () => {
      const token = `flush-${Date.now()}`
      broadcast(EVENTS.flushRequest, { reason: 'lock', token })
      await this.waitForFlush(token)

      jobs.cancelAll()
      this.attachmentProtocol.abortAll()
      await this.repository.flush().catch(() => undefined)
      this.repository.lock()
      broadcast(EVENTS.vaultLocked, { reason })
      setMainWindowLocked(true)
      logger.info('vault locked', { reason })
    })().finally(() => {
      this.locking = null
    })
    await this.locking
  }

  /** 锁屏/挂起时也要求渲染进程先 flush，避免丢掉最后 800ms 的输入 */
  async flushForQuit(): Promise<void> {
    if (!this.repository.isUnlocked) return
    const token = `flush-${Date.now()}`
    broadcast(EVENTS.flushRequest, { reason: 'quit', token })
    await this.waitForFlush(token, 2500)
    jobs.cancelAll()
    await this.repository.flush().catch(() => undefined)
  }

  mainWindow(): BrowserWindow | null {
    const [window] = BrowserWindow.getAllWindows()
    return window ?? null
  }

  private startIdleWatcher(): void {
    if (this.idleTimer) return
    this.idleTimer = setInterval(() => {
      const minutes = this.preferences.current.autoLockMinutes
      if (!minutes || !this.repository.isUnlocked) return
      const idleSeconds = powerMonitor.getSystemIdleTime()
      if (idleSeconds >= minutes * 60) {
        void this.lock('idle')
      }
    }, IDLE_POLL_MS)
    this.idleTimer.unref?.()
  }

  dispose(): void {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
  }
}
