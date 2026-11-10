import { timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { AppError } from '@shared/errors'
import { normalizeTags } from '@shared/schemas'
import type {
  Annotation,
  DiaryEntry,
  EntryDraft,
  LocalDate,
  VaultData,
  VaultSnapshot,
  VaultStatus
} from '@shared/types'
import { toLocalDate } from '@shared/date'
import { countEntryWords } from '@shared/words'

import { logger } from '../logger'
import {
  annotationFile,
  annotationKey,
  appendAnnotation,
  buildAnnotation,
  digestOfFile,
  loadAllAnnotations,
  removeAllAnnotations,
  writeAnnotationFile,
  type NewAnnotationInput
} from './annotations'
import { deriveAttachmentKey, deriveSubkey, wipe, type ScryptParams } from './crypto'
import {
  MIGRATION_VAULT_MEMBER,
  SUPPORTED_SCHEMA_VERSION,
  assertSupportedSchema,
  createEnvelope,
  createPackageKeyEnvelope,
  createVaultData,
  openPackageKeyEnvelope,
  type PackageKeyEnvelope,
  openEnvelope,
  parseEnvelope,
  payloadAad,
  rewrapEnvelope,
  sealPayload,
  serializeEnvelope,
  type VaultEnvelope
} from './format'
import {
  atomicWriteFile,
  ensureVaultDirs,
  freeSpaceCheck,
  movePath,
  pathExists,
  removePath,
  vaultPaths,
  type VaultPaths
} from './paths'
import { cleanupStaleArtifacts, deleteRollbackPoint, restoreRollbackPoint, createRollbackPoint } from './rollback'

export interface RepositoryOptions {
  dir: string
  clock?: () => Date
  /** 仅测试使用：降低 KDF 成本 */
  scrypt?: ScryptParams
}

export interface SaveResult {
  revision: number
  entry: DiaryEntry | null
  savedAt: string
}

export interface MergeResult {
  revision: number
  added: number
  merged: number
}

function annotationSignature(record: Annotation): string {
  return [record.date, record.createdAt, record.quote, record.tag, record.body].join('\u0000')
}

function isEmptyDraft(draft: EntryDraft): boolean {
  return (
    draft.title.trim().length === 0 &&
    draft.body.trim().length === 0 &&
    draft.tags.length === 0 &&
    draft.attachments.length === 0
  )
}

/**
 * VaultRepository 是磁盘数据的唯一事实源：
 * - DEK 只活在这个对象里，永不跨 IPC；
 * - 所有写入都经过串行队列 + 原子替换；
 * - 渲染进程拿到的只是明文镜像（VaultSnapshot）。
 */
export class VaultRepository {
  private dir: string
  private readonly clock: () => Date
  private readonly scrypt: ScryptParams | undefined
  private envelope: VaultEnvelope | null = null
  private dek: Buffer | null = null
  private attachmentKey: Buffer | null = null
  private syncKeyCache: Buffer | null = null
  private annotations: Record<string, Annotation[]> | null = null
  private annotationKeyCache: Buffer | null = null
  private data: VaultData | null = null
  private revision = 0
  private writeChain: Promise<void> = Promise.resolve()

  constructor(options: RepositoryOptions) {
    this.dir = path.resolve(options.dir)
    this.clock = options.clock ?? (() => new Date())
    this.scrypt = options.scrypt
  }

  get paths(): VaultPaths {
    return vaultPaths(this.dir)
  }

  get vaultDir(): string {
    return this.dir
  }

  /** 切换日记库目录（偏好变更后重建指向）；未解锁前调用，避免明文跨库 */
  setDir(dir: string): void {
    if (this.isUnlocked) this.lock()
    this.dir = path.resolve(dir)
    this.revision = 0
  }

  get status(): VaultStatus {
    if (this.data) return 'unlocked'
    return 'locked'
  }

  get isUnlocked(): boolean {
    return this.data !== null && this.dek !== null
  }

  get currentRevision(): number {
    return this.revision
  }

  async exists(): Promise<boolean> {
    return pathExists(this.paths.vaultFile)
  }

  /** 状态查询用的轻量探测：只看文件是否存在 */
  async statusOnDisk(): Promise<VaultStatus> {
    if (this.isUnlocked) return 'unlocked'
    return (await this.exists()) ? 'locked' : 'missing'
  }

  /** 附件子系统读取密钥的唯一入口 */
  getAttachmentKey(): Buffer {
    if (!this.attachmentKey) throw new AppError('VAULT_LOCKED')
    return this.attachmentKey
  }

  /** 同步令牌密钥：由 DEK 派生，锁定时不可用 */
  getSyncTokenKey(): Buffer {
    if (!this.dek) throw new AppError('VAULT_LOCKED')
    return deriveSubkey(this.dek, this.envelope?.vaultId ?? '', 'sync-token-v1')
  }

  /** Git 同步镜像的条目密钥；永不跨 IPC */
  getSyncKey(): Buffer {
    if (!this.dek) throw new AppError('VAULT_LOCKED')
    if (!this.syncKeyCache) {
      this.syncKeyCache = deriveSubkey(this.dek, this.envelope?.vaultId ?? '', 'sync-v1')
    }
    return this.syncKeyCache
  }

  /** 生成 .inkatt 的 key.enc，并返回附件 manifest 用的派生密钥 */
  async createAttachmentPackageKey(
    secret: string
  ): Promise<{ keyEnvelope: PackageKeyEnvelope; manifestKey: Buffer }> {
    this.assertUnlocked()
    const envelope = this.envelope
    const dek = this.dek
    if (!envelope || !dek) throw new AppError('VAULT_LOCKED')
    const keyEnvelope = await createPackageKeyEnvelope(envelope, dek, secret)
    return {
      keyEnvelope,
      manifestKey: deriveSubkey(dek, envelope.vaultId, 'inkatt-manifest-v1')
    }
  }

  /** 解开 .inkatt 的 key.enc，校验它属于当前库，返回 manifest 密钥 */
  async openAttachmentPackageKey(keyEnvelope: PackageKeyEnvelope, secret: string): Promise<Buffer> {
    this.assertUnlocked()
    const envelope = this.envelope
    const dek = this.dek
    if (!envelope || !dek) throw new AppError('VAULT_LOCKED')
    if (keyEnvelope.vaultId !== envelope.vaultId) throw new AppError('SYNC_VAULT_MISMATCH')
    const packageDek = await openPackageKeyEnvelope(keyEnvelope, secret)
    try {
      if (packageDek.length !== dek.length || !timingSafeEqual(packageDek, dek)) {
        throw new AppError('WRONG_PASSWORD')
      }
    } finally {
      wipe(packageDek)
    }
    return deriveSubkey(dek, envelope.vaultId, 'inkatt-manifest-v1')
  }

  /** 迁移导入重加密批注时使用的密钥；永不跨 IPC */
  getAnnotationKey(): Buffer {
    if (!this.annotationKeyCache) throw new AppError('VAULT_LOCKED')
    return this.annotationKeyCache
  }

  /** 磁盘上的批注被整体重写后，重新载入内存 */
  async reloadAnnotations(): Promise<void> {
    this.assertUnlocked()
    await this.loadAnnotations()
    this.revision += 1
  }

  getVaultId(): string {
    if (!this.data) throw new AppError('VAULT_LOCKED')
    return this.data.vaultId
  }

  getSnapshot(): VaultSnapshot {
    if (!this.data) throw new AppError('VAULT_LOCKED')
    return {
      schemaVersion: this.data.schemaVersion,
      revision: this.revision,
      vaultId: this.data.vaultId,
      entries: this.data.entries.map((entry) => structuredClone(entry)),
      annotations: structuredClone(this.annotations ?? {})
    }
  }

  /** 同步镜像：只取“今天以前”的条目；今天永远不进入 Git */
  getSyncEntries(today: LocalDate): DiaryEntry[] {
    const data = this.requireData()
    return data.entries
      .filter((entry) => entry.date < today)
      .map((entry) => structuredClone(entry))
      .sort((a, b) => (a.date < b.date ? -1 : 1))
  }

  /** 同步镜像：只取“今天以前”的批注 */
  getSyncAnnotations(today: LocalDate): Record<string, Annotation[]> {
    const result: Record<string, Annotation[]> = {}
    for (const [date, list] of Object.entries(this.annotations ?? {})) {
      if (date >= today) continue
      if (list.length > 0) result[date] = structuredClone(list)
    }
    return result
  }

  /**
   * 把远端镜像合并进本地：
   * - 条目：只接受今天以前；同一日期取 updatedAt 较新的一方（拉取前会检查本地镜像是否干净）
   * - 批注：按内容去重；远端 id 与本地冲突时重排 id
   * - 今天的数据永远不动
   */
  async applySync(
    input: { entries: readonly DiaryEntry[]; annotations: Record<string, Annotation[]> },
    today: LocalDate
  ): Promise<{ entries: number; annotations: number }> {
    this.assertUnlocked()
    const data = this.requireData()
    const annotationKey = this.annotationKeyCache
    if (!annotationKey) throw new AppError('VAULT_LOCKED')
    const now = this.clock().toISOString()

    let entriesChanged = 0
    const byDate = new Map(data.entries.map((entry) => [entry.date, entry]))
    for (const incoming of input.entries) {
      if (!incoming.date || incoming.date >= today) continue
      const current = byDate.get(incoming.date)
      if (!current) {
        byDate.set(incoming.date, structuredClone(incoming))
        entriesChanged += 1
        continue
      }
      if (JSON.stringify(current) === JSON.stringify(incoming)) continue
      if (incoming.updatedAt >= current.updatedAt) {
        byDate.set(incoming.date, structuredClone(incoming))
        entriesChanged += 1
      }
    }
    if (entriesChanged > 0) {
      data.entries = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
    }

    const localAnnotations = this.annotations ?? {}
    const dates = new Set([
      ...Object.keys(localAnnotations).filter((date) => date < today),
      ...Object.keys(input.annotations).filter((date) => date < today)
    ])
    const mergedAnnotations: Record<string, Annotation[]> = { ...localAnnotations }
    let annotationCount = 0
    let annotationSeq = data.annotationSeq ?? this.maxAnnotationSeq()

    for (const date of dates) {
      const local = localAnnotations[date] ?? []
      const incoming = input.annotations[date] ?? []
      if (incoming.length === 0) continue

      const signatures = new Set(local.map(annotationSignature))
      const next = [...local]
      let changed = false
      for (const record of incoming) {
        if (signatures.has(annotationSignature(record))) continue
        signatures.add(annotationSignature(record))
        let id = record.id
        if (next.some((item) => item.id === id)) {
          annotationSeq += 1
          id = `n${annotationSeq}`
        } else {
          annotationSeq = Math.max(annotationSeq, Number(id.slice(1)) || 0)
        }
        next.push({ ...record, id })
        changed = true
        annotationCount += 1
      }
      if (!changed) continue
      next.sort((a, b) => a.createdAt - b.createdAt)
      mergedAnnotations[date] = next
    }

    if (annotationCount > 0) {
      const digests = { ...(data.annotationDigests ?? {}) }
      for (const date of dates) {
        const local = localAnnotations[date] ?? []
        const next = mergedAnnotations[date] ?? []
        if (JSON.stringify(local) === JSON.stringify(next)) continue
        digests[date] = await writeAnnotationFile(this.dir, date, next, annotationKey)
      }
      data.annotationDigests = digests
      data.annotationSeq = annotationSeq
      this.annotations = mergedAnnotations
    }

    if (entriesChanged > 0 || annotationCount > 0) {
      data.updatedAt = now
      await this.persist(data)
      this.revision += 1
    }
    return { entries: entriesChanged, annotations: annotationCount }
  }

  /** 载入（或重新载入）全部批注；发现哈希不符只记录，不阻断解锁 */
  private async loadAnnotations(): Promise<void> {
    if (!this.annotationKeyCache || !this.data) return
    try {
      this.annotations = await loadAllAnnotations(this.dir, this.annotationKeyCache)
    } catch (error) {
      this.annotations = {}
      logger.error('annotation load failed', error)
    }
    const digests = this.data.annotationDigests ?? {}
    for (const [date, expected] of Object.entries(digests)) {
      try {
        const actual = await digestOfFile(annotationFile(this.dir, date))
        if (actual !== expected) {
          logger.warn('annotation file digest mismatch', { date })
        }
      } catch {
        logger.warn('annotation file missing', { date })
      }
    }
  }

  /** 追加一条批注（只增不改）；日期必须是今天或更早 */
  async addAnnotation(
    input: NewAnnotationInput,
    now: Date = this.clock()
  ): Promise<{ annotation: Annotation; annotations: Annotation[] }> {
    this.assertUnlocked()
    const data = this.requireData()
    if (!this.annotationKeyCache) throw new AppError('VAULT_LOCKED')

    const today = toLocalDate(now)
    if (input.date > today) {
      throw new AppError('INVALID_DATE', '未来日期不能加批注')
    }

    const seq = (data.annotationSeq ?? this.maxAnnotationSeq()) + 1
    const annotation = buildAnnotation(input, seq, now)
    const digest = await appendAnnotation(this.dir, this.annotationKeyCache, annotation)

    data.annotationSeq = seq
    data.annotationDigests = { ...(data.annotationDigests ?? {}), [annotation.date]: digest }
    data.updatedAt = now.toISOString()
    await this.persist(data)

    const list = [...(this.annotations?.[annotation.date] ?? []), annotation].sort(
      (a, b) => a.createdAt - b.createdAt
    )
    this.annotations = { ...(this.annotations ?? {}), [annotation.date]: list }
    this.revision += 1
    logger.info('annotation added', { date: annotation.date })
    return { annotation, annotations: list }
  }

  /** 旧库没有 annotationSeq 时，从内存里已有的记录推算 */
  private maxAnnotationSeq(): number {
    let max = 0
    for (const list of Object.values(this.annotations ?? {})) {
      for (const item of list) {
        const value = Number(item.id.slice(1))
        if (Number.isInteger(value) && value > max) max = value
      }
    }
    return max
  }

  getEntry(date: LocalDate): DiaryEntry | null {
    const entry = this.data?.entries.find((item) => item.date === date)
    return entry ? structuredClone(entry) : null
  }

  findAttachment(id: string): { entry: DiaryEntry; attachment: DiaryEntry['attachments'][number] } | null {
    if (!this.data) return null
    for (const entry of this.data.entries) {
      const attachment = entry.attachments.find((item) => item.id === id)
      if (attachment) return { entry, attachment }
    }
    return null
  }

  /** 新建日记库（已存在则拒绝，避免误覆盖） */
  async create(password: string): Promise<VaultSnapshot> {
    if (await this.exists()) throw new AppError('BUSY', '日记库已存在')
    const data = createVaultData(this.clock())
    const { envelope, dek } = await createEnvelope({
      password,
      data,
      ...(this.scrypt ? { scrypt: this.scrypt } : {})
    })
    await ensureVaultDirs(this.paths)
    await atomicWriteFile(this.paths.vaultFile, serializeEnvelope(envelope))

    this.envelope = envelope
    this.dek = dek
    this.attachmentKey = deriveAttachmentKey(dek, data.vaultId)
    this.syncKeyCache = null
    this.annotationKeyCache = annotationKey(dek, data.vaultId)
    this.data = data
    this.annotations = {}
    this.revision = 1
    logger.info('vault created')
    return this.getSnapshot()
  }

  async unlock(password: string): Promise<VaultSnapshot> {
    if (this.isUnlocked) return this.getSnapshot()
    const exists = await this.exists()
    if (!exists) throw new AppError('VAULT_NOT_FOUND')

    const text = await fs.readFile(this.paths.vaultFile, 'utf8').catch(() => {
      throw new AppError('IO_ERROR')
    })
    const envelope = parseEnvelope(text)
    const opened = await openEnvelope(envelope, password)
    assertSupportedSchema(opened.data)

    this.envelope = envelope
    this.dek = opened.dek
    this.attachmentKey = deriveAttachmentKey(opened.dek, envelope.vaultId)
    this.syncKeyCache = null
    this.annotationKeyCache = annotationKey(opened.dek, envelope.vaultId)
    this.data = opened.data
    this.revision += 1
    await this.loadAnnotations()
    logger.info('vault unlocked', { entries: opened.data.entries.length })
    return this.getSnapshot()
  }

  /** 清空内存中的密钥与明文；不触发磁盘写入 */
  lock(): void {
    wipe(this.dek)
    wipe(this.attachmentKey)
    wipe(this.syncKeyCache)
    wipe(this.annotationKeyCache)
    this.dek = null
    this.attachmentKey = null
    this.syncKeyCache = null
    this.annotationKeyCache = null
    this.annotations = null
    this.envelope = null
    this.data = null
    logger.info('vault locked')
  }

  /** 等待写队列排空（锁屏/退出/导出前调用） */
  async flush(): Promise<void> {
    await this.writeChain
  }

  async saveEntry(draft: EntryDraft, now: Date = this.clock()): Promise<SaveResult> {
    this.assertUnlocked()
    const data = this.requireData()
    const timestamp = now.toISOString()
    const tags = normalizeTags(draft.tags)
    const normalized: EntryDraft = {
      date: draft.date,
      title: draft.title.slice(0, 500),
      body: draft.body,
      tags,
      attachments: draft.attachments
    }

    if (isEmptyDraft(normalized)) {
      const index = data.entries.findIndex((entry) => entry.date === normalized.date)
      if (index === -1) {
        return { revision: this.revision, entry: null, savedAt: timestamp }
      }
      data.entries.splice(index, 1)
      data.updatedAt = timestamp
      await this.persist(data)
      this.revision += 1
      return { revision: this.revision, entry: null, savedAt: timestamp }
    }

    const existing = data.entries.find((entry) => entry.date === normalized.date)
    const entry: DiaryEntry = {
      date: normalized.date,
      title: normalized.title,
      body: normalized.body,
      tags: normalized.tags,
      attachments: normalized.attachments,
      wordCount: countEntryWords(normalized.title, normalized.body),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    }

    if (normalized.body.length > 2 * 1024 * 1024) {
      logger.warn('entry body is large; editor may lag', { date: normalized.date })
    }

    if (existing) {
      Object.assign(existing, entry)
    } else {
      data.entries.push(entry)
    }
    data.entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    data.updatedAt = timestamp

    await this.persist(data)
    this.revision += 1
    return { revision: this.revision, entry: structuredClone(entry), savedAt: timestamp }
  }

  /**
   * 合并外部/迁移条目：同一天不覆盖，按固定规则拼接。
   * 返回新增与合并的数量，供界面反馈。
   */
  async upsertEntries(entries: EntryDraft[]): Promise<MergeResult> {
    this.assertUnlocked()
    if (entries.length === 0) return { revision: this.revision, added: 0, merged: 0 }
    const data = this.requireData()
    const now = this.clock().toISOString()
    let added = 0
    let merged = 0

    for (const draft of entries) {
      const tags = normalizeTags(draft.tags)
      const existing = data.entries.find((entry) => entry.date === draft.date)
      if (!existing) {
        data.entries.push({
          date: draft.date,
          title: draft.title,
          body: draft.body,
          tags,
          attachments: draft.attachments,
          wordCount: countEntryWords(draft.title, draft.body),
          createdAt: now,
          updatedAt: now
        })
        added += 1
        continue
      }

      merged += 1
      const titleParts = [existing.title.trim(), draft.title.trim()].filter((part) => part.length > 0)
      const bodyParts = [existing.body.trim(), draft.body.trim()].filter((part) => part.length > 0)
      const nextTitle = [...new Set(titleParts)].join(' | ').slice(0, 500)
      const nextBody = bodyParts.join('\n\n---\n\n')
      const nextTags = normalizeTags([...existing.tags, ...tags])
      const attachmentsById = new Map(existing.attachments.map((item) => [item.id, item]))
      for (const attachment of draft.attachments) attachmentsById.set(attachment.id, attachment)
      existing.title = nextTitle
      existing.body = nextBody
      existing.tags = nextTags
      existing.attachments = [...attachmentsById.values()]
      existing.wordCount = countEntryWords(nextTitle, nextBody)
      existing.updatedAt = now
    }

    data.entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    data.updatedAt = now
    await this.persist(data)
    this.revision += 1
    return { revision: this.revision, added, merged }
  }

  /** 整体替换条目（reset / 迁移 replace 使用） */
  async replaceEntries(entries: EntryDraft[]): Promise<{ revision: number }> {
    this.assertUnlocked()
    const data = this.requireData()
    const now = this.clock().toISOString()
    data.entries = entries
      .map((draft) => ({
        date: draft.date,
        title: draft.title,
        body: draft.body,
        tags: normalizeTags(draft.tags),
        attachments: draft.attachments,
        wordCount: countEntryWords(draft.title, draft.body),
        createdAt: now,
        updatedAt: now
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    data.updatedAt = now
    await this.persist(data)
    this.revision += 1
    return { revision: this.revision }
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    this.assertUnlocked()
    const envelope = this.envelope
    const dek = this.dek
    if (!envelope || !dek) throw new AppError('VAULT_LOCKED')

    // 先验证旧密码（重新解包一次），防止界面层被绕过
    await this.verifyPassword(currentPassword)

    const jobId = `chpwd-${Date.now()}`
    await createRollbackPoint(this.dir, jobId, { attachments: false })
    try {
      const rewrapped = await rewrapEnvelope(
        envelope,
        dek,
        newPassword,
        this.scrypt ?? undefined
      )
      await atomicWriteFile(this.paths.vaultFile, serializeEnvelope(rewrapped))
      this.envelope = rewrapped
      await deleteRollbackPoint(this.dir, jobId)
      logger.info('vault password changed')
    } catch (error) {
      await restoreRollbackPoint(this.dir, jobId).catch(() => undefined)
      await deleteRollbackPoint(this.dir, jobId).catch(() => undefined)
      throw error
    }
  }

  /** 恢复出厂：验密后删除日记库、附件、批注和迁移临时区 */
  async destroy(password: string): Promise<void> {
    this.assertUnlocked()
    await this.verifyPassword(password)
    const dir = this.dir
    this.lock()
    await removePath(this.paths.vaultFile)
    await removePath(this.paths.attachmentsDir)
    await removePath(this.paths.migrationDir)
    await removeAllAnnotations(dir)
    // 只删空目录；自定义目录里如果还有用户文件就保留
    await fs.rmdir(dir).catch(() => undefined)
    this.revision += 1
    logger.info('vault destroyed')
  }

  /** 整目录搬迁（vault + attachments）；失败回滚 */
  async moveDirectory(targetDir: string): Promise<{ diaryDir: string }> {
    const target = path.resolve(targetDir)
    if (target === this.dir) return { diaryDir: this.dir }
    if (await pathExists(path.join(target, 'diary.vault'))) {
      throw new AppError('INVALID_INPUT', '目标目录里已经有日记库')
    }
    await fs.mkdir(target, { recursive: true, mode: 0o700 })
    await freeSpaceCheck(target, 1024 * 1024)

    const from = this.paths
    const to = vaultPaths(target)
    let movedVault = false
    let movedAttachments = false
    try {
      if (await pathExists(from.vaultFile)) {
        await movePath(from.vaultFile, to.vaultFile)
        movedVault = true
      }
      if (await pathExists(from.attachmentsDir)) {
        await movePath(from.attachmentsDir, to.attachmentsDir)
        movedAttachments = true
      }
    } catch (error) {
      if (movedAttachments) await movePath(to.attachmentsDir, from.attachmentsDir).catch(() => undefined)
      if (movedVault) await movePath(to.vaultFile, from.vaultFile).catch(() => undefined)
      throw new AppError('IO_ERROR', '目录迁移失败，已回滚')
    }

    this.dir = target
    await removePath(from.dir).catch(() => undefined)
    logger.info('vault directory moved')
    return { diaryDir: target }
  }

  /** 迁移导出需要：当前信封（含原 payload 密文）+ 明文数据 */
  getEnvelopeForExport(): { envelope: VaultEnvelope; data: VaultData } {
    this.assertUnlocked()
    return { envelope: this.envelope as VaultEnvelope, data: this.requireData() }
  }

  /** 迁移导入需要：用新的 DEK 重建本地库（replace 场景） */
  async adoptVaultFromMigration(options: {
    data: VaultData
    dek: Buffer
    password: string
  }): Promise<void> {
    const now = this.clock().toISOString()
    const data: VaultData = {
      ...options.data,
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      updatedAt: now
    }
    const { envelope, dek } = await createEnvelope({
      password: options.password,
      data,
      ...(this.scrypt ? { scrypt: this.scrypt } : {})
    })
    await ensureVaultDirs(vaultPaths(this.dir))
    await atomicWriteFile(this.paths.vaultFile, serializeEnvelope(envelope))
    this.envelope = envelope
    this.dek = dek
    this.attachmentKey = deriveAttachmentKey(dek, envelope.vaultId)
    this.data = data
    this.revision += 1
  }

  /**
   * 整库替换但保留当前密钥与密码（导入 replace / merge 使用）：
   * 只重新加密 payload，keyWrap 原样复用，所以用户不需要重新设置密码。
   */
  async replaceAllWithCurrentKey(data: VaultData): Promise<void> {
    this.assertUnlocked()
    if (!this.envelope || !this.dek) throw new AppError('VAULT_LOCKED')
    const now = this.clock().toISOString()
    const next: VaultData = {
      ...data,
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      vaultId: this.envelope.vaultId,
      updatedAt: now
    }
    const sealed = sealPayload(this.envelope, this.dek, next)
    await ensureVaultDirs(this.paths)
    await atomicWriteFile(this.paths.vaultFile, serializeEnvelope(sealed))
    this.envelope = sealed
    this.data = next
    this.revision += 1
  }

  /** 仅供主进程内部（迁移重加密附件）使用的 DEK 视图；永不跨 IPC */
  getDek(): Buffer {
    if (!this.dek) throw new AppError('VAULT_LOCKED')
    return this.dek
  }

  async cleanupStale(): Promise<void> {
    await cleanupStaleArtifacts(this.dir)
  }

  /** 迁移包里的 vault.inkv 需要能被独立解析 */
  static parseMigrationVault(text: string): VaultEnvelope {
    return parseEnvelope(text)
  }

  static readonly migrationVaultMember = MIGRATION_VAULT_MEMBER

  static payloadAadFor(vaultId: string): string {
    return payloadAad(vaultId)
  }

  private assertUnlocked(): void {
    if (!this.isUnlocked) throw new AppError('VAULT_LOCKED')
  }

  private requireData(): VaultData {
    if (!this.data) throw new AppError('VAULT_LOCKED')
    return this.data
  }

  private async verifyPassword(password: string): Promise<void> {
    const text = await fs.readFile(this.paths.vaultFile, 'utf8').catch(() => {
      throw new AppError('IO_ERROR')
    })
    const opened = await openEnvelope(parseEnvelope(text), password)
    wipe(opened.dek)
  }

  /** 串行写入队列 + 原子替换，任何时刻磁盘上都是一份完整信封 */
  private async persist(data: VaultData): Promise<void> {
    if (!this.envelope || !this.dek) throw new AppError('VAULT_LOCKED')
    const envelope = this.envelope
    const dek = this.dek
    const plaintext = structuredClone(data)

    const run = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const sealed = sealPayload(envelope, dek, plaintext)
        await ensureVaultDirs(this.paths)
        await atomicWriteFile(this.paths.vaultFile, serializeEnvelope(sealed))
        this.envelope = sealed
      })

    this.writeChain = run.catch((error: unknown) => {
      logger.error('vault write failed', error)
    })
    await run
  }
}
