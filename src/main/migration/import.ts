import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'

import { AppError } from '@shared/errors'
import type { Attachment, DiaryEntry, MigrationSummary, PortablePreferences, VaultData } from '@shared/types'
import { mergeEntryLists, rewriteAttachmentIds } from '@shared/merge'

import type { JobHandle } from '../jobs'
import { logger } from '../logger'
import { parseHeader, totalChunksFor } from '../attachments/format'
import { AttachmentStore } from '../attachments/store'
import { decryptMdatStream } from '../attachments/stream'
import { ZipArchive } from '../core/zip'
import { deriveAttachmentKey, randomUuid, type ScryptParams } from '../vault/crypto'
import { openEnvelope, parseEnvelope, rewrapEnvelope, sealPayload, type VaultEnvelope } from '../vault/format'
import type { VaultRepository } from '../vault/repository'
import {
  PACKAGE_MEMBER,
  attachmentIdFromMember,
  isAllowedPackageMember,
  parseChecksums,
  parseManifest,
  parsePortablePrefs,
  type PackageManifest
} from './package'
import {
  cleanupStaging,
  createStagingDir,
  finalizeSwitch,
  restoreFromRollback,
  switchStagingIntoPlace,
  type StagingPaths
} from './staging'

export interface PackageAttachmentMeta {
  id: string
  member: string
  size: number
  chunkSize: number
  totalChunks: number
  cipherSha256: string | null
}

interface TokenRecord {
  filePath: string
  manifest: PackageManifest
  envelope: VaultEnvelope
  data: VaultData
  packageDek: Buffer
  packageAttachmentKey: Buffer
  prefs: PortablePreferences | null
  attachments: PackageAttachmentMeta[]
  summary: MigrationSummary
}

export interface MigrationImportDeps {
  repository: VaultRepository
  /** 当前库的附件仓库（提供目标 DEK 派生的密钥） */
  store: AttachmentStore
  /** 仅测试使用 */
  scrypt?: ScryptParams
}

export interface MigrateOptions {
  token: string
  mode: 'replace' | 'merge'
  newPassword: string
  job: JobHandle
}

export interface MigrateResult {
  revision: number
  entries: number
  attachments: number
  merged: number
  prefs: PortablePreferences | null
}

function teeHash(stream: NodeJS.ReadableStream): {
  stream: Transform
  digest: () => string
} {
  const hash = createHash('sha256')
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    }
  })
  ;(stream as NodeJS.ReadableStream).pipe(transform)
  return { stream: transform, digest: () => hash.digest('hex') }
}

function expectedMdatBytes(size: number, chunkSize: number): number {
  const chunks = totalChunksFor(size, chunkSize)
  return 64 + size + chunks * 16
}

/**
 * 迁移包导入（第 8.4 节）：
 * preview 只读清单与日记库（校验小成员），不写库；
 * run 在 staging 里完整重建，校验通过后原子切换，失败回滚。
 */
export class MigrationImporter {
  private readonly tokens = new Map<string, TokenRecord>()

  constructor(private readonly deps: MigrationImportDeps) {}

