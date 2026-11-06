import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { AppError } from '@shared/errors'
import type { MigrationSummary, PortablePreferences, Preferences } from '@shared/types'
import { formatBytes } from '@shared/date'

import type { JobHandle } from '../jobs'
import { logger } from '../logger'
import type { AttachmentStore } from '../attachments/store'
import { ZipWriter } from '../core/zip'
import type { ScryptParams } from '../vault/crypto'
import { rewrapEnvelope } from '../vault/format'
import { freeSpaceCheck, vaultPaths } from '../vault/paths'
import type { VaultRepository } from '../vault/repository'
import { composePackageSecret } from '@shared/packageKey'

import { attachmentMember, PACKAGE_FORMAT, PACKAGE_MEMBER, formatChecksums } from './package'

export interface MigrationExportDeps {
  repository: VaultRepository
  store: AttachmentStore
  appVersion: string
  /** 仅测试使用 */
  scrypt?: ScryptParams
}

export interface MigrationExportOptions {
  targetPath: string
  /** 用户自定的"私钥" */
  packagePassword: string
  /** 应用生成、只交给用户保存的"公钥" */
  packageKey: string
  preferences: Preferences
  job: JobHandle
}

function portablePrefs(prefs: Preferences): PortablePreferences {
  return {
    theme: prefs.theme,
    hideTitle: prefs.hideTitle,
    allowFutureEntries: prefs.allowFutureEntries,
    autoLockMinutes: prefs.autoLockMinutes
  }
}

/**
 * 导出整库（第 8.3 节）：
 * - 附件密文原样复制，不解密、不压缩、不重新加密；
 * - 只重包 DEK（迁移包密码），payload 密文保持不变；
 * - 先写 `.part`，校验后 rename，失败即删除。
 */
export async function exportMigrationPackage(
  deps: MigrationExportDeps,
  options: MigrationExportOptions
): Promise<{ path: string; summary: MigrationSummary }> {
  const { repository, store, appVersion } = deps
  const { job } = options

  await repository.flush()
  const { envelope, data } = repository.getEnvelopeForExport()
  const dek = repository.getDek()

  const attachmentFiles = await store.listFiles()
  const referencedIds = new Set(data.entries.flatMap((entry) => entry.attachments.map((item) => item.id)))
  const onDisk = new Set(attachmentFiles.map((file) => path.basename(file, '.mdat')))
  const missing = [...referencedIds].filter((id) => !onDisk.has(id))
  if (missing.length > 0) {
    throw new AppError('NOT_FOUND', `有 ${missing.length} 个附件文件缺失，导出已中止`)
  }

  const sizes = new Map<string, number>()
  let totalAttachmentBytes = 0
  for (const file of attachmentFiles) {
    const stats = await fs.stat(path.join(vaultPaths(repository.vaultDir).attachmentsDir, file))
    sizes.set(file, stats.size)
    totalAttachmentBytes += stats.size
  }

  const entries = data.entries
  const firstDate = entries.length > 0 ? entries[0]!.date : null
  const lastDate = entries.length > 0 ? entries[entries.length - 1]!.date : null
  const summary: MigrationSummary = {
    appVersion,
    createdAt: new Date().toISOString(),
    entryCount: entries.length,
    attachmentCount: attachmentFiles.length,
    totalAttachmentBytes,
    firstDate,
    lastDate,
    hasPreferences: true
  }

  await freeSpaceCheck(
    path.dirname(options.targetPath),
    Math.ceil(totalAttachmentBytes * 1.1) + 8 * 1024 * 1024
  )

  const partPath = `${options.targetPath}.part`
  await fs.rm(partPath, { force: true }).catch(() => undefined)

  job.report(0, '准备中…', { bytesDone: 0, bytesTotal: totalAttachmentBytes })

  const writer = new ZipWriter({ filePath: partPath })
  try {
    const manifest = {
      packageFormat: PACKAGE_FORMAT,
      appVersion,
      createdAt: summary.createdAt,
      formatVersion: envelope.formatVersion,
      schemaVersion: data.schemaVersion,
      vaultId: envelope.vaultId,
      entryCount: entries.length,
      attachmentCount: attachmentFiles.length,
      totalAttachmentBytes,
      firstDate,
      lastDate,
      hasPreferences: true
    }
    const manifestText = JSON.stringify(manifest, null, 2)
    writer.addBuffer(PACKAGE_MEMBER.manifest, manifestText)

    // 真正参与 KDF 的是「公钥 + 私钥」组合后的口令
    const secret = composePackageSecret(options.packageKey, options.packagePassword)
    const rewrap = await rewrapEnvelope(envelope, dek, secret, deps.scrypt ?? undefined)
    const vaultText = JSON.stringify(rewrap)
    writer.addBuffer(PACKAGE_MEMBER.vault, vaultText)

    const prefsText = JSON.stringify(portablePrefs(options.preferences), null, 2)
    writer.addBuffer(PACKAGE_MEMBER.prefs, prefsText)

    const checksums: Array<{ member: string; sha256: string }> = [
      { member: PACKAGE_MEMBER.manifest, sha256: createHash('sha256').update(manifestText).digest('hex') },
      { member: PACKAGE_MEMBER.vault, sha256: createHash('sha256').update(vaultText).digest('hex') },
      { member: PACKAGE_MEMBER.prefs, sha256: createHash('sha256').update(prefsText).digest('hex') }
    ]

    const pending: Promise<void>[] = []
    let processed = 0
    for (const file of attachmentFiles) {
      const id = path.basename(file, '.mdat')
      const member = attachmentMember(id)
      const realPath = path.join(vaultPaths(repository.vaultDir).attachmentsDir, file)
      const counter = writer.addFileFromDisk(realPath, member)
      const size = sizes.get(file) ?? 0
      pending.push(
        new Promise<void>((resolve, reject) => {
          counter.stream.once('end', () => {
            checksums.push({ member, sha256: counter.digest() })
            processed += size
            job.report(
              totalAttachmentBytes === 0 ? 0.5 : processed / totalAttachmentBytes,
              `写入附件 ${formatBytes(processed)}`,
              { bytesDone: processed, bytesTotal: totalAttachmentBytes }
            )
            resolve()
          })
          counter.stream.once('error', () => reject(new AppError('IO_ERROR', '读取附件失败')))
        })
      )
      if (job.signal.aborted) throw new AppError('CANCELLED')
    }

    // 校验文件必须是最后一个成员：yazl 顺序读取，附件流全部消费完哈希才齐全
    const checksumsStream = new PassThrough()
    writer.addStream(checksumsStream, PACKAGE_MEMBER.checksums, true)

    job.report(0.98, '写入校验文件…', { bytesDone: processed, bytesTotal: totalAttachmentBytes })
    await Promise.all(pending)
    checksumsStream.end(formatChecksums(checksums))

    const { size } = await writer.finalize()
    await fs.rename(partPath, options.targetPath)
    await fs.chmod(options.targetPath, 0o600).catch(() => undefined)

    job.report(1, '导出完成', { bytesDone: totalAttachmentBytes, bytesTotal: totalAttachmentBytes })
    logger.info('migration package exported', {
      entries: entries.length,
      attachments: attachmentFiles.length,
      bytes: size
    })
    return { path: options.targetPath, summary }
  } catch (error) {
    writer.abort()
    await fs.rm(partPath, { force: true }).catch(() => undefined)
    throw error
  }
}