  async preview(filePath: string, packagePassword: string): Promise<{ token: string; summary: MigrationSummary }> {
    const archive = await ZipArchive.open(filePath, {
      allowMember: isAllowedPackageMember
    })
    try {
      for (const required of [PACKAGE_MEMBER.manifest, PACKAGE_MEMBER.vault, PACKAGE_MEMBER.checksums]) {
        if (!archive.has(required)) throw new AppError('INVALID_INPUT', '迁移包缺少必需文件')
      }

      const manifestText = (await archive.readBuffer(PACKAGE_MEMBER.manifest, 4 * 1024 * 1024)).toString('utf8')
      const manifest = parseManifest(manifestText)

      const checksumsText = (await archive.readBuffer(PACKAGE_MEMBER.checksums, 16 * 1024 * 1024)).toString('utf8')
      const checksums = parseChecksums(checksumsText)

      const verifySmall = (member: string, data: Buffer): void => {
        const expected = checksums.get(member)
        if (!expected) return
        const actual = createHash('sha256').update(data).digest('hex')
        if (actual !== expected) throw new AppError('CORRUPT_VAULT', `迁移包成员校验失败：${member}`)
      }

      verifySmall(PACKAGE_MEMBER.manifest, Buffer.from(manifestText, 'utf8'))

      const vaultBuffer = await archive.readBuffer(PACKAGE_MEMBER.vault, 256 * 1024 * 1024)
      verifySmall(PACKAGE_MEMBER.vault, vaultBuffer)

      let prefs: PortablePreferences | null = null
      if (archive.has(PACKAGE_MEMBER.prefs)) {
        const prefsBuffer = await archive.readBuffer(PACKAGE_MEMBER.prefs, 1024 * 1024)
        verifySmall(PACKAGE_MEMBER.prefs, prefsBuffer)
        prefs = parsePortablePrefs(prefsBuffer.toString('utf8'))
      }

      const envelope = parseEnvelope(vaultBuffer.toString('utf8'))
      const opened = await openEnvelope(envelope, packagePassword)

      const attachments: PackageAttachmentMeta[] = []
      for (const member of archive.names()) {
        const id = attachmentIdFromMember(member)
        if (!id) continue
        const stream = await archive.openStream(member)
        try {
          const head = await readPrefix(stream, 64)
          const header = parseHeader(head)
          attachments.push({
            id,
            member,
            size: header.plaintextSize,
            chunkSize: header.chunkSize,
            totalChunks: header.totalChunks,
            cipherSha256: checksums.get(member) ?? null
          })
        } finally {
          stream.resume()
        }
      }

      const entries = opened.data.entries
      const summary: MigrationSummary = {
        appVersion: manifest.appVersion,
        createdAt: manifest.createdAt,
        entryCount: entries.length,
        attachmentCount: attachments.length,
        totalAttachmentBytes: attachments.reduce((sum, item) => sum + item.size, 0),
        firstDate: entries.length > 0 ? entries[0]!.date : manifest.firstDate,
        lastDate: entries.length > 0 ? entries[entries.length - 1]!.date : manifest.lastDate,
        hasPreferences: prefs !== null
      }

      const token = randomUuid()
      this.tokens.set(token, {
        filePath,
        manifest,
        envelope,
        data: opened.data,
        packageDek: opened.dek,
        packageAttachmentKey: deriveAttachmentKey(opened.dek, envelope.vaultId),
        prefs,
        attachments,
        summary
      })
      logger.info('migration package previewed', {
        entries: summary.entryCount,
        attachments: summary.attachmentCount
      })
      return { token, summary }
    } finally {
      archive.close()
    }
  }

  cancel(token: string): void {
    const record = this.tokens.get(token)
    if (!record) return
    this.tokens.delete(token)
    record.packageDek.fill(0)
    record.packageAttachmentKey.fill(0)
  }

  async run(options: MigrateOptions): Promise<MigrateResult> {
    const record = this.tokens.get(options.token)
    if (!record) throw new AppError('NOT_FOUND', '导入会话已过期，请重新选择迁移包')
    this.tokens.delete(options.token)

    const { repository, store } = this.deps
    const job = options.job
    const canKeepTargetKey = repository.isUnlocked
    if (options.mode === 'merge' && !canKeepTargetKey) {
      throw new AppError('VAULT_LOCKED', '合并导入需要先解锁当前日记库')
    }

    // 无库、或锁定状态下整体替换：直接采用包内 DEK，附件密文原样复制（最快路径）
    const adoptPackageKey = !canKeepTargetKey
    const targetKey = adoptPackageKey ? record.packageAttachmentKey : repository.getAttachmentKey()
    void store
    const staging: StagingPaths = await createStagingDir(repository.vaultDir, job.id)
    const stagingStore = new AttachmentStore(staging.root, () => targetKey)

    let switched = false
    let rollbackDir: string | null = null

    try {
      const archive = await ZipArchive.open(record.filePath, { allowMember: isAllowedPackageMember })
      try {
        // 1. 计算新 ID 与条目
        const idMap = new Map<string, string>()
        if (options.mode === 'merge') {
          for (const attachment of record.attachments) {
            idMap.set(attachment.id.toLowerCase(), randomUuid())
          }
        }

        const incomingEntries: DiaryEntry[] = record.data.entries.map((entry) => {
          const attachments: Attachment[] = entry.attachments.map((attachment) => {
            const nextId = idMap.get(attachment.id.toLowerCase())
            return nextId ? { ...attachment, id: nextId } : { ...attachment }
          })
          return {
            ...entry,
            attachments,
            body: rewriteAttachmentIds(entry.body, idMap)
          }
        })

        const targetVaultId = adoptPackageKey
          ? record.envelope.vaultId
          : repository.getVaultId()

        let finalEntries: DiaryEntry[]
        let mergedCount = 0
        if (options.mode === 'merge') {
          const merged = mergeEntryLists(repository.getSnapshot().entries, incomingEntries)
          finalEntries = merged.entries
          mergedCount = merged.stats.merged
        } else {
          finalEntries = incomingEntries
        }

        // 2. 附件：按需原样复制或重新加密
        const totalBytes = record.attachments.reduce((sum, item) => sum + item.size, 0)
        let processed = 0
        for (const attachment of record.attachments) {
          if (job.signal.aborted) throw new AppError('CANCELLED')
          const memberStream = await archive.openStream(attachment.member)
          const hashed = teeHash(memberStream)
          const targetId = idMap.get(attachment.id.toLowerCase()) ?? attachment.id

          if (adoptPackageKey) {
            await stagingStore.importRawFile(targetId, hashed.stream)
            if (attachment.cipherSha256) {
              const digest = hashed.digest()
              if (digest !== attachment.cipherSha256) {
                throw new AppError('CORRUPT_VAULT', '迁移包附件校验失败')
              }
            }
          } else {
            const decrypted = decryptMdatStream(hashed.stream, record.packageAttachmentKey, {
              size: attachment.size,
              chunkSize: attachment.chunkSize,
              totalChunks: attachment.totalChunks
            }, { signal: job.signal })
            const result = await stagingStore.encryptFromReadable({
              id: targetId,
              size: attachment.size,
              // 沿用包内的分块大小：否则元数据与重加密后的文件尺寸会对不上
              chunkSize: attachment.chunkSize,
              source: decrypted,
              signal: job.signal
            })
            const known = incomingEntries
              .flatMap((entry) => entry.attachments)
              .find((item) => item.id === targetId)
            if (known && known.sha256 !== result.sha256) {
              throw new AppError('CORRUPT_VAULT', '迁移包附件明文校验失败')
            }
            if (attachment.cipherSha256) {
              const digest = hashed.digest()
              if (digest !== attachment.cipherSha256) {
                throw new AppError('CORRUPT_VAULT', '迁移包附件校验失败')
              }
            }
          }

          processed += attachment.size
          job.report(totalBytes === 0 ? 0.5 : (processed / totalBytes) * 0.85, '写入附件…', {
            bytesDone: processed,
            bytesTotal: totalBytes
          })
        }

        // 3. 生成 staging 的 diary.vault
        job.report(0.9, '写入日记库…')
        const now = new Date().toISOString()
        const nextData: VaultData = {
          schemaVersion: record.data.schemaVersion,
          vaultId: targetVaultId,
          createdAt: adoptPackageKey ? record.data.createdAt : now,
          updatedAt: now,
          entries: finalEntries
        }

        if (adoptPackageKey) {
          // 附件密文原样复制，所以必须沿用包内 DEK：只换密码，不换密钥
          const rewrapped = await rewrapEnvelope(
            record.envelope,
            record.packageDek,
            options.newPassword,
            this.deps.scrypt ?? undefined
          )
          const sealed = sealPayload(rewrapped, record.packageDek, nextData)
          await fs.writeFile(staging.vaultFile, JSON.stringify(sealed), { mode: 0o600 })
        } else {
          const { envelope } = repository.getEnvelopeForExport()
          const rewrapped = await rewrapEnvelope(
            envelope,
            repository.getDek(),
            options.newPassword,
            this.deps.scrypt ?? undefined
          )
          const sealed = sealPayload(rewrapped, repository.getDek(), nextData)
          await fs.writeFile(staging.vaultFile, JSON.stringify(sealed), { mode: 0o600 })
        }

        // 4. 校验 staging：用新密码重新解开，并抽查附件文件尺寸
        job.report(0.94, '校验导入结果…')
        const stagingText = await fs.readFile(staging.vaultFile, 'utf8')
        const verified = await openEnvelope(parseEnvelope(stagingText), options.newPassword)
        if (verified.data.entries.length !== finalEntries.length) {
          throw new AppError('IO_ERROR', '导入校验失败：条目数量不一致')
        }
        verified.dek.fill(0)

        // staging 里应当正好是「包内每个附件按映射后的 ID」一份。
        // 合并模式下，目标库原有的附件仍留在原目录，不能被算进 staging 校验。
        for (const attachment of record.attachments) {
          const targetId = idMap.get(attachment.id.toLowerCase()) ?? attachment.id
          const stats = await fs
            .stat(path.join(staging.attachmentsDir, `${targetId}.mdat`))
            .catch(() => null)
          if (!stats || stats.size !== expectedMdatBytes(attachment.size, attachment.chunkSize)) {
            throw new AppError('IO_ERROR', '导入校验失败：附件不完整')
          }
        }

        // 5. 原子切换
        job.report(0.97, '切换目录…')
        repository.lock()
        const result = await switchStagingIntoPlace(repository.vaultDir, staging, job.id, options.mode)
        rollbackDir = result.rollbackDir
        switched = true

        try {
          await repository.unlock(options.newPassword)
        } catch (error) {
          if (rollbackDir) await restoreFromRollback(repository.vaultDir, rollbackDir)
          switched = false
          throw error instanceof AppError ? error : new AppError('IO_ERROR', '导入后解锁失败，已回滚')
        }

        if (rollbackDir) await finalizeSwitch(rollbackDir)
        await cleanupStaging(staging)

        job.done({ summary: { entries: finalEntries.length, attachments: record.attachments.length } })
        logger.info('migration package imported', {
          mode: options.mode,
          entries: finalEntries.length,
          attachments: record.attachments.length,
          merged: mergedCount
        })

        return {
          revision: repository.currentRevision,
          entries: finalEntries.length,
          attachments: record.attachments.length,
          merged: mergedCount,
          prefs: options.mode === 'replace' ? record.prefs : null
        }
      } finally {
        archive.close()
      }
    } catch (error) {
      if (switched && rollbackDir) {
        await restoreFromRollback(repository.vaultDir, rollbackDir).catch(() => undefined)
      }
      await cleanupStaging(staging).catch(() => undefined)
      if (error instanceof AppError) {
        logger.warn('migration import failed', { code: error.code, message: error.message })
        job.fail(error.message)
        throw error
      }
      logger.error('migration import failed', error)
      job.fail('导入失败')
      throw new AppError('IO_ERROR', '导入失败')
    } finally {
      record.packageDek.fill(0)
      record.packageAttachmentKey.fill(0)
    }
  }
}

async function readPrefix(stream: NodeJS.ReadableStream, length: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk)
    total += chunk.length
    if (total >= length) break
  }
  return Buffer.concat(chunks).subarray(0, length)
}
